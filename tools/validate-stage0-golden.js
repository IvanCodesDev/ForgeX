/* 生成/验证阶段 0 的 24 组代表性黄金样例。
   更新必须显式执行 `npm run golden:update`，普通测试只比较，不覆盖 expected。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "tests", "golden", "stage0-golden.json");
const WRITE = process.argv.includes("--write");

require(path.join(ROOT, "js", "util.js"));
require(path.join(ROOT, "js", "slicer.js"));
require(path.join(ROOT, "js", "models.js"));
require(path.join(ROOT, "js", "gcode-parser.js"));
const engine = require(path.join(ROOT, "server", "services", "local-engine.js"));

const Slicer = globalThis.FXSlicer;
const Models = globalThis.FXModels;
const Gcode = globalThis.FXGcodeParser;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha(rel) {
  return sha256(fs.readFileSync(path.join(ROOT, rel)));
}

function rounded(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = rounded(value[key]);
    return out;
  }
  return value;
}

const BASE_SETTINGS = {
  material: "PLA",
  layerHeight: 0.2,
  extrusionWidth: 0.45,
  perimeters: 2,
  solidLayers: 3,
  infillDensity: 0.18,
  nozzleTemp: 210,
  bedTemp: 60,
  speed: 120,
  travelSpeed: 260,
  retraction: 1.2,
  fanSpeed: 100,
  supportEnabled: true,
  supportSpacing: 4.5,
  skirtLoops: 2,
  skirtGap: 5,
  zOffset: 0,
  autoLevel: true,
};

const SLICE_PROFILES = [
  {
    id: "draft-pla",
    materialProfile: "PLA-default",
    changes: { layerHeight: 0.28, infillDensity: 0.12, supportEnabled: false, speed: 150 },
  },
  { id: "standard-pla", materialProfile: "PLA-default", changes: {} },
  {
    id: "durable-abs",
    materialProfile: "ABS-default",
    changes: { material: "ABS", infillDensity: 0.3, nozzleTemp: 250, bedTemp: 100, speed: 90 },
  },
  {
    id: "detail-petg",
    materialProfile: "PETG-default",
    changes: { material: "PETG", layerHeight: 0.12, infillDensity: 0.25, nozzleTemp: 240, bedTemp: 75, speed: 70 },
  },
];

const GCODE_FIXTURES = [
  {
    id: "cura-marlin",
    path: "contracts/validation/fixtures/cura-marlin.gcode",
    machineProfile: "FX-256",
    firmware: "Marlin",
    bedSize: 256,
    origin: "corner",
  },
  {
    id: "orca-klipper",
    path: "contracts/validation/fixtures/orca-klipper.gcode",
    machineProfile: "FX-256",
    firmware: "Klipper",
    bedSize: 256,
    origin: "corner",
  },
  {
    id: "prusa-marlin",
    path: "contracts/validation/fixtures/prusa-marlin.gcode",
    machineProfile: "FX-220",
    firmware: "Marlin",
    bedSize: 220,
    origin: "corner",
  },
  {
    id: "superslicer-rrf",
    path: "contracts/validation/fixtures/superslicer-rrf.gcode",
    machineProfile: "FX-500",
    firmware: "RepRapFirmware",
    bedSize: 500,
    origin: "corner",
  },
];

const ANALYSIS_CASES = [
  { id: "machine-fault", question: "哪台机故障率最高，主要故障是什么" },
  { id: "material-compare", question: "不同材料失败率对比" },
  { id: "layer-correlation", question: "层高与打印时长的相关性" },
  { id: "cost-trend", question: "成本趋势与失败损耗" },
];

function compactReport(report) {
  return rounded({
    schemaVersion: report.schemaVersion,
    intent: report.intent,
    intentMatched: report.intentMatched,
    title: report.title,
    verdict: report.verdict,
    confidence: report.confidence,
    rowCount: report.rowCount,
    chart: report.chart,
    highlight: report.highlight,
    evidence: report.evidence,
  });
}

function build() {
  const cases = [];
  const transform = { scale: 1, rotZ: 0, offX: 0, offY: 0 };
  for (const model of Models.createBuiltins()) {
    for (const profile of SLICE_PROFILES) {
      const settings = Object.assign({}, BASE_SETTINGS, profile.changes);
      const input = { modelId: model.id, transform, settings };
      const result = Slicer.slice(model, transform, settings);
      cases.push({
        id: "slice-" + model.id + "-" + profile.id,
        category: "slicing",
        input: { type: "builtin-model-settings", sha256: sha256(canonical(input)), value: input },
        machineProfile: "FX-256",
        materialProfile: profile.materialProfile,
        firmware: "preview-engine",
        tolerance: { numericAbs: 0.000001, numericRel: 0.000001 },
        expected: rounded({ totalLayers: result.totalLayers, height: result.height, stats: result.stats }),
      });
    }
  }

  for (const fixture of GCODE_FIXTURES) {
    const text = fs.readFileSync(path.join(ROOT, fixture.path), "utf8");
    for (const material of [
      { id: "PLA-default", densityG: 1.24 },
      { id: "PETG-default", densityG: 1.27 },
    ]) {
      const parsed = Gcode.parse(text, {
        bedSize: fixture.bedSize,
        origin: fixture.origin,
        densityG: material.densityG,
      });
      const pathTypes = Array.from(
        new Set(parsed.layers.flatMap((layer) => layer.paths.map((item) => item.type)))
      ).sort();
      cases.push({
        id: "gcode-" + fixture.id + "-" + material.id.toLowerCase(),
        category: "gcode",
        input: { type: "file", path: fixture.path, sha256: fileSha(fixture.path) },
        machineProfile: fixture.machineProfile,
        materialProfile: material.id,
        firmware: fixture.firmware,
        parameters: { bedSize: fixture.bedSize, origin: fixture.origin, densityG: material.densityG },
        tolerance: { numericAbs: 0.000001, numericRel: 0.000001 },
        expected: rounded({
          totalLayers: parsed.totalLayers,
          height: parsed.height,
          stats: parsed.stats,
          coordinateOrigin: parsed.coordinateOrigin,
          bounds: parsed.bounds,
          warnings: parsed.warnings,
          claims: parsed.claims,
          pathTypes,
        }),
      });
    }
  }

  const rows = engine.farmRows();
  const datasetSha256 = sha256(engine.toCsv(rows));
  for (const item of ANALYSIS_CASES) {
    const report = engine.analyze(item.question, rows, { provenance: engine.PROVENANCE.farm });
    cases.push({
      id: "analysis-" + item.id,
      category: "analysis",
      input: {
        type: "question-dataset",
        sha256: sha256(canonical({ question: item.question, datasetSha256 })),
        question: item.question,
        datasetSha256,
      },
      machineProfile: "sim-farm-v1",
      materialProfile: "mixed-farm-materials",
      firmware: "mixed-farm-firmware",
      tolerance: { numericAbs: 0.000001, numericRel: 0.000001 },
      expected: compactReport(report),
    });
  }

  const engineFiles = [
    "js/slicer.js",
    "js/models.js",
    "js/gcode-parser.js",
    "js/insight-engine.js",
    "js/stats-kernel.js",
  ];
  return {
    format: "forgex-stage0-golden-set",
    version: 1,
    capturedAt: "2026-08-10",
    baselineEngineVersion: "0.19.0-stage0",
    approvedBy: "workspace-owner-directed-baseline",
    updatePolicy: "不得在测试失败时覆盖；仅在解释算法/契约变化后显式运行 golden:update。",
    engineSourceSha256: sha256(engineFiles.map((rel) => rel + ":" + fileSha(rel)).join("\n")),
    caseCount: cases.length,
    cases,
  };
}

const generated = build();
if (generated.caseCount < 20 || generated.caseCount > 30) {
  throw new Error("Golden case count must be 20-30, got " + generated.caseCount);
}

if (WRITE) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(generated, null, 2) + "\n", "utf8");
  console.log("Golden baseline written: " + path.relative(ROOT, OUTPUT) + " (" + generated.caseCount + " cases)");
} else {
  const committed = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
  if (canonical(committed) !== canonical(generated)) {
    console.error(
      "Stage 0 golden baseline differs. Review the algorithm/contract change before running npm run golden:update."
    );
    process.exit(1);
  }
  console.log("Stage 0 golden baseline OK: " + generated.caseCount + " cases");
}
