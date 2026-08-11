"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const goldenPath = path.join(root, "tests", "golden", "stage4-analytics-golden.json");
const datasetPath = path.join(root, "datasets", "print_farm_400.csv");
const sourcePaths = ["js/stats-kernel.js", "js/insight-data.js", "js/insight-engine.js"];

require(path.join(root, "js", "util.js"));
require(path.join(root, "js", "stats-kernel.js"));
require(path.join(root, "js", "insight-data.js"));
require(path.join(root, "js", "insight-engine.js"));

const stats = globalThis.FXStats;
const data = globalThis.FXInsightData;
const engine = globalThis.FXInsightEngine;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function createGolden() {
  const datasetBytes = fs.readFileSync(datasetPath);
  const dataset = data.parseCsv(datasetBytes.toString("utf8"));
  const csvCases = [
    {
      id: "english-alias-invalid-number",
      input:
        'machine,status,duration,cost_cny,fail_reason\n"M-1",completed,12.5,1.23,""\n"M-2",failed,bad,2.00,"堵,料"\n',
    },
    {
      id: "chinese-bom-and-status",
      input:
        "\uFEFF机台,材料,状态,层高,成本元,故障类型\r\nFX-01,PLA,成功,0.2,1.05,\r\nFX-02,ABS,故障,0.28,2.5,翘边\r\n",
    },
    {
      id: "missing-dimension",
      input: "status,duration_min\nsuccess,10\n",
    },
    {
      id: "overflow-and-js-rounding",
      input: "machine,status,duration,cost_cny\nM-1,success,1e999,-0.005\nM-2,success,10,-0.005\n",
    },
  ].map((item) => ({ ...item, expected: data.parseCsv(item.input) }));
  const wilsonInputs = [
    { k: 0, n: 0, confidence: 0.95 },
    { k: 0, n: 10, confidence: 0.95 },
    { k: 6, n: 20, confidence: 0.95 },
    { k: 10, n: 10, confidence: 0.95 },
    { k: 31, n: 100, confidence: 0.99 },
  ];
  const fisherInputs = [
    { a: 3, b: 1, c: 1, d: 3 },
    { a: 0, b: 5, c: 5, d: 0 },
    { a: 10, b: 20, c: 5, d: 25 },
    { a: 0, b: 0, c: 0, d: 0 },
  ];
  const pearsonInputs = [
    {
      id: "perfect-positive",
      pairs: [
        [1, 2],
        [2, 4],
        [3, 6],
        [4, 8],
        [5, 10],
      ],
      options: {},
    },
    {
      id: "perfect-negative",
      pairs: [
        [1, 10],
        [2, 8],
        [3, 6],
        [4, 4],
        [5, 2],
      ],
      options: {},
    },
    {
      id: "weak-noise",
      pairs: Array.from({ length: 40 }, (_, index) => [index, (index * 7919) % 13]),
      options: {},
    },
    {
      id: "zero-variance",
      pairs: [
        [5, 1],
        [5, 2],
        [5, 3],
        [5, 4],
        [5, 5],
      ],
      options: {},
    },
    {
      id: "df-disabled",
      pairs: [
        [1, 1],
        [2, 4],
        [3, 2],
        [4, 5],
      ],
      options: { df: 0, alpha: 0.01 },
    },
    {
      id: "insufficient",
      pairs: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      options: {},
    },
  ];
  const simpsonRows = [
    { g: "A", x: 1, y: 10 },
    { g: "A", x: 2, y: 9 },
    { g: "A", x: 3, y: 8 },
    { g: "B", x: 4, y: 20 },
    { g: "B", x: 5, y: 19 },
    { g: "B", x: 6, y: 18 },
  ];
  const partialInputs = [
    {
      id: "simpson-control",
      rows: simpsonRows,
      xKey: "x",
      yKey: "y",
      controlKeys: ["g"],
    },
    {
      id: "singleton-and-invalid",
      rows: simpsonRows.concat([
        { g: "C", x: 99, y: 99 },
        { g: "A", x: "bad", y: 12 },
      ]),
      xKey: "x",
      yKey: "y",
      controlKeys: ["g"],
    },
    {
      id: "two-controls",
      rows: [
        { g: "A", model: "X", x: 1, y: 9 },
        { g: "A", model: "X", x: 2, y: 7 },
        { g: "A", model: "X", x: 3, y: 5 },
        { g: "B", model: "Y", x: 5, y: 20 },
        { g: "B", model: "Y", x: 6, y: 18 },
        { g: "B", model: "Y", x: 7, y: 16 },
      ],
      xKey: "x",
      yKey: "y",
      controlKeys: ["g", "model"],
    },
    {
      id: "insufficient",
      rows: [{ g: "A", x: 1, y: 1 }],
      xKey: "x",
      yKey: "y",
      controlKeys: ["g"],
    },
  ];
  const mannKendallInputs = [
    { id: "strict-up", series: [1, 2, 3, 4, 5, 6, 7, 8], options: {} },
    { id: "strict-down", series: [8, 7, 6, 5, 4, 3, 2, 1], options: {} },
    { id: "all-tied", series: [5, 5, 5, 5, 5, 5], options: {} },
    { id: "wobble", series: [10, 12, 9, 11, 10, 12, 9, 11, 10, 12], options: {} },
    { id: "ties-corrected", series: [1, 1, 2, 2, 3, 3, 4, 4], options: {} },
    { id: "strict-alpha", series: [1, 2, 3, 4, 5, 6], options: { alpha: 0.001 } },
    { id: "insufficient", series: [1, 2, 3], options: {} },
  ];
  const rankGroups = [
    { key: "A", k: 15, n: 49 },
    { key: "B", k: 13, n: 45 },
    { key: "tiny", k: 1, n: 2 },
  ];
  const source = Buffer.concat(sourcePaths.map((relative) => fs.readFileSync(path.join(root, relative))));
  const limitRowCount = 5001;
  const limitInput = [
    "machine_id,status,duration_min",
    ...Array.from({ length: limitRowCount }, (_, index) => `M-${index % 2},success,${index + 1}`),
  ].join("\n");
  const limitResult = data.parseCsv(limitInput);
  const reportCases = [
    {
      id: "farm-machine-fault-report",
      input: {
        question: "哪台机台故障率最高，需要优先保养？",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "farm-material-comparison-report",
      input: {
        question: "PLA、PETG、ABS、TPU 材料失败率对比差多少？",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "farm-correlation-report",
      input: {
        question: "层高与打印时长的相关性如何？",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "farm-failure-root-report",
      input: {
        question: "失败批次有什么共性，主要原因如何归因？",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "farm-overview-unmatched-report",
      input: {
        question: "请总结一下当前情况",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "farm-cost-trend-report",
      input: {
        question: "本月单件成本与耗材成本趋势如何？",
        datasetPath: "datasets/print_farm_400.csv",
        provenance: null,
      },
      rows: dataset.rows,
    },
    {
      id: "correlation-insufficient-report",
      input: {
        question: "层高和时长关系",
        csv:
          "date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,energy_kwh\n" +
          "2026-08-01,M-1,齿轮,PLA,0.20,10,2,20,success,0.1\n" +
          "2026-08-02,M-1,齿轮,PLA,0.24,9,2,20,success,0.1\n" +
          "2026-08-03,M-1,齿轮,PLA,0.28,8,2,20,success,0.1\n",
        provenance: null,
      },
    },
    {
      id: "cost-short-range-report",
      input: {
        question: "成本趋势",
        csv:
          "date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,energy_kwh\n" +
          "2026-08-01,M-1,齿轮,PLA,0.20,10,2,20,success,0.1\n" +
          "2026-08-02,M-1,齿轮,PETG,0.20,10,2,30,success,0.1\n" +
          "2026-08-03,M-1,齿轮,ABS,0.20,10,2,25,success,0.1\n",
        provenance: null,
      },
    },
    {
      id: "machine-insufficient-report",
      input: {
        question: "机台故障率排行",
        csv:
          "machine_id,model_name,material,status,fail_reason,cost_fen\n" +
          "M-A,齿轮,PLA,fail,堵料,20\n" +
          "M-A,齿轮,PLA,success,,20\n" +
          "M-B,叶轮,PETG,success,,30\n" +
          "M-B,叶轮,PETG,fail,翘边,30\n",
        provenance: null,
      },
    },
    {
      id: "machine-nonsignificant-report",
      input: {
        question: "哪台机器故障率最高",
        csv:
          "machine_id,model_name,material,status,fail_reason,cost_fen\n" +
          "M-A,齿轮,PLA,fail,堵料,20\n" +
          "M-A,齿轮,PLA,fail,断料,20\n" +
          "M-A,齿轮,PLA,success,,20\n" +
          "M-A,齿轮,PLA,success,,20\n" +
          "M-A,齿轮,PLA,success,,20\n" +
          "M-B,叶轮,PETG,fail,翘边,30\n" +
          "M-B,叶轮,PETG,success,,30\n" +
          "M-B,叶轮,PETG,success,,30\n" +
          "M-B,叶轮,PETG,success,,30\n" +
          "M-B,叶轮,PETG,success,,30\n",
        provenance: null,
      },
    },
    {
      id: "material-insufficient-report",
      input: {
        question: "材料失败率对比",
        csv:
          "machine_id,model_name,material,status,fail_reason,cost_fen\n" +
          "M-A,齿轮,PLA,fail,堵料,20\n" +
          "M-A,齿轮,PLA,success,,20\n" +
          "M-B,叶轮,PETG,success,,30\n" +
          "M-B,叶轮,PETG,fail,翘边,30\n",
        provenance: null,
      },
    },
    {
      id: "failure-root-no-failures-report",
      input: {
        question: "失败原因归因",
        csv:
          "machine_id,model_name,material,status,cost_fen\n" +
          "M-A,齿轮,PLA,success,20\n" +
          "M-A,齿轮,PLA,success,20\n" +
          "M-A,齿轮,PLA,success,20\n" +
          "M-A,齿轮,PLA,success,20\n" +
          "M-A,齿轮,PLA,success,20\n",
        provenance: null,
      },
    },
  ].map((item) => {
    const rows = item.rows || data.parseCsv(item.input.csv).rows;
    return {
      id: item.id,
      input: item.input,
      expected: engine.analyze(item.input.question, rows, { provenance: item.input.provenance }),
    };
  });

  return {
    format: "forgex-stage4-analytics-golden",
    schemaVersion: 1,
    baselineVersion: "0.19.0-stage4-d",
    tolerance: { numericAbs: 1e-9, numericRel: 1e-9 },
    engine: {
      name: "legacy-js-statistics",
      sourcePaths,
      sourceSha256: sha256(source),
    },
    csvCases,
    csvLimitCase: {
      input: { rowCount: limitRowCount },
      expected: { rowCount: limitResult.rows.length, errors: limitResult.errors },
    },
    wilsonCases: wilsonInputs.map((input) => ({ input, expected: stats.wilson(input.k, input.n, input.confidence) })),
    fisherCases: fisherInputs.map((input) => ({
      input,
      expected: stats.fisherExact(input.a, input.b, input.c, input.d),
    })),
    pearsonCases: pearsonInputs.map((input) => ({
      input,
      expected: stats.pearson(input.pairs, input.options),
    })),
    partialCorrelationCases: partialInputs.map((input) => ({
      input,
      expected: stats.partialCorrelation(input.rows, input.xKey, input.yKey, input.controlKeys),
    })),
    mannKendallCases: mannKendallInputs.map((input) => ({
      input,
      expected: stats.mannKendall(input.series, input.options),
    })),
    reportCases,
    rankCase: {
      input: { groups: rankGroups, minSample: 5, alpha: 0.05 },
      expected: stats.rankByRate(rankGroups, { minSample: 5, alpha: 0.05 }),
    },
    dataset: {
      path: "datasets/print_farm_400.csv",
      sha256: sha256(datasetBytes),
      expected: {
        rowCount: dataset.rows.length,
        errors: dataset.errors,
        kpis: engine.kpis(dataset.rows),
      },
    },
  };
}

const current = canonical(createGolden());
if (process.argv.includes("--write")) {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(`Stage 4 analytics golden written: ${path.relative(root, goldenPath)}\n`);
  process.exit(0);
}

if (!fs.existsSync(goldenPath)) {
  process.stderr.write("Stage 4 analytics golden is missing; run with --write after review.\n");
  process.exit(1);
}
const frozen = canonical(JSON.parse(fs.readFileSync(goldenPath, "utf8")));
const expectedText = JSON.stringify(frozen);
const actualText = JSON.stringify(current);
if (expectedText !== actualText) {
  process.stderr.write("Stage 4 analytics golden drifted; inspect the JS behavior before an explicit --write.\n");
  process.exit(1);
}
process.stdout.write(
  `Stage 4 analytics golden OK: ${current.csvCases.length} CSV + ${current.wilsonCases.length} Wilson + ` +
    `${current.fisherCases.length} Fisher + ${current.pearsonCases.length} Pearson + ` +
    `${current.partialCorrelationCases.length} partial + ${current.mannKendallCases.length} Mann-Kendall + ` +
    `${current.reportCases.length} reports + 1 ranking + ${current.csvLimitCase.input.rowCount} row limit + ` +
    `${current.dataset.expected.rowCount} dataset rows\n`
);
