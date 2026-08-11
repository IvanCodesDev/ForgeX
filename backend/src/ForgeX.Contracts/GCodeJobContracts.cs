namespace ForgeX.Contracts;

public sealed record GCodeJobLinksDto(string Status, string Events, string Cancel);

public sealed record GCodeJobAcceptedResponse(
    string SchemaVersion,
    string JobId,
    string Status,
    GCodeInputSummaryDto Input,
    GCodeJobLinksDto Links);

public sealed record GCodeJobErrorDto(string Code, string Message, string? TraceId);

public sealed record GCodeJobSnapshotResponse(
    string SchemaVersion,
    string Id,
    string Kind,
    string Status,
    double Progress,
    string Phase,
    long Sequence,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? StartedAtUtc,
    DateTimeOffset? FinishedAtUtc,
    GCodeInputSummaryDto Input,
    string? EngineVersion,
    GCodeAnalysisResponse? Result,
    GCodeJobErrorDto? Error,
    GCodeJobLinksDto Links);

public sealed record GCodeJobEventDto(
    long Sequence,
    string EventType,
    DateTimeOffset AtUtc,
    string Status,
    double Progress,
    string Phase,
    string? ErrorCode);
