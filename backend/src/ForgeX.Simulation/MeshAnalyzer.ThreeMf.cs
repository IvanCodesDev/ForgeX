using System.Globalization;
using System.IO.Compression;
using System.Xml;
using System.Xml.Linq;
using ForgeX.Domain;

namespace ForgeX.Simulation;

public sealed partial class MeshAnalyzer
{
    private static readonly XNamespace Core = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
    private static readonly XNamespace Production = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
    private static readonly double[] Identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    private const string ModelRelationship = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

    private static (string Unit, int Objects) Read3mf(byte[] bytes, int length, List<Triangle> triangles, CancellationToken ct)
    {
        using var archive = new ZipArchive(new MemoryStream(bytes, 0, length, false), ZipArchiveMode.Read);
        if (archive.Entries.Count > 256) throw Limit("3MF ZIP 条目超过 256 个");
        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        foreach (var entry in archive.Entries)
        {
            ct.ThrowIfCancellationRequested();
            expanded += entry.Length;
            if (expanded > MaxBytes) throw Limit("3MF 总解压大小超过 64 MB");
            var path = PackagePath(entry.FullName.TrimEnd('/'));
            if (!entries.TryAdd(path, entry)) throw Invalid("3MF 包含重复或大小写冲突的 ZIP 路径");
        }
        long actualExpanded = 0;
        XDocument ReadXml(string path)
        {
            if (!entries.TryGetValue(path, out var entry)) throw Invalid("3MF 缺少关系引用的包内文件");
            if (entry.Length > MaxXmlBytes) throw Limit("3MF 单个 XML 文件超过 16 MB");
            using var stream = entry.Open();
            using var expandedXml = new MemoryStream();
            var chunk = new byte[16 * 1024];
            int read;
            while ((read = stream.Read(chunk)) != 0)
            {
                ct.ThrowIfCancellationRequested();
                if (expandedXml.Length + read > MaxXmlBytes) throw Limit("3MF XML 实际解压大小超过 16 MB");
                actualExpanded += read;
                if (actualExpanded > MaxBytes) throw Limit("3MF XML 累计实际解压大小超过 64 MB");
                expandedXml.Write(chunk, 0, read);
            }
            if (expandedXml.Length != entry.Length) throw Invalid("3MF XML 实际解压长度与目录声明不符");
            expandedXml.Position = 0;
            using var xml = XmlReader.Create(expandedXml, new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                MaxCharactersInDocument = MaxXmlBytes, IgnoreComments = true,
            });
            var document = XDocument.Load(xml);
            ct.ThrowIfCancellationRequested();
            return document;
        }
        var relationships = ReadXml("_rels/.rels");
        XNamespace opc = "http://schemas.openxmlformats.org/package/2006/relationships";
        if (relationships.Root?.Name != opc + "Relationships") throw Invalid("3MF 包关系命名空间无效");
        var modelRelations = relationships.Root.Elements(opc + "Relationship")
            .Where(e => (string?)e.Attribute("Type") == ModelRelationship).ToArray();
        if (modelRelations.Length != 1 || (string?)modelRelations[0].Attribute("TargetMode") is not (null or "Internal"))
            throw Invalid("3MF 必须通过一个包内关系指定根模型");
        var rootPath = PackagePath((string?)modelRelations[0].Attribute("Target") ?? "");
        var parts = new Dictionary<string, ModelPart>(StringComparer.OrdinalIgnoreCase);
        var resourceCount = 0;
        ModelPart ReadPart(string path)
        {
            if (parts.TryGetValue(path, out var cached)) return cached;
            var model = ReadXml(path).Root;
            if (model?.Name != Core + "model") throw Invalid("3MF 模型命名空间无效");
            var required = WhiteSpace().Split(((string?)model.Attribute("requiredextensions") ?? "").Trim())
                .Where(p => p.Length != 0).Select(p => p.Contains(':') ? null : model.GetNamespaceOfPrefix(p)).ToArray();
            if (required.Any(ns => ns != Production))
                throw new MeshAnalysisException("mesh_unsupported", "此 3MF 声明了不受支持的必需扩展；当前仅支持核心几何与 Production 分件引用");
            var unit = (string?)model.Attribute("unit") ?? "millimeter";
            var scale = unit switch
            {
                "micron" => 0.001, "millimeter" => 1d, "centimeter" => 10d,
                "inch" => 25.4, "foot" => 304.8, "meter" => 1000d,
                _ => throw Invalid("3MF 单位不受支持"),
            };
            var resources = new Dictionary<int, XElement>();
            foreach (var obj in model.Element(Core + "resources")?.Elements(Core + "object") ?? [])
            {
                ct.ThrowIfCancellationRequested();
                if (++resourceCount > 4096) throw Limit("3MF 包内对象总数超过 4096");
                var id = Index((string?)obj.Attribute("id"));
                if (id < 1 || !resources.TryAdd(id, obj)) throw Invalid("3MF 对象 ID 重复或无效");
            }
            foreach (var element in model.Descendants().Where(e => e.Name == Core + "component" ||
                (path.Equals(rootPath, StringComparison.OrdinalIgnoreCase) && e.Name == Core + "item")))
            {
                var paths = element.Attributes().Where(a => a.Name.LocalName == "path").ToArray();
                if (paths.Any(a => a.Name != Production + "path")) throw Invalid("3MF 分件路径必须使用 Production 命名空间");
                // Child build sections are never executed, but nested cross-part components are invalid.
                if (element.Name == Core + "component" && paths.Length != 0 && !path.Equals(rootPath, StringComparison.OrdinalIgnoreCase))
                    throw Invalid("3MF 非根模型的组件不能跨文件引用");
                if (paths.Length != 0 && !required.Contains(Production)) throw Invalid("3MF 分件引用必须声明 Production 必需扩展");
            }
            var part = new ModelPart(model, unit, scale, resources);
            parts.Add(path, part);
            return part;
        }
        var root = ReadPart(rootPath);
        var relatedParts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var slash = rootPath.LastIndexOf('/');
        var relationsPath = rootPath[..(slash + 1)] + "_rels/" + rootPath[(slash + 1)..] + ".rels";
        if (entries.ContainsKey(relationsPath))
        {
            var relations = ReadXml(relationsPath).Root;
            if (relations?.Name != opc + "Relationships") throw Invalid("3MF 模型关系命名空间无效");
            foreach (var relation in relations.Elements(opc + "Relationship").Where(e => (string?)e.Attribute("Type") == ModelRelationship))
            {
                if ((string?)relation.Attribute("TargetMode") is not (null or "Internal")) throw Invalid("3MF 不允许包外模型关系");
                var target = ResolveRelationship(rootPath, (string?)relation.Attribute("Target") ?? "");
                if (!entries.ContainsKey(target)) throw Invalid("3MF 模型关系指向不存在的包内文件");
                relatedParts.Add(target);
            }
        }
        string ReferencePath(XElement reference, string owner)
        {
            var path = (string?)reference.Attribute(Production + "path");
            if (path is null) return owner;
            if (!path.StartsWith('/') || path.StartsWith("//")) throw Invalid("3MF 分件路径必须是包内绝对路径");
            var target = PackagePath(path);
            if (!relatedParts.Contains(target)) throw Invalid("3MF 分件缺少根模型的包内关系声明");
            return target;
        }
        double[] ReferenceMatrix(XElement reference, string owner, string target, double[] parent)
        {
            var ratio = ReadPart(target).Scale / ReadPart(owner).Scale;
            double[] conversion = [ratio, 0, 0, 0, ratio, 0, 0, 0, ratio, 0, 0, 0];
            return Multiply(Multiply(conversion, Matrix(reference)), parent);
        }
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var instances = 0;
        var visited = 0;
        void Emit(string path, int id, double[] transform, int depth)
        {
            ct.ThrowIfCancellationRequested();
            if (depth > 32 || ++visited > 4096) throw Limit("3MF 组件嵌套或构建实例超过限制");
            var key = path + "#" + id.ToString(CultureInfo.InvariantCulture);
            if (!visiting.Add(key)) throw Invalid("3MF 组件引用存在环");
            if (!ReadPart(path).Resources.TryGetValue(id, out var obj)) throw Invalid("3MF 引用了不存在的对象");
            var type = (string?)obj.Attribute("type") ?? "model";
            if (type is not ("model" or "solidsupport")) throw new MeshAnalysisException("mesh_unsupported", "当前权威校验只支持 model / solidsupport 对象");
            var mesh = obj.Element(Core + "mesh");
            var components = obj.Element(Core + "components");
            if ((mesh is null) == (components is null)) throw Invalid("3MF 对象必须且只能包含 mesh 或 components");
            if (obj.Elements(Core + "mesh").Count() + obj.Elements(Core + "components").Count() != 1)
                throw Invalid("3MF 对象包含重复的几何容器");
            if (mesh is not null)
            {
                var vertices = new List<Point>();
                foreach (var v in mesh.Element(Core + "vertices")?.Elements(Core + "vertex") ?? [])
                {
                    if (vertices.Count >= MaxTriangles * 3) throw Limit("3MF 顶点数超过限制");
                    if (vertices.Count % 1024 == 0) ct.ThrowIfCancellationRequested();
                    var x = Number((string?)v.Attribute("x"));
                    var y = Number((string?)v.Attribute("y"));
                    var z = Number((string?)v.Attribute("z"));
                    vertices.Add(new Point(
                        (x * transform[0] + y * transform[3] + z * transform[6] + transform[9]) * root.Scale,
                        (x * transform[1] + y * transform[4] + z * transform[7] + transform[10]) * root.Scale,
                        (x * transform[2] + y * transform[5] + z * transform[8] + transform[11]) * root.Scale));
                }
                foreach (var t in mesh.Element(Core + "triangles")?.Elements(Core + "triangle") ?? [])
                {
                    if (triangles.Count % 1024 == 0) ct.ThrowIfCancellationRequested();
                    Point Vertex(string name)
                    {
                        var index = Index((string?)t.Attribute(name));
                        return index < vertices.Count ? vertices[index] : throw Invalid("3MF 三角面引用了不存在的顶点");
                    }
                    AddTriangle(triangles, Vertex("v1"), Vertex("v2"), Vertex("v3"));
                }
                instances++;
            }
            else
            {
                foreach (var component in components!.Elements(Core + "component"))
                {
                    var target = ReferencePath(component, path);
                    Emit(target, Index((string?)component.Attribute("objectid")), ReferenceMatrix(component, path, target, transform), depth + 1);
                }
            }
            visiting.Remove(key);
        }
        var items = root.Model.Element(Core + "build")?.Elements(Core + "item").ToArray() ?? [];
        if (items.Length == 0) throw Invalid("3MF 缺少有效构建清单");
        foreach (var item in items)
        {
            if ((string?)item.Attribute("printable") is "0" or "false") continue;
            var target = ReferencePath(item, rootPath);
            Emit(target, Index((string?)item.Attribute("objectid")), ReferenceMatrix(item, rootPath, target, Identity), 0);
        }
        return (root.Unit, instances);
    }

    private sealed record ModelPart(XElement Model, string Unit, double Scale, Dictionary<int, XElement> Resources);

    private static string ResolveRelationship(string owner, string target)
    {
        var decoded = Uri.UnescapeDataString(target);
        if (decoded.StartsWith("//") || decoded.Any(char.IsControl) || decoded.Contains('\\') || decoded.Contains(':') || decoded.Contains('?') || decoded.Contains('#'))
            throw Invalid("3MF 模型关系必须指向包内文件");
        var segments = new List<string>();
        var full = decoded.StartsWith('/') ? decoded[1..] : owner[..(owner.LastIndexOf('/') + 1)] + decoded;
        foreach (var segment in full.Split('/'))
        {
            if (segment == ".") continue;
            if (segment == "..")
            {
                if (segments.Count == 0) throw Invalid("3MF 模型关系越过包根目录");
                segments.RemoveAt(segments.Count - 1);
            }
            else if (segment.Length == 0) throw Invalid("3MF 模型关系路径无效");
            else segments.Add(segment);
        }
        if (segments.Count == 0) throw Invalid("3MF 模型关系路径无效");
        return string.Join('/', segments);
    }

    private static string PackagePath(string value)
    {
        var decoded = Uri.UnescapeDataString(value);
        var path = decoded.StartsWith('/') ? decoded[1..] : decoded;
        if (path.Length == 0 || decoded.StartsWith("//") || path.Any(char.IsControl) || path.Contains('\\') || path.Contains(':') || path.Contains('#') || path.Contains('?') ||
            path.Split('/').Any(p => p is "" or "." or "..")) throw Invalid("3MF 包内路径不合法");
        return path;
    }

    private static int Index(string? text) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value >= 0
            ? value : throw Invalid("3MF 索引无效");

    private static double[] Matrix(XElement item)
    {
        var text = (string?)item.Attribute("transform");
        if (text is null) return Identity;
        var matrix = WhiteSpace().Split(text.Trim()).Select(Number).ToArray();
        if (matrix.Length != 12) throw Invalid("3MF 变换矩阵必须包含 12 个有限数值");
        return matrix;
    }

    private static double[] Multiply(double[] a, double[] b)
    {
        var result = new double[12];
        for (var row = 0; row < 4; row++)
            for (var column = 0; column < 3; column++)
                result[row * 3 + column] = a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] +
                    a[row * 3 + 2] * b[6 + column] + (row == 3 ? b[9 + column] : 0);
        return result;
    }
}
