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

  return {
    format: "forgex-stage4-analytics-golden",
    schemaVersion: 1,
    baselineVersion: "0.19.0-stage4-a",
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
    `${current.fisherCases.length} Fisher + 1 ranking + ${current.csvLimitCase.input.rowCount} row limit + ` +
    `${current.dataset.expected.rowCount} dataset rows\n`
);
