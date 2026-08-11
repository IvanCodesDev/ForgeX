namespace ForgeX.Domain;

public enum GCodeJobStatus
{
    Queued,
    Running,
    Succeeded,
    Degraded,
    Failed,
    Cancelled,
}

public sealed record GCodeJobEvent(
    long Sequence,
    string Type,
    DateTimeOffset AtUtc,
    GCodeJobStatus Status,
    double Progress,
    string Phase,
    string? ErrorCode = null);

public sealed record GCodeJobRecord(
    string Id,
    string? IdempotencyKey,
    string Fingerprint,
    string InputSha256,
    long InputBytes,
    GCodeAnalysisOptions Options,
    GCodeJobStatus Status,
    double Progress,
    string Phase,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? StartedAtUtc,
    DateTimeOffset? FinishedAtUtc,
    string? EngineVersion,
    GCodeAnalysisResult? Result,
    string? ErrorCode,
    string? ErrorMessage,
    string? TraceId,
    IReadOnlyList<GCodeJobEvent> Events,
    string TenantId = "tn_local",
    string OwnerId = "ow_local",
    int AttemptCount = 0,
    int MaxAttempts = 3,
    DateTimeOffset? NextAttemptAtUtc = null,
    DateTimeOffset? DeadLetteredAtUtc = null);
