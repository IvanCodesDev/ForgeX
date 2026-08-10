using ForgeX.Domain;

namespace ForgeX.Application;

/// <summary>Authoritative G-code analysis boundary shared by API and batch workloads.</summary>
public interface IGCodeAnalyzer
{
    Task<GCodeAnalysisResult> AnalyzeAsync(
        Stream gcode,
        GCodeAnalysisOptions options,
        CancellationToken ct);
}
