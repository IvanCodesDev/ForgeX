/* P6 方言夹具、配对日志与时间校准报告校验。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_REL = "validation/fixture-manifest.json";
const REPORT_REL = "validation/time-calibration-report.json";
const WRITE_REPORT = process.argv.includes("--write-report");

require(path.join(ROOT, "js", "gcode-parser.js"));
require(path.join(ROOT, "js", "machine-log.js"));
require(path.join(ROOT, "js", "time-calibration.js"));
const Gcode = globalThis.FXGcodeParser;
const MachineLog = globalThis.FXMachineLog;
const Calibration = globalThis.FXTimeCalibration;

let passed = 0;
let failed = 0;
function report(ok, message, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}${detail ? " — " + detail : ""}`);
  }
}
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}
function insideRoot(rel) {
  const full = path.resolve(ROOT, String(rel || ""));
  return full.startsWith(ROOT + path.sep) ? full : null;
}
function sha256File(full) {
  return crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}
function roundDeep(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = roundDeep(value[key]);
    return out;
  }
  return value;
}

console.log("\n[P6 validation] Contracts");
try {
  report(!!readJson("validation/fixture-manifest.schema.json"), "fixture manifest schema 是有效 JSON");
} catch (e) {
  report(false, "fixture manifest schema 是有效 JSON", e.message);
}

let manifest;
try {
  manifest = readJson(MANIFEST_REL);
  report(
    manifest.format === "forgex-validation-fixture-set" &&
      manifest.version === 1 &&
      Array.isArray(manifest.fixtures) &&
      manifest.fixtures.length >= 4,
    "fixture manifest 满足 v1 最小契约"
  );
  report(
    ["synthetic-conformance", "real-anonymized", "real-consented"].includes(manifest.provenance),
    "fixture set 声明允许的 provenance"
  );
  report(typeof manifest.disclaimer === "string" && manifest.disclaimer.length >= 20, "fixture set 带真实性边界");
} catch (e) {
  report(false, "fixture manifest 可读取", e.message);
  console.log(`\n═══ P6 夹具校验：${passed} 通过 / ${failed} 失败 ═══`);
  process.exit(1);
}

const seen = new Set();
const training = [];
const holdout = [];
const summaries = [];

console.log("\n[P6 validation] Fixture pairs");
for (const fixture of manifest.fixtures) {
  const id = fixture.id || "(missing-id)";
  report(!seen.has(id), `${id} ID 唯一`);
  seen.add(id);
  const provenanceOk =
    ["synthetic-conformance", "real-anonymized", "real-consented"].includes(fixture.provenance) &&
    typeof fixture.source === "string" &&
    fixture.source.length >= 20;
  report(provenanceOk, `${id} 来源声明完整`);

  const gEntry = fixture.files && fixture.files.gcode;
  const lEntry = fixture.files && fixture.files.machineLog;
  const gPath = gEntry && insideRoot(gEntry.path);
  const lPath = lEntry && insideRoot(lEntry.path);
  report(!!gPath && fs.existsSync(gPath), `${id} G-code 位于仓库内`);
  report(!!lPath && fs.existsSync(lPath), `${id} 真机日志位于仓库内`);
  if (!gPath || !lPath || !fs.existsSync(gPath) || !fs.existsSync(lPath)) continue;

  const gHash = sha256File(gPath);
  const lHash = sha256File(lPath);
  report(gHash === gEntry.sha256, `${id} G-code SHA-256 匹配`);
  report(lHash === lEntry.sha256, `${id} 日志 SHA-256 匹配`);

  let parsed;
  let log;
  try {
    parsed = Gcode.parse(fs.readFileSync(gPath, "utf8"), {
      bedSize: fixture.bedSize,
      origin: fixture.origin,
    });
    log = MachineLog.parse(fs.readFileSync(lPath, "utf8"), {
      name: path.basename(lPath),
    });
    report(true, `${id} G-code 与日志均可解析`);
  } catch (e) {
    report(false, `${id} G-code 与日志均可解析`, e.message);
    continue;
  }

  const exp = fixture.expectations || {};
  const types = new Set(parsed.layers.flatMap((layer) => layer.paths.map((p) => p.type)));
  report(parsed.totalLayers === exp.layers, `${id} 层数契约匹配`);
  report(
    Math.abs(parsed.stats.filamentM * 1000 - exp.filamentMm) <= Math.max(0.001, exp.filamentMm * 0.001),
    `${id} 耗材契约匹配`
  );
  report(Array.isArray(exp.pathTypes) && exp.pathTypes.every((type) => types.has(type)), `${id} 路径类型契约匹配`);
  report(
    parsed.claims.slicer && parsed.claims.slicer.toLowerCase().includes(fixture.slicer.split(" ")[0].toLowerCase()),
    `${id} 切片器声明匹配`
  );
  report(log.gcodeSha256 === gHash, `${id} 日志绑定同一 G-code 哈希`);
  report(log.machineId === fixture.machineId && log.firmware === fixture.firmware, `${id} 机型与固件元数据匹配`);

  const pair = Calibration.fromPair(parsed, log, {
    id,
    machineId: fixture.machineId,
    firmware: fixture.firmware,
  });
  if (fixture.calibrationRole === "training") training.push(pair);
  else if (fixture.calibrationRole === "holdout") holdout.push(pair);
  else report(false, `${id} calibrationRole 合法`);
  summaries.push({
    id,
    role: fixture.calibrationRole,
    slicer: fixture.slicer,
    firmware: fixture.firmware,
    plannedTimeSec: pair.plannedTimeSec,
    actualTimeSec: pair.actualTimeSec,
  });
}

console.log("\n[P6 validation] Calibration");
let generated = null;
try {
  report(training.length >= Calibration.MIN_SAMPLES, "训练集至少三个不同时长的配对任务");
  report(holdout.length > 0, "至少保留一个未参与拟合的 holdout");
  const model = Calibration.fit(training, manifest.calibrationScope || {});
  const holdoutMetrics = Calibration.evaluate(model, holdout);
  generated = roundDeep({
    format: "forgex-time-calibration-report",
    version: 1,
    sourceManifest: MANIFEST_REL,
    provenance: manifest.provenance,
    disclaimer: manifest.disclaimer,
    fixtures: summaries,
    model,
    holdoutMetrics,
  });
  report(model.motionScale > 0 && model.fixedOverheadSec >= 0, "校准模型参数有效");
  report(Number.isFinite(holdoutMetrics.mape), "holdout 指标可计算");
} catch (e) {
  report(false, "时间模型可拟合并评估", e.message);
}

if (generated) {
  const reportPath = path.join(ROOT, REPORT_REL);
  if (WRITE_REPORT) {
    fs.writeFileSync(reportPath, JSON.stringify(generated, null, 2) + "\n", "utf8");
    report(true, `${REPORT_REL} 已重新生成`);
  } else {
    try {
      const committed = readJson(REPORT_REL);
      report(
        JSON.stringify(committed) === JSON.stringify(generated),
        `${REPORT_REL} 与夹具及算法一致`,
        "运行 npm run calibrate:time 更新"
      );
    } catch (e) {
      report(false, `${REPORT_REL} 可读取`, e.message);
    }
  }
}

console.log(`\n═══ P6 夹具校验：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
