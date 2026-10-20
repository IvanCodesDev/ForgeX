using System.Buffers.Binary;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using ForgeX.Api;
using ForgeX.Domain;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

internal static class MeshTopologySection
{
    private static readonly float[][] Points = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    private static readonly int[][] Faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

    private static float[] Tetra(float x = 0, float signY = 1, float signZ = 1, float scale = 1) =>
        Faces.SelectMany(face => face.SelectMany(index => new[] { Points[index][0] * scale + x, Points[index][1] * signY * scale, Points[index][2] * signZ * scale })).ToArray();

    private static byte[] Stl(float[] coordinates)
    {
        var bytes = new byte[84 + coordinates.Length / 9 * 50];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(80), (uint)(coordinates.Length / 9));
        for (var i = 0; i < coordinates.Length; i++)
            BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(84 + i / 9 * 50 + 12 + i % 9 * 4), coordinates[i]);
        return bytes;
    }

    public static async Task RunAsync(Gate gate)
    {
        gate.Section("mesh-topology: vertex fans and edge-connected face components");
        var analyzer = new MeshAnalyzer();
        Task<MeshAnalysisResult> Analyze(float[] coordinates) => analyzer.AnalyzeAsync(new MemoryStream(Stl(coordinates)), "stl", CancellationToken.None);
        var tetra = await Analyze(Tetra());
        gate.Check("mesh-topology-version", tetra.SchemaVersion == "1.1" && tetra.EngineVersion == "1.2.0");
        gate.Check("mesh-topology-tetra-single-fan", tetra.Topology is { NonManifoldVertices: 0, VertexManifold: true, ConnectedComponents: 1 });
        gate.Check("mesh-topology-tetra-volume-preserved", Math.Abs(tetra.VolumeCm3!.Value - 1d / 6) < 1e-12);
        var open = await Analyze(Tetra()[..27]);
        gate.Check("mesh-topology-boundary-vertices-can-be-manifold", open.Topology is { VertexManifold: true, BoundaryEdges: 3, ConnectedComponents: 1 } && open.VolumeCm3 is null);
        var pinchedCoordinates = Tetra().Concat(Tetra(scale: -1).Chunk(9).SelectMany(t => t[..3].Concat(t[6..9]).Concat(t[3..6]))).ToArray();
        var pinched = await Analyze(pinchedCoordinates);
        gate.Check("mesh-topology-pinched-edges-still-closed", pinched.Topology is { ClosedEdgeManifold: true, OrientationConsistent: true });
        gate.Check("mesh-topology-pinched-shared-vertex-detected", pinched.Topology is { NonManifoldVertices: 1, VertexManifold: false, ConnectedComponents: 2 });
        gate.Check("mesh-topology-pinched-volume-withheld", pinched.ObjectCount == 1 && pinched.VolumeCm3 is null);
        gate.Check("mesh-topology-pinched-reason-disclosed", pinched.Warnings.Any(w => w.Contains("非流形顶点")));
        var shells = await Analyze(Tetra().Concat(Tetra(30)).ToArray());
        gate.Check("mesh-topology-disconnected-shells-are-manifold", shells.Topology is { NonManifoldVertices: 0, VertexManifold: true, ConnectedComponents: 2 });
        gate.Check("mesh-topology-disconnected-single-object-volume-withheld", shells.ObjectCount == 1 && shells.VolumeCm3 is null);
        gate.Check("mesh-topology-shell-containment-not-assumed", shells.Warnings.Any(w => w.Contains("壳体包含关系")));
        var nested = await Analyze(Tetra().Concat(Tetra(1, scale: 0.2f).Select((v, i) => i % 3 == 0 ? v : v + 1)).ToArray());
        gate.Check("mesh-topology-nested-shells-volume-withheld", nested.Topology is { VertexManifold: true, ConnectedComponents: 2 } && nested.VolumeCm3 is null);
        var bowTie = await Analyze([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 0, -10, 0, 0, 0, -10, 0]);
        gate.Check("mesh-topology-boundary-bow-tie", bowTie.Topology is { BoundaryEdges: 6, NonManifoldEdges: 0, NonManifoldVertices: 1, ConnectedComponents: 2 });
        var branching = await Analyze(Tetra().Concat(Tetra(signY: -1, signZ: -1)).ToArray());
        gate.Check("mesh-topology-non-manifold-edge-endpoints", branching.Topology is { NonManifoldEdges: 1, NonManifoldVertices: 2, VertexManifold: false, ConnectedComponents: 1 });
        var reordered = await Analyze(pinchedCoordinates.Chunk(9).Reverse().SelectMany(t => t[3..9].Concat(t[..3])).ToArray());
        gate.Check("mesh-topology-independent-of-face-order-and-corner-rotation", reordered.Topology == pinched.Topology);
        var inverted = await Analyze(Tetra().Chunk(9).SelectMany(t => t[..3].Concat(t[6..9]).Concat(t[3..6])).ToArray());
        gate.Check("mesh-topology-independent-of-global-winding", inverted.Topology == tetra.Topology && inverted.VolumeCm3 == tetra.VolumeCm3);
        var close = Tetra(scale: -1);
        for (var i = 0; i < close.Length; i += 3) close[i] -= 0.0001f;
        var near = await Analyze(Tetra().Concat(close).ToArray());
        gate.Check("mesh-topology-no-tolerance-repair", near.Topology is { NonManifoldVertices: 0, ConnectedComponents: 2 });
        var withDegenerate = await Analyze(Tetra().Concat(new float[9]).ToArray());
        gate.Check("mesh-topology-degenerate-faces-excluded", withDegenerate.DroppedTriangles == 1 && withDegenerate.Topology == tetra.Topology);
        var torus = new List<float>();
        float[] TorusPoint(int u, int v)
        {
            var a = 2 * Math.PI * (u % 16) / 16; var b = 2 * Math.PI * (v % 8) / 8;
            return [(float)((5 + Math.Cos(b)) * Math.Cos(a)), (float)((5 + Math.Cos(b)) * Math.Sin(a)), (float)Math.Sin(b)];
        }
        for (var u = 0; u < 16; u++)
            for (var v = 0; v < 8; v++)
            {
                var a = TorusPoint(u, v); var b = TorusPoint(u + 1, v); var c = TorusPoint(u + 1, v + 1); var d = TorusPoint(u, v + 1);
                torus.AddRange(a.Concat(b).Concat(c).Concat(a).Concat(c).Concat(d));
            }
        var handle = await Analyze(torus.ToArray());
        gate.Check("mesh-topology-genus-one-is-manifold", handle.Topology is { ClosedEdgeManifold: true, VertexManifold: true, ConnectedComponents: 1 } && handle.VolumeCm3 > 0);
        // Identify two distant pole vertices of a closed tube: the face graph stays connected,
        // while the shared pole has two distinct incident fans and every edge still has two faces.
        var pinchedTube = new List<float>();
        float[] Ring(int index, float z) => [(float)Math.Cos(2 * Math.PI * (index % 8) / 8), (float)Math.Sin(2 * Math.PI * (index % 8) / 8), z];
        for (var i = 0; i < 8; i++)
        {
            var a = Ring(i, 1); var b = Ring(i + 1, 1); var c = Ring(i, -1); var d = Ring(i + 1, -1);
            pinchedTube.AddRange(new float[3].Concat(a).Concat(b).Concat(new float[3]).Concat(d).Concat(c));
            pinchedTube.AddRange(a.Concat(c).Concat(d).Concat(a).Concat(d).Concat(b));
        }
        var connectedPinch = await Analyze(pinchedTube.ToArray());
        gate.Check("mesh-topology-single-component-pinched-vertex-withheld", connectedPinch.Topology is { ClosedEdgeManifold: true, OrientationConsistent: true, NonManifoldVertices: 1, ConnectedComponents: 1 } && connectedPinch.VolumeCm3 is null);
        var fan = new List<float>();
        const int sectors = 10000;
        var circle = Enumerable.Range(0, sectors).Select(i => new[] { (float)Math.Cos(2 * Math.PI * i / sectors), (float)Math.Sin(2 * Math.PI * i / sectors), 0f }).ToArray();
        for (var i = 0; i < sectors; i++) { fan.AddRange([0, 0, 0]); fan.AddRange(circle[i]); fan.AddRange(circle[(i + 1) % sectors]); }
        var timer = Stopwatch.StartNew();
        var disk = await Analyze(fan.ToArray());
        gate.Check("mesh-topology-high-valence-fan", disk.Topology is { NonManifoldVertices: 0, VertexManifold: true, BoundaryEdges: sectors, ConnectedComponents: 1 });
        Console.WriteLine($"  topology fan: {sectors} triangles, {timer.ElapsedMilliseconds} ms");
        gate.Check("mesh-topology-limitations-disclosed", tetra.Warnings.Any(w => w.Contains("坐标完全相同") && w.Contains("自相交") && w.Contains("组件重叠")) && !tetra.Topology.SelfIntersectionChecked);

        var app = await gate.StartApiAsync(new Dictionary<string, string?> { ["DirectAuth:ApiKeys"] = "mesh-topology-key", ["DirectAuth:RequireAuth"] = "true" },
            b => b.Services.AddSingleton<MeshAnalysisAdmission>(), a => a.MapPost("/api/v1/meshes/analyze", (RequestDelegate)(async context =>
            {
                var result = await MeshEndpoints.AnalyzeAsync(context, context.RequestServices.GetRequiredService<MeshAnalysisAdmission>());
                await result.ExecuteAsync(context);
            })));
        using var request = new HttpRequestMessage(HttpMethod.Post, Gate.Origin(app) + "/api/v1/meshes/analyze?format=stl");
        request.Headers.Add("X-API-Key", "mesh-topology-key");
        request.Content = new ByteArrayContent(Stl(pinchedCoordinates));
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await gate.Http.SendAsync(request);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        gate.Check("mesh-topology-http-schema", response.IsSuccessStatusCode && json.GetProperty("schemaVersion").GetString() == "1.1");
        gate.Check("mesh-topology-http-pinched-fields", json.GetProperty("topology").GetProperty("nonManifoldVertices").GetInt32() == 1 && json.GetProperty("topology").GetProperty("connectedComponents").GetInt32() == 2);
        gate.Check("mesh-topology-http-null-volume", json.GetProperty("volumeCm3").ValueKind == JsonValueKind.Null);
    }
}
