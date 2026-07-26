/* 复用前端纯逻辑模块（util / insight-data / insight-engine）作为后端演示分析引擎。
   前端模块挂载到 globalThis，与 tests/insight.test.js 的加载方式一致——
   单一真源：解析/聚合/报告逻辑只维护一份，后端 mock 与前端本地引擎永不漂移。 */
"use strict";
const path = require("path");

const JS = (p) => path.join(__dirname, "..", "..", "js", p);
require(JS("util.js"));
require(JS("insight-data.js"));
require(JS("insight-engine.js"));

const D = globalThis.FXInsightData;
const E = globalThis.FXInsightEngine;

module.exports = {
  FIELDS: D.FIELDS,
  PROVENANCE: D.PROVENANCE,
  MIN_SAMPLE: E.MIN_SAMPLE,
  parseCsv: (text) => D.parseCsv(text),
  toCsv: (rows) => D.toCsv(rows),
  generateSample: (n) => D.generateSample(n),
  analyze: (question, rows, opts) => E.analyze(question, rows, opts),
};
