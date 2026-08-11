using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Api;

internal sealed class GCodeJobWorker(
    IGCodeJobQueue queue,
    IGCodeJobRepository repository,
    IContentObjectStore objects,
    IGCodeAnalyzer analyzer,
    GCodeJobRuntime runtime,
    ILogger<GCodeJobWorker> logger) : BackgroundService
{
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
            }
            else if (job.Status == GCodeJobStatus.Running)
            {
                var now = DateTimeOffset.UtcNow;
                var failed = GCodeJobEndpoints.Append(job with
                {
                    Status = GCodeJobStatus.Failed,
                    Progress = job.Progress,
                    Phase = "failed",
                    FinishedAtUtc = now,
                    ErrorCode = "worker_restarted",
                    ErrorMessage = "The worker restarted before this job completed.",
                }, "terminal", now);
                await repository.SaveAsync(failed, cancellationToken);
            }
        }

        return queued;
    }

    private async Task ProcessAsync(string jobId, CancellationToken stoppingToken)
    {
        var job = await repository.GetAsync(jobId, stoppingToken);
        if (job is null || job.Status != GCodeJobStatus.Queued) return;

        var now = DateTimeOffset.UtcNow;
        job = GCodeJobEndpoints.Append(job with
        {
            Status = GCodeJobStatus.Running,
            Progress = 0.1,
            Phase = "parse",
            StartedAtUtc = now,
            EngineVersion = ForgeX.Simulation.StreamingGCodeAnalyzer.EngineVersion,
        }, "progress", now);
        await repository.SaveAsync(job, stoppingToken);

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        if (!runtime.Register(jobId, cancellation)) return;
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
                ErrorCode = "gcode_cancelled",
                ErrorMessage = "The analysis job was cancelled.",
            }, "terminal", now);
            await repository.SaveAsync(job, CancellationToken.None);
        }
        catch (Exception exception)
        {
            if (exception is not GCodeAnalysisException)
            {
                logger.LogError(exception, "G-code analysis job {JobId} failed", jobId);
            }
            var latest = await repository.GetAsync(jobId, CancellationToken.None) ?? job;
            now = DateTimeOffset.UtcNow;
            var code = exception is GCodeAnalysisException analysis ? analysis.Code : "analysis_failed";
            var message = exception is GCodeAnalysisException ? exception.Message : "The analysis job failed.";
            job = GCodeJobEndpoints.Append(latest with
            {
                Status = GCodeJobStatus.Failed,
                Phase = "failed",
                FinishedAtUtc = now,
                ErrorCode = code,
                ErrorMessage = message,
            }, "terminal", now);
            await repository.SaveAsync(job, CancellationToken.None);
        }
        finally
        {
            runtime.Unregister(jobId);
        }
    }
}
