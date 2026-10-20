using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using ForgeX.Api;
using ForgeX.Domain;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace ForgeX.ResourceGate;

internal static class MeshSection
{
    private const string Namespace = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
    private const string Production = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
    private const string PartRelations = "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='part' Type='http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel' Target='Objects/part.model'/></Relationships>";
    private const string Mesh = "<mesh><vertices><vertex x='0' y='0' z='0'/><vertex x='10' y='0' z='0'/><vertex x='0' y='10' z='0'/><vertex x='0' y='0' z='10'/></vertices><triangles><triangle v1='0' v2='2' v3='1'/><triangle v1='0' v2='1' v3='3'/><triangle v1='0' v2='3' v3='2'/><triangle v1='1' v2='2' v3='3'/></triangles></mesh>";
    private static readonly float[][] Vertices = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    private static readonly int[][] Faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

    private static byte[] Stl(int faces = 4, bool reverse = false, bool duplicate = false)
    {
        var triangles = Faces.Take(faces).Select(f => f.ToArray()).ToList();
        if (reverse) Array.Reverse(triangles[0]);
        if (duplicate) triangles.Add(Faces[0]);
        var bytes = new byte[84 + triangles.Count * 50];
        Encoding.ASCII.GetBytes("solid binary tetrahedron").CopyTo(bytes, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(80), (uint)triangles.Count);
        var offset = 96;
        foreach (var triangle in triangles)
        {
            foreach (var index in triangle)
                foreach (var coordinate in Vertices[index])
                { BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(offset), coordinate); offset += 4; }
            offset += 14;
        }
        return bytes;
    }

    private static string Model(string? resources = null, string? build = null, string unit = "millimeter", string extra = "") =>
        $"<model xmlns='{Namespace}' unit='{unit}' {extra}><resources>{resources ?? "<object id='1'>" + Mesh + "</object>"}</resources><build>{build ?? "<item objectid='1'/>"}</build></model>";

    private static byte[] Package(string model, string? relationships = null, params (string Name, string Text)[] extras)
    {
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, true))
        {
            void Add(string path, string text)
            {
                using var writer = new StreamWriter(zip.CreateEntry(path, CompressionLevel.Optimal).Open(), new UTF8Encoding(false));
                writer.Write(text);
            }
            Add("_rels/.rels", relationships ?? "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='r' Type='http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel' Target='/3D/3dmodel.model'/></Relationships>");
            Add("3D/3dmodel.model", model);
            foreach (var (name, text) in extras) Add(name, text);
        }
        return output.ToArray();
    }

    public static async Task RunAsync(Gate gate)
    {
        gate.Section("mesh-authority: STL / core 3MF geometry and bounded public endpoint");
        var analyzer = new MeshAnalyzer();
        Task<MeshAnalysisResult> Analyze(byte[] bytes, string format = "stl") => analyzer.AnalyzeAsync(new MemoryStream(bytes), format, CancellationToken.None);
        var tetraBytes = Stl();
        var tetra = await Analyze(tetraBytes);
        gate.Check("mesh-binary-stl-named-solid", tetra.Format == "stl-binary" && tetra.TriangleCount == 4);
        gate.Check("mesh-tetra-dimensions", tetra.SizeMm == new MeshSize(10, 10, 10));
        gate.Check("mesh-tetra-volume", Math.Abs(tetra.VolumeCm3!.Value - 1d / 6) < 1e-12, tetra.VolumeCm3);
        gate.Check("mesh-tetra-area", Math.Abs(tetra.SurfaceAreaCm2 - (150 + Math.Sqrt(3) * 50) / 100) < 1e-12);
        gate.Check("mesh-tetra-topology", tetra.Topology is { ClosedEdgeManifold: true, OrientationConsistent: true, SelfIntersectionChecked: false });
        gate.Check("mesh-content-binding", tetra.Bytes == tetraBytes.Length && tetra.Sha256 == Convert.ToHexStringLower(SHA256.HashData(tetraBytes)));
        gate.Check("mesh-stl-unit-disclosure", tetra.Unit is null && tetra.Warnings.Any(w => w.Contains("毫米")));
        var open = await Analyze(Stl(3));
        gate.Check("mesh-open-volume-withheld", open.VolumeCm3 is null && open.Topology.BoundaryEdges == 3);
        var reversed = await Analyze(Stl(reverse: true));
        gate.Check("mesh-inconsistent-volume-withheld", reversed.VolumeCm3 is null && reversed.Topology.InconsistentEdges == 3);
        var duplicate = await Analyze(Stl(duplicate: true));
        gate.Check("mesh-nonmanifold-volume-withheld", duplicate.VolumeCm3 is null && duplicate.Topology.NonManifoldEdges == 3);
        var ascii = new StringBuilder("\uFEFFsolid fixture\n");
        foreach (var face in Faces)
        {
            ascii.Append("facet normal 0 0 0\nouter loop\n");
            foreach (var index in face) ascii.AppendLine("vertex\t" + string.Join("\t", Vertices[index]));
            ascii.Append("endloop\nendfacet\n");
        }
        ascii.Append("endsolid fixture\n");
        var textTetra = await Analyze(Encoding.UTF8.GetBytes(ascii.ToString()));
        gate.Check("mesh-ascii-stl-bom-tabs", textTetra.Format == "stl-ascii" && textTetra.VolumeCm3 == tetra.VolumeCm3);
        var degenerate = Stl(duplicate: true);
        Array.Clear(degenerate, 84 + 4 * 50 + 12, 36);
        var filtered = await Analyze(degenerate);
        gate.Check("mesh-degenerate-disclosed", filtered.TriangleCount == 4 && filtered.DroppedTriangles == 1);

        foreach (var (unit, scale) in new[] { ("micron", 0.001), ("millimeter", 1d), ("centimeter", 10d), ("inch", 25.4), ("foot", 304.8), ("meter", 1000d) })
        {
            var result = await Analyze(Package(Model(unit: unit)), "3mf");
            gate.Check("mesh-3mf-unit-" + unit, Math.Abs(result.SizeMm.X - 10 * scale) < 1e-8 &&
                Math.Abs(result.VolumeCm3!.Value - scale * scale * scale / 6) < Math.Max(1e-9, scale * scale * scale * 1e-12));
        }
        var component = "<object id='1'>" + Mesh + "</object><object id='2'><components><component objectid='1' transform='2 0 0 0 2 0 0 0 2 0 0 0'/></components></object>";
        var transformed = await Analyze(Package(Model(component, "<item objectid='2' transform='1 0 0 0 1 0 0 0 1 100 200 300'/>")), "3mf");
        gate.Check("mesh-3mf-nested-transform", transformed.SizeMm == new MeshSize(20, 20, 20) && Math.Abs(transformed.VolumeCm3!.Value - 8d / 6) < 1e-10);
        var pair = await Analyze(Package(Model(build: "<item objectid='1'/><item objectid='1' transform='1 0 0 0 1 0 0 0 1 30 0 0'/>")), "3mf");
        gate.Check("mesh-3mf-build-instances", pair.ObjectCount == 2 && pair.TriangleCount == 8 && pair.SizeMm.X == 40);
        gate.Check("mesh-multi-object-volume-withheld", pair.VolumeCm3 is null && pair.Warnings.Any(w => w.Contains("布尔并集")));
        var reflected = await Analyze(Package(Model(build: "<item objectid='1' transform='-1 0 0 0 1 0 0 0 1 0 0 0'/>")), "3mf");
        gate.Check("mesh-3mf-negative-determinant-disclosed", reflected.VolumeCm3 > 0 && reflected.Warnings.Any(w => w.Contains("为负")));
        gate.Check("mesh-self-intersection-limitation-disclosed", pair.Warnings.Any(w => w.Contains("自相交") && w.Contains("重叠")));

        var productionExtra = $"xmlns:parts='{Production}' requiredextensions='parts'";
        var assembly = Model("<object id='2'><components><component objectid='2' parts:path='/3D/Objects/part.model' transform='2 0 0 0 2 0 0 0 2 30 0 0'/></components></object>",
            "<item objectid='2' transform='1 0 0 0 1 0 0 0 1 100 0 0'/>", extra: productionExtra);
        var child = Model("<object id='1'>" + Mesh + "</object><object id='2'><components><component objectid='1' transform='1 0 0 0 1 0 0 0 1 1 0 0'/></components></object>",
            "<item objectid='999' transform='not executed' path='ignored'/>", unit: "inch");
        byte[] ProductionPackage(string? root = null, string? part = null, string? relations = null) =>
            Package(root ?? assembly, null, ("3D/_rels/3dmodel.model.rels", relations ?? PartRelations), ("3D/Objects/part.model", part ?? child));
        var built = await Analyze(ProductionPackage(), "3mf");
        gate.Check("mesh-production-prefixed-required-extension", built.TriangleCount == 4 && built.ObjectCount == 1);
        gate.Check("mesh-production-mixed-unit-nested-transform", Math.Abs(built.SizeMm.X - 508) < 1e-8 && Math.Abs(built.SizeMm.Z - 508) < 1e-8);
        gate.Check("mesh-production-child-build-ignored", Math.Abs(built.VolumeCm3!.Value - Math.Pow(50.8, 3) / 6) < 1e-7);
        var twoParts = Model("<object id='1'>" + Mesh + "</object>",
            "<item objectid='1'/><item objectid='1' parts:path='/3D/Objects/part.model' transform='1 0 0 0 1 0 0 0 1 30 0 0'/>", unit: "centimeter", extra: productionExtra);
        var mixed = await Analyze(ProductionPackage(twoParts, Model(unit: "inch")), "3mf");
        gate.Check("mesh-production-scoped-ids-and-parent-unit-translation", Math.Abs(mixed.SizeMm.X - 554) < 1e-9 && mixed.ObjectCount == 2 && mixed.TriangleCount == 8);
        gate.Check("mesh-production-multi-object-volume-withheld", mixed.VolumeCm3 is null);
        var relativeRelation = PartRelations.Replace("Objects/part.model", "../3D/Objects/part.model");
        gate.Check("mesh-production-relative-opc-relationship", (await Analyze(ProductionPackage(relations: relativeRelation), "3mf")).TriangleCount == 4);
        var escapedAssembly = assembly.Replace("Objects/part.model", "Objects/%70art.model");
        gate.Check("mesh-production-percent-encoded-part-path", (await Analyze(ProductionPackage(escapedAssembly), "3mf")).TriangleCount == 4);
        var alternativeRoot = Package(Model(build: "<item objectid='999'/>"),
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='r' Type='http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel' Target='/3D/build.model'/></Relationships>",
            ("3D/build.model", assembly), ("3D/_rels/build.model.rels", PartRelations), ("3D/Objects/part.model", child));
        gate.Check("mesh-production-root-selected-by-opc", (await Analyze(alternativeRoot, "3mf")).TriangleCount == 4);

        var app = await gate.StartApiAsync(new Dictionary<string, string?>
        { ["DirectAuth:ApiKeys"] = "mesh-gate-key", ["DirectAuth:RequireAuth"] = "true" },
            b => b.Services.AddSingleton<MeshAnalysisAdmission>(), a =>
            {
                a.MapPost("/api/v1/meshes/analyze", (RequestDelegate)(async context =>
                {
                    var result = await MeshEndpoints.AnalyzeAsync(context, context.RequestServices.GetRequiredService<MeshAnalysisAdmission>());
                    await result.ExecuteAsync(context);
                }));
            });
        var origin = Gate.Origin(app);
        async Task<(HttpStatusCode Status, System.Text.Json.JsonElement Json)> Send(byte[] bytes, string format = "stl", string? key = "mesh-gate-key", string type = "application/octet-stream", string? token = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, origin + "/API/V1/MESHES/ANALYZE?format=" + format);
            request.Content = new ByteArrayContent(bytes);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
            if (key is not null) request.Headers.Add("X-API-Key", key);
            if (token is not null) request.Headers.Add("X-ForgeX-Internal-Token", token);
            using var response = await gate.Http.SendAsync(request);
            return (response.StatusCode, Gate.Parse(await response.Content.ReadAsStringAsync()));
        }
        var valid = await Send(tetraBytes);
        gate.Check("mesh-http-result", valid.Status == HttpStatusCode.OK && valid.Json.GetProperty("engine").GetString() == "forgex-mesh-csharp");
        gate.Check("mesh-http-content-type-case", (await Send(tetraBytes, type: "APPLICATION/OCTET-STREAM")).Status == HttpStatusCode.OK);
        gate.Check("mesh-http-null-unit-preserved", valid.Json.GetProperty("unit").ValueKind == System.Text.Json.JsonValueKind.Null);
        var openHttp = await Send(Stl(3));
        gate.Check("mesh-http-null-volume-preserved", openHttp.Json.GetProperty("volumeCm3").ValueKind == System.Text.Json.JsonValueKind.Null);
        gate.Check("mesh-http-auth-required", (await Send(tetraBytes, key: null)).Status == HttpStatusCode.Unauthorized);
        gate.Check("mesh-http-forged-token-rejected", (await Send(tetraBytes, token: "forged")).Status == HttpStatusCode.Unauthorized);
        gate.Check("mesh-http-format-required", (await Send(tetraBytes, format: "")).Status == HttpStatusCode.BadRequest);
        gate.Check("mesh-http-content-type", (await Send(tetraBytes, type: "application/json")).Status == HttpStatusCode.UnsupportedMediaType);
        var slot = app.Services.GetRequiredService<MeshAnalysisAdmission>().Slot;
        await slot.WaitAsync();
        try { gate.Check("mesh-http-admission-bounded", (await Send(tetraBytes)).Status == HttpStatusCode.TooManyRequests); }
        finally { slot.Release(); }
        var invalidCases = new (string Name, byte[] Bytes, string Format, int Status)[]
        {
            ("empty", [], "stl", 422), ("truncated", tetraBytes[..^1], "stl", 422),
            ("ascii-incomplete", Encoding.UTF8.GetBytes("solid x\nvertex 0 0 0\nendsolid x"), "stl", 422),
            ("zip-corrupt", [80, 75, 3, 4], "3mf", 422),
            ("unit", Package(Model(unit: "furlong")), "3mf", 422),
            ("required-extension", Package(Model(extra: "requiredextensions='p' xmlns:p='urn:unsupported'")), "3mf", 422),
            ("external-part", Package(Model(build: "<item objectid='1' xmlns:p='urn:production' p:path='/3D/part.model'/>")), "3mf", 422),
            ("vertex-index", Package(Model("<object id='1'>" + Mesh.Replace("v1='0'", "v1='99'") + "</object>")), "3mf", 422),
            ("negative-index", Package(Model("<object id='1'>" + Mesh.Replace("v1='0'", "v1='-1'") + "</object>")), "3mf", 422),
            ("missing-object", Package(Model(build: "<item objectid='999'/>")), "3mf", 422),
            ("cycle", Package(Model("<object id='1'><components><component objectid='1'/></components></object>")), "3mf", 422),
            ("duplicate-id", Package(Model("<object id='1'>" + Mesh + "</object><object id='1'>" + Mesh + "</object>")), "3mf", 422),
            ("empty-build", Package(Model(build: "")), "3mf", 422),
            ("matrix", Package(Model(build: "<item objectid='1' transform='1 0 NaN'/>")), "3mf", 422),
            ("coordinate", Package(Model(build: "<item objectid='1' transform='1 0 0 0 1 0 0 0 1 2000000 0 0'/>")), "3mf", 422),
            ("dtd", Package("<!DOCTYPE model [<!ENTITY x SYSTEM 'file:///secret'>]>" + Model()), "3mf", 422),
            ("traversal", Package(Model(), null, ("../unsafe", "x")), "3mf", 422),
            ("duplicate-path", Package(Model(), null, ("3d/3DMODEL.MODEL", "x")), "3mf", 422),
            ("xml-limit", Package(Model(extra: "hint='" + new string('x', 16 * 1024 * 1024) + "'")), "3mf", 413),
        };
        foreach (var test in invalidCases)
        {
            var result = await Send(test.Bytes, test.Format);
            gate.Check("mesh-http-invalid-" + test.Name, (int)result.Status == test.Status, result.Json);
            gate.Check("mesh-http-invalid-no-path-" + test.Name, !result.Json.ToString().Contains("file:///secret"));
        }
        var productionInvalid = new (string Name, byte[] Bytes)[]
        {
            ("missing-relationship", ProductionPackage(relations: PartRelations.Replace("3dmodel'", "unknown'"))),
            ("external-relationship", ProductionPackage(relations: PartRelations.Replace("Target=", "TargetMode='External' Target="))),
            ("network-relationship", ProductionPackage(relations: PartRelations.Replace("Objects/part.model", "https://example.invalid/a.model"))),
            ("escaped-relationship", ProductionPackage(relations: PartRelations.Replace("Objects/part.model", "../../outside.model"))),
            ("missing-part", ProductionPackage(relations: PartRelations.Replace("Objects/part.model", "Objects/missing.model"))),
            ("relative-part", ProductionPackage(assembly.Replace("/3D/Objects/part.model", "Objects/part.model"))),
            ("traversal-part", ProductionPackage(assembly.Replace("/3D/Objects/part.model", "/3D/%2e%2e/part.model"))),
            ("encoded-network-part", ProductionPackage(assembly.Replace("/3D/Objects/part.model", "/%2f3D/Objects/part.model"))),
            ("wrong-path-namespace", ProductionPackage(assembly.Replace(Production, "urn:wrong"))),
            ("unqualified-path", ProductionPackage(assembly.Replace("parts:path", "path"))),
            ("missing-required-extension", ProductionPackage(assembly.Replace("requiredextensions='parts'", ""))),
            ("child-cross-reference", ProductionPackage(part: Model("<object id='2'><components><component objectid='1' parts:path='/3D/Objects/part.model'/></components></object>", extra: productionExtra))),
            ("child-unsupported-extension", ProductionPackage(part: child.Replace("<model ", "<model requiredextensions='q' xmlns:q='urn:unsupported' "))),
            ("child-unknown-unit", ProductionPackage(part: child.Replace("inch", "parsec"))),
            ("child-missing-object", ProductionPackage(part: Model())),
            ("duplicate-geometry", Package(Model("<object id='1'>" + Mesh + Mesh + "</object>"))),
            ("production-and-unknown-required", ProductionPackage(assembly.Replace("requiredextensions='parts'", "requiredextensions='parts q' xmlns:q='urn:unsupported'"))),
        };
        foreach (var test in productionInvalid)
            gate.Check("mesh-production-reject-" + test.Name, (await Send(test.Bytes, "3mf")).Status == HttpStatusCode.UnprocessableEntity);
        var forgedXmlSize = invalidCases[^1].Bytes.ToArray();
        for (var offset = 0; offset < forgedXmlSize.Length - 46; offset++)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(forgedXmlSize.AsSpan(offset)) != 0x02014b50) continue;
            var nameLength = BinaryPrimitives.ReadUInt16LittleEndian(forgedXmlSize.AsSpan(offset + 28));
            var name = Encoding.UTF8.GetString(forgedXmlSize, offset + 46, nameLength);
            if (name.EndsWith(".model", StringComparison.Ordinal))
            {
                BinaryPrimitives.WriteUInt32LittleEndian(forgedXmlSize.AsSpan(offset + 24), 1);
                break;
            }
        }
        var forgedSize = await Send(forgedXmlSize, "3mf");
        gate.Check("mesh-actual-xml-expansion-bounded", forgedSize.Status is HttpStatusCode.RequestEntityTooLarge or HttpStatusCode.UnprocessableEntity);
        var nonfinite = Stl();
        BinaryPrimitives.WriteSingleLittleEndian(nonfinite.AsSpan(96), float.NaN);
        gate.Check("mesh-nonfinite-rejected", (await Send(nonfinite)).Status == HttpStatusCode.UnprocessableEntity);
        var excessive = new byte[84 + 50 * (MeshAnalyzer.MaxTriangles + 1)];
        BinaryPrimitives.WriteUInt32LittleEndian(excessive.AsSpan(80), MeshAnalyzer.MaxTriangles + 1u);
        gate.Check("mesh-triangle-limit", (await Send(excessive)).Status == HttpStatusCode.RequestEntityTooLarge);
        var tooManyEntries = Enumerable.Range(0, 255).Select(i => ("extra/" + i, "")).ToArray();
        gate.Check("mesh-zip-entry-limit", (await Send(Package(Model(), null, tooManyEntries), "3mf")).Status == HttpStatusCode.RequestEntityTooLarge);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try { await analyzer.AnalyzeAsync(new MemoryStream(tetraBytes), "stl", cancelled.Token); gate.Check("mesh-cancelled", false); }
        catch (OperationCanceledException) { gate.Check("mesh-cancelled", true); }
        gate.Check("mesh-admission-released-after-errors", (await Send(tetraBytes)).Status == HttpStatusCode.OK);
        gate.Check("mesh-metrics-route-label", ForgeXMetrics.RouteLabel("/API/V1/MESHES/ANALYZE") == "/api/v1/meshes/analyze");
    }
}
