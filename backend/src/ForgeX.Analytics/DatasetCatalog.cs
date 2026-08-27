using System.Text.Json.Serialization;

namespace ForgeX.Analytics;

/// <summary>
/// 数据来源标记契约（经典 D.PROVENANCE 的单一真源迁移）。
/// 键序与字段序必须与经典对象字面量一致：Node 侧会对该对象做 JSON.stringify
/// 并卷入数据源去重的 cacheKey——键序漂移等于所有既有数据源全部失去去重命中。
/// seed 与 generator 为 null 时也必须输出键（JsonIgnoreCondition.Never）。
/// </summary>
public sealed record DatasetGenerator(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int Version,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] long? Seed);

public sealed record DatasetProvenance(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string Source,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] bool Synthetic,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string Badge,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string Note,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DatasetGenerator? Generator);

public static class DatasetCatalog
{
    public const int MinSample = AnalyticsStatistics.DefaultMinSample;

    public static DatasetProvenance Farm { get; } = new(
        "sim-farm",
        true,
        "机群仿真",
        "由虚拟机群物理仿真产出：8 台机器各有确定性的固有物理特征（热端积碳、送料咬合力、" +
        "加热器功率、环境温度…），故障是这些特征与本单工艺参数相互作用的结果，" +
        "没有任何一台机器被预先指定过故障率。非真实产线数据，但结论可被证伪。",
        new DatasetGenerator("tools/farm-sim.js", 1, 20260726));

    public static DatasetProvenance Sample { get; } = new(
        "synthetic",
        true,
        "合成",
        "概率生成的演示数据，含预先写死的故事线（03 号机高故障率、ABS×悬垂件高失败）。" +
        "从中得出的结论只是生成参数的回显，不适用于任何真实设备。保留仅为回归测试的确定性输入。",
        new DatasetGenerator("FXInsightData.generateSample", 1, 20260721));

    public static DatasetProvenance Upload { get; } = new(
        "user-upload",
        false,
        "",
        "用户上传的 CSV。",
        null);

    public static DatasetProvenance Sim { get; } = new(
        "simulator",
        true,
        "仿真",
        "由本机仿真器的物理过程产出（温控惯性、床面误差场、机构负载、成品判废），" +
        "是真实计算结果但非真实产线数据。故障不是抽样出来的：" +
        "每台机器有确定性的固有物理特征，故障是这些特征与本单工艺参数相互作用的结果。",
        new DatasetGenerator("FXSim", 2, null));

    public static DatasetProvenance SimFarm { get; } = new(
        "sim-farm",
        true,
        "机群仿真",
        "由虚拟机群（tools/farm-sim.js）批量物理仿真产出。多台机器各有固有物理特征，" +
        "失败与故障类型完全由物理演化决定，仅排产（派给哪台机、用什么材料参数）使用随机。" +
        "同一 seed 完全可复现。",
        new DatasetGenerator("tools/farm-sim.js", 1, null));

    /// <summary>目录键与经典 D.PROVENANCE 完全一致（含 "sim-farm" 连字符键）。</summary>
    public static IReadOnlyDictionary<string, DatasetProvenance> All { get; } =
        new Dictionary<string, DatasetProvenance>(StringComparer.Ordinal)
        {
            ["farm"] = Farm,
            ["sample"] = Sample,
            ["upload"] = Upload,
            ["sim"] = Sim,
            ["sim-farm"] = SimFarm,
        };
}
