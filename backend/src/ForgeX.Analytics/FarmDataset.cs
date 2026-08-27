using System.Text;

namespace ForgeX.Analytics;

/// <summary>
/// 内置机群仿真数据集。CSV 以嵌入资源承载，其字节与经典 `farm-dataset.js` 内嵌文本
/// 完全一致（LF 行尾、无 BOM、无结尾换行）——Node 侧对该文本做 SHA-256 生成内置
/// 数据源指纹，任何一个字节的漂移都会让「内置数据集」在迁移瞬间变成「新数据集」。
/// </summary>
public static class FarmDataset
{
    private const string ResourceName = "ForgeX.Analytics.Resources.farm-dataset.csv";

    private static readonly Lazy<string> LazyCsv = new(LoadCsv, LazyThreadSafetyMode.ExecutionAndPublication);
    private static readonly Lazy<IReadOnlyList<RawRow>> LazyRows =
        new(static () => RawDatasetCsv.Parse(LazyCsv.Value).Rows, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string Csv => LazyCsv.Value;

    /// <summary>与经典 FXFarmDataset.rows() 同口径：parseCsv(csv).rows（惰性，只算一次）。</summary>
    public static IReadOnlyList<RawRow> Rows => LazyRows.Value;

    public static DatasetProvenance Provenance => DatasetCatalog.Farm;

    private static string LoadCsv()
    {
        using var stream = typeof(FarmDataset).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource {ResourceName} is missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var text = reader.ReadToEnd();
        // 防御：若构建/检出环节改写了行尾或加了 BOM，这里恢复权威字节形态。
        if (text.StartsWith('\uFEFF')) text = text[1..];
        return text.Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
