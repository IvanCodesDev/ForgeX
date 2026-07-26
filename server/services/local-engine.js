/* 复用前端纯逻辑模块（util / insight-data / insight-engine）作为后端演示分析引擎。
   前端模块挂载到 globalThis，与 tests/insight.test.js 的加载方式一致——
   单一真源：解析/聚合/报告逻辑只维护一份，后端 mock 与前端本地引擎永不漂移。 */
"use strict";
const path = require("path");

const JS = (p) => path.join(__dirname, "..", "..", "js", p);
require(JS("util.js"));
require(JS("farm-dataset.js"));   // 内置机群仿真数据集（须在 insight-data 之前，Store 构造要用）
require(JS("insight-data.js"));
require(JS("stats-kernel.js"));   // 统计核（insight-engine 依赖）
require(JS("insight-engine.js"));

const D = globalThis.FXInsightData;
const E = globalThis.FXInsightEngine;
const FARM = globalThis.FXFarmDataset;

module.exports = {
  FIELDS: D.FIELDS,
  PROVENANCE: D.PROVENANCE,
  MIN_SAMPLE: E.MIN_SAMPLE,
  stats: globalThis.FXStats,
  parseCsv: (text) => D.parseCsv(text),
  toCsv: (rows) => D.toCsv(rows),
  /** 内置数据集：物理仿真产出的机群数据（不是概率合成） */
  farmRows: () => FARM.rows(),
  farmCsv: () => FARM.csv,
  /** 概率合成数据，仅保留给回归测试作确定性输入 */
  generateSample: (n) => D.generateSample(n),
  analyze: (question, rows, opts) => E.analyze(question, rows, opts),
};
