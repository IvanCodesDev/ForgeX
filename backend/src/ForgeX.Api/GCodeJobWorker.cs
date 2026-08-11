using System.Collections.Concurrent;
using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Api;

internal sealed class GCodeJobWorker(
    IGCodeJobQueue queue,
    IGCodeJobRepository repository,
    IContentObjectStore objects,
    IGCodeAnalyzer analyzer,
    GCodeJobRuntime runtime,
    GCodeJobRetryOptions retryOptions,
    ForgeXMetrics metrics,
    ILogger<GCodeJobWorker> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<string, byte> _scheduled = new(StringComparer.Ordinal);

    public bool Started { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var recovered = await RecoverAsync(stoppingToken);
        Started = true;
        foreach (var jobId in recovered)
        {
            await ProcessAsync(jobId, stoppingToken);
        }
        await foreach (var jobId in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await ProcessAsync(jobId, stoppingToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
            {
                logger.LogError(exception, "Unhandled G-code job worker failure for {JobId}", jobId);
            }
        }
    }

    private async Task<IReadOnlyList<string>> RecoverAsync(CancellationToken cancellationToken)
    {
        var queued = new List<string>();
        foreach (var job in await repository.ListAsync(cancellationToken))
        {
            if (job.Status == GCodeJobStatus.Queued)
            {
                queued.Add(job.Id);
                continue;
            }
            if (job.Status != GCodeJobStatus.Running) continue;

            var now = DateTimeOffset.UtcNow;
            if (job.AttemptCount >= job.MaxAttempts)
            {
                var deadLetter = GCodeJobEndpoints.Append(job with
                {
                    Status = GCodeJobStatus.Failed,
                    Phase = "dead-letter",
                    FinishedAtUtc = now,
                    NextAttemptAtUtc = null,
                    DeadLetteredAtUtc = now,
                    ErrorCode = "gcode_retry_exhausted",
                    ErrorMessage = $"Retry budget exhausted after {job.AttemptCount} attempts. Last error: worker_restarted.",
                }, "terminal", now);
                await repository.SaveAsync(deadLetter, cancellationToken);
                metrics.RecordJobDeadLetter();
                continue;
            }

            var recovered = GCodeJobEndpoints.Append(job with
            {
                Status = GCodeJobStatus.Queued,
                Phase = "recovered",
                FinishedAtUtc = null,
                NextAttemptAtUtc = now,
                ErrorCode = "worker_restarted",
                ErrorMessage = "The worker restarted before this attempt completed; the durable job was requeued.",
            }, "recovery", now);
            await repository.SaveAsync(recovered, cancellationToken);
            metrics.RecordJobRecovery();
            queued.Add(job.Id);
        }

        return queued;
    }

    private async Task ProcessAsync(string jobId, CancellationToken stoppingToken)
    {
        var job = await repository.GetAsync(jobId, stoppingToken);
        if (job is null || job.Status != GCodeJobStatus.Queued) return;
        if (job.NextAttemptAtUtc is { } notBefore && notBefore > DateTimeOffset.UtcNow)
        {
            Schedule(jobId, notBefore, stoppingToken);
            return;
        }

        var now = DateTimeOffset.UtcNow;
        job = GCodeJobEndpoints.Append(job with
        {
            Status = GCodeJobStatus.Running,
            Progress = 0.1,
            Phase = "parse",
            StartedAtUtc = job.StartedAtUtc ?? now,
            FinishedAtUtc = null,
            EngineVersion = ForgeX.Simulation.StreamingGCodeAnalyzer.EngineVersion,
            AttemptCount = job.AttemptCount + 1,
            NextAttemptAtUtc = null,
            ErrorCode = null,
            ErrorMessage = null,
        }, "progress", now);
        await repository.SaveAsync(job, stoppingToken);

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        if (!runtime.Register(jobId, cancellation)) return;
        DateTimeOffset? retryScheduleAtUtc = null;
        try
        {
            await using var stream = await objects.OpenReadAsync(job.InputSha256, cancellation.Token);
            var result = await analyzer.AnalyzeAsync(stream, job.Options, cancellation.Token);
            var latest = await repository.GetAsync(jobId, CancellationToken.None);
            if (latest is null || latest.Status == GCodeJobStatus.Cancelled) return;
            now = DateTimeOffset.UtcNow;
            job = GCodeJobEndpoints.Append(latest with
            {
                Status = GCodeJobStatus.Succeeded,
                Progress = 1,
                Phase = "complete",
                FinishedAtUtc = now,
                EngineVersion = result.EngineVersion,
                Result = result,
                NextAttemptAtUtc = null,
                ErrorCode = null,
                ErrorMessage = null,
            }, "terminal", now);
            await repository.SaveAsync(job, CancellationToken.None);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            var latest = await repository.GetAsync(jobId, CancellationToken.None);
            if (latest is null || latest.Status == GCodeJobStatus.Cancelled) return;
            now = DateTimeOffset.UtcNow;
            job = GCodeJobEndpoints.Append(latest with
            {
                Status = GCodeJobStatus.Cancelled,
                Phase = "cancelled",
                FinishedAtUtc = now,
                NextAttemptAtUtc = null,
                ErrorCode = "gcode_cancelled",
                ErrorMessage = "The analysis job was cancelled.",
            }, "terminal", now);
            await repository.SaveAsync(job, CancellationToken.None);
        }
        catch (Exception exception)
        {
            var failure = GCodeJobResilience.Classify(exception);
            var latest = await repository.GetAsync(jobId, CancellationToken.None) ?? job;
            if (latest.Status == GCodeJobStatus.Cancelled) return;
            now = DateTimeOffset.UtcNow;
            if (GCodeJobResilience.CanRetry(latest, failure))
            {
                var nextAttemptAtUtc = GCodeJobResilience.NextAttemptAtUtc(latest, now, retryOptions);
                job = GCodeJobEndpoints.Append(latest with
                {
                    Status = GCodeJobStatus.Queued,
                    Phase = "retry-wait",
                    FinishedAtUtc = null,
                    NextAttemptAtUtc = nextAttemptAtUtc,
                    ErrorCode = failure.Code,
                    ErrorMessage = failure.Message,
                }, "retry", now);
                await repository.SaveAsync(job, CancellationToken.None);
                metrics.RecordJobRetry();
                logger.LogWarning(
                    exception,
                    "Transient G-code job failure; retry {NextAttempt}/{MaxAttempts} scheduled for {NextAttemptAtUtc}; jobId={JobId}",
                    latest.AttemptCount + 1,
                    latest.MaxAttempts,
                    nextAttemptAtUtc,
                    jobId);
                retryScheduleAtUtc = nextAttemptAtUtc;
                return;
            }

            var deadLettered = failure.Retryable;
            if (exception is not GCodeAnalysisException || deadLettered)
            {
                logger.LogError(exception, "G-code analysis job {JobId} failed", jobId);
            }
            job = GCodeJobEndpoints.Append(latest with
            {
                Status = GCodeJobStatus.Failed,
                Phase = deadLettered ? "dead-letter" : "failed",
                FinishedAtUtc = now,
                NextAttemptAtUtc = null,
                DeadLetteredAtUtc = deadLettered ? now : null,
                ErrorCode = deadLettered ? "gcode_retry_exhausted" : failure.Code,
                ErrorMessage = deadLettered
                    ? $"Retry budget exhausted after {latest.AttemptCount} attempts. Last error: {failure.Code}."
                    : failure.Message,
            }, "terminal", now);
            await repository.SaveAsync(job, CancellationToken.None);
            if (deadLettered) metrics.RecordJobDeadLetter();
        }
        finally
        {
            runtime.Unregister(jobId);
            if (retryScheduleAtUtc is { } notBeforeUtc) Schedule(jobId, notBeforeUtc, stoppingToken);
        }
    }

    private void Schedule(string jobId, DateTimeOffset notBeforeUtc, CancellationToken stoppingToken)
    {
        if (!_scheduled.TryAdd(jobId, 0)) return;
        _ = ScheduleAsync(jobId, notBeforeUtc, stoppingToken);
    }

    private async Task ScheduleAsync(string jobId, DateTimeOffset notBeforeUtc, CancellationToken stoppingToken)
    {
        var ownsScheduleMarker = true;
        try
        {
            var delay = notBeforeUtc - DateTimeOffset.UtcNow;
            if (delay > TimeSpan.Zero) await Task.Delay(delay, stoppingToken);
            _scheduled.TryRemove(jobId, out _);
            ownsScheduleMarker = false;
            await queue.EnqueueAsync(jobId, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // The queued state is durable and startup recovery will schedule it again.
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Failed to schedule G-code job retry; jobId={JobId}", jobId);
        }
        finally
        {
            if (ownsScheduleMarker) _scheduled.TryRemove(jobId, out _);
        }
    }
}
