// Stage 2 渐进迁移边界：只有本文件读取 legacy FX* 全局，React 侧只消费严格类型接口。
import "../../../js/util.js";
import "../../../js/stats-kernel.js";
import "../../../js/insight-data.js";
import "../../../js/farm-dataset.js";
import "../../../js/insight-engine.js";

const data = globalThis.FXInsightData;
const engine = globalThis.FXInsightEngine;
const farm = globalThis.FXFarmDataset;

function provenance(base, datasetKey, rowCount) {
  return {
    source: base.source,
    synthetic: base.synthetic,
    badge: base.badge,
    note: base.note,
    generator: base.generator,
    datasetKey,
    rowCount,
  };
}

export const legacyAnalytics = {
  builtInDatasets() {
    const physicalRows = farm.rows();
    const syntheticRows = data.generateSample(96);
    return [
      {
        id: "physical-farm-v1",
        label: "物理机群仿真",
        kind: "physical-simulation",
        description: "400 个固定种子任务；故障由虚拟机台物理特征与工艺参数共同演化。",
        rows: physicalRows,
        provenance: provenance(data.PROVENANCE.farm, "physical-farm-v1", physicalRows.length),
        warnings: [],
      },
      {
        id: "synthetic-demo-v1",
        label: "概率合成演示",
        kind: "synthetic-demo",
        description: "96 个确定性演示任务；包含预先写入的机台与材料故事线，仅用于 UI 与回归。",
        rows: syntheticRows,
        provenance: provenance(data.PROVENANCE.sample, "synthetic-demo-v1", syntheticRows.length),
        warnings: [],
      },
    ];
  },
  parseCsv(text) {
    return data.parseCsv(text);
  },
  toCsv(rows) {
    return data.toCsv(rows);
  },
  kpis(rows) {
    return engine.kpis(rows);
  },
  analyze(question, rows, options) {
    return engine.analyze(question, rows, options);
  },
  supportedDimensions: engine.SUPPORTED.slice(),
};
