using ForgeX.Domain;

namespace ForgeX.Application;

public sealed record GCodeJobRetryOptions(
    int MaxAttempts = 3,
    int BaseDelayMilliseconds = 250,
    int MaxDelayMilliseconds = 10_000)
{
    public GCodeJobRetryOptions Validate()
    {
        if (MaxAttempts is < 1 or > 10)
        {
            throw new InvalidOperationException("GCodeJobs:Retry:MaxAttempts must be between 1 and 10.");
        }
        if (BaseDelayMilliseconds is < 10 or > 60_000)
        {
            throw new InvalidOperationException("GCodeJobs:Retry:BaseDelayMilliseconds must be between 10 and 60000.");
        }
        if (MaxDelayMilliseconds < BaseDelayMilliseconds || MaxDelayMilliseconds > 300_000)
        {
            throw new InvalidOperationException("GCodeJobs:Retry:MaxDelayMilliseconds must be at least the base delay and no more than 300000.");
        }
        return this;
    }

    public TimeSpan DelayAfterFailure(int completedAttempts)
    {
        var exponent = Math.Clamp(completedAttempts - 1, 0, 30);
        var multiplier = 1L << exponent;
        var delay = Math.Min((long)MaxDelayMilliseconds, BaseDelayMilliseconds * multiplier);
        return TimeSpan.FromMilliseconds(delay);
    }
}

public sealed record GCodeJobFailure(string Code, string Message, bool Retryable);

public static class GCodeJobResilience
{
    public static GCodeJobFailure Classify(Exception exception) => exception switch
    {
        GCodeAnalysisException analysis when analysis.Code == "GCODE_STREAM_READ_FAILED" =>
            new GCodeJobFailure(analysis.Code, analysis.Message, true),
        GCodeAnalysisException analysis =>
            new GCodeJobFailure(analysis.Code, analysis.Message, false),
        IOException =>
            new GCodeJobFailure("gcode_storage_unavailable", "The stored G-code could not be read.", true),
        TimeoutException =>
            new GCodeJobFailure("gcode_analysis_timeout", "The analysis attempt timed out.", true),
        _ =>
            new GCodeJobFailure("analysis_failed", "The analysis attempt failed.", true),
    };

    public static bool CanRetry(GCodeJobRecord job, GCodeJobFailure failure) =>
        failure.Retryable && job.AttemptCount < job.MaxAttempts;

    public static DateTimeOffset NextAttemptAtUtc(
        GCodeJobRecord job,
        DateTimeOffset failedAtUtc,
        GCodeJobRetryOptions options) =>
        failedAtUtc + options.DelayAfterFailure(job.AttemptCount);
}
