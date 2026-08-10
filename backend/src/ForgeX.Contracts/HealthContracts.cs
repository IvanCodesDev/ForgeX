namespace ForgeX.Contracts;

public sealed record HealthResponse(
    string Status,
    string Service,
    string Version,
    DateTimeOffset TimestampUtc,
    IReadOnlyDictionary<string, string>? Checks = null);

public sealed record LegacyHealthResponse(
    bool Ok,
    string Engine,
    string Provider,
    LegacyCapabilities Capabilities,
    string CapabilityScope,
    long Now);

public sealed record LegacyCapabilities(
    bool Ai,
    bool GCodeAnalysis,
    bool Streaming,
    bool StructuredOutput);
