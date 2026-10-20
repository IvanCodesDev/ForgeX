using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using ForgeX.Domain;

namespace ForgeX.Simulation;

/// <summary>Bounded geometry inspection; never repairs a mesh or claims a physical volume measurement.</summary>
public sealed partial class MeshAnalyzer
{
    public const int MaxBytes = 64 * 1024 * 1024;
    public const int MaxTriangles = 250_000;
    internal const int MaxXmlBytes = 16 * 1024 * 1024;
    private readonly record struct Point(double X, double Y, double Z)
    {
        public static Point operator -(Point a, Point b) => new(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public Point Cross(Point b) => new(Y * b.Z - Z * b.Y, Z * b.X - X * b.Z, X * b.Y - Y * b.X);
        public double Dot(Point b) => X * b.X + Y * b.Y + Z * b.Z;
    }
    private readonly record struct Triangle(Point A, Point B, Point C);

    private static MeshAnalysisException Invalid(string message) => new("mesh_invalid", message);
    private static MeshAnalysisException Limit(string message) => new("mesh_limit", message, true);

    public async Task<MeshAnalysisResult> AnalyzeAsync(Stream source, string format, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[64 * 1024];
        while (true)
        {
            var read = await source.ReadAsync(chunk, ct);
            if (read == 0) break;
            if (buffer.Length + read > MaxBytes) throw Limit("网格文件超过 64 MB");
            await buffer.WriteAsync(chunk.AsMemory(0, read), ct);
        }
        if (buffer.Length == 0) throw Invalid("网格文件为空");
        if (!buffer.TryGetBuffer(out var bytes) || bytes.Array is null) throw new InvalidOperationException("Mesh buffer is unavailable.");
        // Keep one upload buffer instead of copying another complete 64 MiB array.
        return await Task.Run(() => Analyze(bytes.Array, bytes.Count, format, ct), ct);
    }

    private static MeshAnalysisResult Analyze(byte[] bytes, int length, string format, CancellationToken ct)
    {
        var triangles = new List<Triangle>();
        var warnings = new List<string>();
        string? unit = null;
        var objects = 1;
        if (format == "3mf")
        {
            (unit, objects) = Read3mf(bytes, length, triangles, ct);
            warnings.Add("仅解析 3MF 核心几何、Production 分件引用、单位与构建变换；颜色、材料和切片参数不参与本次校验。");
        }
        else if (format == "stl")
        {
            format = ReadStl(bytes, length, triangles, ct);
            warnings.Add("STL 没有单位声明，本次按毫米解释；请核对原始模型单位。");
        }
        else throw Invalid("仅支持 STL 与 3MF");
        ct.ThrowIfCancellationRequested();
        return Summarize(bytes, length, format, unit, objects, triangles, warnings, ct);
    }

    private static void AddTriangle(List<Triangle> triangles, Point a, Point b, Point c)
    {
        if (triangles.Count >= MaxTriangles) throw Limit("权威解析最多支持 250000 个三角面，请先精简模型");
        foreach (var p in new[] { a, b, c })
            if (!double.IsFinite(p.X) || !double.IsFinite(p.Y) || !double.IsFinite(p.Z) ||
                Math.Max(Math.Abs(p.X), Math.Max(Math.Abs(p.Y), Math.Abs(p.Z))) > 1_000_000)
                throw Invalid("顶点坐标必须为有限值且在 ±1000000 mm 范围内");
        triangles.Add(new Triangle(a, b, c));
    }

    private static string ReadStl(byte[] bytes, int length, List<Triangle> triangles, CancellationToken ct)
    {
        var count = length >= 84 ? BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(80)) : 0;
        var binary = length >= 84 && 84L + 50L * count == length;
        var header = Encoding.UTF8.GetString(bytes, 0, Math.Min(length, 512)).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if (binary || !header.StartsWith("solid", StringComparison.OrdinalIgnoreCase))
        {
            if (length < 84 || 84L + 50L * count != length) throw Invalid("二进制 STL 三角面数量与文件长度不一致");
            if (count > MaxTriangles) throw Limit("权威解析最多支持 250000 个三角面，请先精简模型");
            for (var i = 0; i < count; i++)
            {
                if (i % 1024 == 0) ct.ThrowIfCancellationRequested();
                var offset = 84 + i * 50 + 12;
                Point Read(int n) => new(
                    BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(offset + n * 12)),
                    BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(offset + n * 12 + 4)),
                    BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(offset + n * 12 + 8)));
                AddTriangle(triangles, Read(0), Read(1), Read(2));
            }
            return "stl-binary";
        }
        using var reader = new StringReader(new UTF8Encoding(false, true).GetString(bytes, 0, length).TrimStart('\uFEFF'));
        var vertices = new List<Point>(3);
        var facet = false;
        var loop = false;
        var endedLoop = false;
        var endedSolid = false;
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            ct.ThrowIfCancellationRequested();
            var text = WhiteSpace().Replace(line.Trim(), " ");
            if (text.Length == 0) continue;
            if (text.StartsWith("solid", StringComparison.OrdinalIgnoreCase) && !facet) { endedSolid = false; continue; }
            if (text.StartsWith("endsolid", StringComparison.OrdinalIgnoreCase) && !facet) { endedSolid = true; continue; }
            if (endedSolid) throw Invalid("ASCII STL 结束标记后包含无效记录");
            if (text.StartsWith("facet normal ", StringComparison.OrdinalIgnoreCase) && !facet)
            { facet = true; endedLoop = false; vertices.Clear(); continue; }
            if (text.Equals("outer loop", StringComparison.OrdinalIgnoreCase) && facet && !loop && !endedLoop)
            { loop = true; continue; }
            if (text.StartsWith("vertex ", StringComparison.OrdinalIgnoreCase) && loop)
            {
                var parts = WhiteSpace().Split(text);
                if (parts.Length != 4 || vertices.Count >= 3) throw Invalid("ASCII STL facet 必须恰好包含三个顶点");
                vertices.Add(new Point(Number(parts[1]), Number(parts[2]), Number(parts[3])));
                continue;
            }
            if (text.Equals("endloop", StringComparison.OrdinalIgnoreCase) && loop && vertices.Count == 3)
            { loop = false; endedLoop = true; continue; }
            if (text.Equals("endfacet", StringComparison.OrdinalIgnoreCase) && facet && !loop && endedLoop)
            { AddTriangle(triangles, vertices[0], vertices[1], vertices[2]); facet = false; continue; }
            throw Invalid("ASCII STL 结构不完整或包含无法识别的记录");
        }
        if (facet || loop || !endedSolid) throw Invalid("ASCII STL 缺少完整结束标记");
        return "stl-ascii";
    }

    private static double Number(string? value)
    {
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number))
            throw Invalid("网格数值无效");
        return number;
    }

    private static MeshAnalysisResult Summarize(byte[] bytes, int length, string format, string? unit, int objects,
        List<Triangle> triangles, List<string> warnings, CancellationToken ct)
    {
        var valid = triangles.Where(t => (t.B - t.A).Cross(t.C - t.A).Dot((t.B - t.A).Cross(t.C - t.A)) >= 1e-16).ToList();
        if (valid.Count == 0) throw Invalid("网格中没有有效三角形");
        var dropped = triangles.Count - valid.Count;
        if (dropped > 0) warnings.Add($"已丢弃 {dropped} 个零面积三角面。");
        var min = new Point(double.MaxValue, double.MaxValue, double.MaxValue);
        var max = new Point(double.MinValue, double.MinValue, double.MinValue);
        var area = 0d;
        // Translate to a nearby reference to avoid catastrophic cancellation for offset models.
        var origin = valid[0].A;
        var volume = 0d;
        Span<Point> points = stackalloc Point[3];
        for (var i = 0; i < valid.Count; i++)
        {
            if (i % 1024 == 0) ct.ThrowIfCancellationRequested();
            var t = valid[i];
            var a = t.A - origin; var b = t.B - origin; var c = t.C - origin;
            var cross = (b - a).Cross(c - a);
            area += Math.Sqrt(cross.Dot(cross)) / 2;
            volume += a.Dot(b.Cross(c)) / 6;
            points[0] = t.A; points[1] = t.B; points[2] = t.C;
            for (var k = 0; k < 3; k++)
            {
                var p = points[k];
                min = new Point(Math.Min(min.X, p.X), Math.Min(min.Y, p.Y), Math.Min(min.Z, p.Z));
                max = new Point(Math.Max(max.X, p.X), Math.Max(max.Y, p.Y), Math.Max(max.Z, p.Z));
            }
        }
        var topology = InspectTopology(valid, ct);
        var canMeasureVolume = topology.ClosedEdgeManifold && topology.OrientationConsistent && topology.VertexManifold && topology.ConnectedComponents == 1 && objects == 1;
        if (!topology.ClosedEdgeManifold || !topology.OrientationConsistent) warnings.Add("网格未通过闭合边或朝向一致性检查，不提供体积数值。");
        if (!topology.VertexManifold) warnings.Add($"检测到 {topology.NonManifoldVertices} 个非流形顶点，顶点周围曲面连接异常，不提供体积数值。");
        if (topology.ConnectedComponents > 1) warnings.Add($"网格包含 {topology.ConnectedComponents} 个面连通分量，未判定壳体包含关系或执行布尔并集，不提供体积数值。");
        if (objects > 1) warnings.Add("多对象未执行布尔并集，不提供聚合体积；表面积为逐三角面累加，可能包含内部面。");
        if (volume < 0) warnings.Add(canMeasureVolume ? "网格整体有向体积为负；体积按绝对值展示，请检查面朝向。" : "网格整体有向体积为负；本次不提供体积数值，请检查面朝向。");
        warnings.Add("已检查边邻接、顶点局部连通性与面连通分量；仅焊接坐标完全相同的顶点，未检查自相交或组件重叠；体积为几何估算，不是实测材料体积。");
        return new MeshAnalysisResult("1.1", "forgex-mesh-csharp", "1.2.0",
            Convert.ToHexStringLower(SHA256.HashData(bytes.AsSpan(0, length))), length, format, unit,
            valid.Count, dropped, objects, new MeshSize(max.X - min.X, max.Y - min.Y, max.Z - min.Z),
            canMeasureVolume ? Math.Abs(volume) / 1000 : null, area / 100, topology, warnings);
    }

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhiteSpace();
}
