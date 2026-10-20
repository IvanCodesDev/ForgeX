using System.Text.Json.Serialization;

namespace ForgeX.Domain;

public sealed record MeshSize(double X, double Y, double Z);
public sealed record MeshTopology(int BoundaryEdges, int NonManifoldEdges, int InconsistentEdges,
    bool ClosedEdgeManifold, bool OrientationConsistent, int NonManifoldVertices,
    bool VertexManifold, int ConnectedComponents, bool SelfIntersectionChecked = false);
public sealed record MeshAnalysisResult(string SchemaVersion, string Engine, string EngineVersion,
    string Sha256, long Bytes, string Format, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Unit, int TriangleCount, int DroppedTriangles,
    int ObjectCount, MeshSize SizeMm, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] double? VolumeCm3, double SurfaceAreaCm2,
    MeshTopology Topology, IReadOnlyList<string> Warnings);

public sealed class MeshAnalysisException(string code, string message, bool limit = false) : Exception(message)
{
    public string Code { get; } = code;
    public bool IsLimit { get; } = limit;
}
