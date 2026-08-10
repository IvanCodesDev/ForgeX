namespace ForgeX.Contracts;

/// <summary>
/// Stable RFC 9457-compatible error body used by every ForgeX API failure.
/// </summary>
public sealed record ApiProblem(
    string Type,
    string Title,
    int Status,
    string Code,
    string TraceId,
    string? Detail = null,
    string? Instance = null,
    IReadOnlyDictionary<string, string[]>? Errors = null);
