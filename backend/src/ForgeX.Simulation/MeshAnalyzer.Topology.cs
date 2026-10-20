using ForgeX.Domain;

namespace ForgeX.Simulation;

public sealed partial class MeshAnalyzer
{
    private readonly record struct EdgeUsage(int Count, int Direction, int LowCorner, int HighCorner);

    // Negative root values store set size; union by size and path compression avoid per-vertex mesh scans.
    private sealed class MeshSets
    {
        private readonly int[] _parents;
        public int Count { get; private set; }
        public MeshSets(int size) { _parents = new int[size]; Array.Fill(_parents, -1); Count = size; }
        public bool IsRoot(int index) => _parents[index] < 0;
        private int Find(int index)
        {
            var root = index;
            while (_parents[root] >= 0) root = _parents[root];
            while (index != root) { var next = _parents[index]; _parents[index] = root; index = next; }
            return root;
        }
        public void Union(int a, int b)
        {
            a = Find(a); b = Find(b);
            if (a == b) return;
            if (_parents[a] > _parents[b]) (a, b) = (b, a);
            _parents[a] += _parents[b]; _parents[b] = a; Count--;
        }
    }

    private static MeshTopology InspectTopology(List<Triangle> triangles, CancellationToken ct)
    {
        var vertexIds = new Dictionary<Point, int>();
        var edges = new Dictionary<(int Low, int High), EdgeUsage>();
        var faces = new MeshSets(triangles.Count);
        var corners = new MeshSets(triangles.Count * 3);
        var cornerVertices = new int[triangles.Count * 3];
        Span<Point> points = stackalloc Point[3];
        Span<int> ids = stackalloc int[3];
        for (var i = 0; i < triangles.Count; i++)
        {
            if (i % 1024 == 0) ct.ThrowIfCancellationRequested();
            var triangle = triangles[i];
            points[0] = triangle.A; points[1] = triangle.B; points[2] = triangle.C;
            for (var k = 0; k < 3; k++)
            {
                // Exact coordinate welding only: never silently repair a near-coincident vertex.
                if (!vertexIds.TryGetValue(points[k], out var id)) { id = vertexIds.Count; vertexIds.Add(points[k], id); }
                ids[k] = id;
                cornerVertices[3 * i + k] = id;
            }
            for (var k = 0; k < 3; k++)
            {
                var next = (k + 1) % 3;
                var x = ids[k]; var y = ids[next];
                var key = (Math.Min(x, y), Math.Max(x, y));
                var lowCorner = 3 * i + (x < y ? k : next);
                var highCorner = 3 * i + (x < y ? next : k);
                if (!edges.TryGetValue(key, out var edge)) edge = new EdgeUsage(0, 0, lowCorner, highCorner);
                else
                {
                    faces.Union(i, edge.LowCorner / 3);
                    corners.Union(lowCorner, edge.LowCorner);
                    corners.Union(highCorner, edge.HighCorner);
                }
                edges[key] = edge with { Count = edge.Count + 1, Direction = edge.Direction + (x < y ? 1 : -1) };
            }
        }
        var boundary = 0; var nonManifold = 0; var inconsistent = 0; var processed = 0;
        var boundaryDegrees = new int[vertexIds.Count];
        var badVertices = new bool[vertexIds.Count];
        foreach (var (key, edge) in edges)
        {
            if (processed++ % 1024 == 0) ct.ThrowIfCancellationRequested();
            if (edge.Count == 1) { boundary++; boundaryDegrees[key.Low]++; boundaryDegrees[key.High]++; }
            if (edge.Count > 2) { nonManifold++; badVertices[key.Low] = true; badVertices[key.High] = true; }
            if (edge.Count == 2 && edge.Direction != 0) inconsistent++;
        }
        // Each vertex link must be one fan (a cycle or a path). A shared point alone cannot join fans.
        var seenFan = new bool[vertexIds.Count];
        for (var i = 0; i < cornerVertices.Length; i++)
        {
            if (i % 1024 == 0) ct.ThrowIfCancellationRequested();
            if (!corners.IsRoot(i)) continue;
            var vertex = cornerVertices[i];
            if (seenFan[vertex]) badVertices[vertex] = true;
            seenFan[vertex] = true;
        }
        var nonManifoldVertices = 0;
        for (var i = 0; i < badVertices.Length; i++)
        {
            if (i % 1024 == 0) ct.ThrowIfCancellationRequested();
            if (badVertices[i] || boundaryDegrees[i] is not (0 or 2)) nonManifoldVertices++;
        }
        return new MeshTopology(boundary, nonManifold, inconsistent, boundary == 0 && nonManifold == 0,
            inconsistent == 0, nonManifoldVertices, nonManifoldVertices == 0, faces.Count);
    }
}
