"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("../frontend/classic/js/util.js");
require("../frontend/classic/js/gcode-parser.js");
require("../frontend/classic/js/machine-log.js");
require("../frontend/classic/js/time-calibration.js");
require("../frontend/classic/js/profile-registry.js");
require("../frontend/classic/js/calibration-registry.js");
require("../frontend/classic/js/insight-data.js");

const ROOT = path.resolve(__dirname, "..");
const DEMO = path.join(ROOT, "demo");

function text(rel) {
  return fs.readFileSync(path.join(DEMO, rel), "utf8");
}

function json(rel) {
  return JSON.parse(text(rel));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const image = fs.readFileSync(path.join(DEMO, "assets/01-turbine-relief.png"));
assert(image.length > 10000, "演示图片过小");
assert.strictEqual(image.subarray(1, 4).toString("ascii"), "PNG", "演示图片不是 PNG");

const profile = json("profile/02-demo-profile.json");
const importedProfile = globalThis.FXProfiles.importBundle(profile);
assert.strictEqual(importedProfile.machines.length, 1);
assert.strictEqual(importedProfile.materials.length, 1);

const gcodeText = text("replay/03-demo-turbine.gcode");
const parsed = globalThis.FXGcodeParser.parse(gcodeText, { densityG: 1.24, bedSize: 256, origin: "corner" });
assert.strictEqual(parsed.totalLayers, 18);
assert(parsed.stats.filamentM > 0.5);
assert(parsed.layers.some((layer) => layer.paths.some((item) => item.type === "infill")));

const log = globalThis.FXMachineLog.parse(text("replay/04-demo-machine-log.json"), {
  name: "04-demo-machine-log.json",
});
assert.strictEqual(log.gcodeSha256, sha256(gcodeText));
assert.strictEqual(log.completedLayers, parsed.totalLayers);
assert(globalThis.FXMachineLog.compare(parsed, log).length >= 4);

const calibration = json("calibration/05-demo-calibration.json");
const importedCalibration = globalThis.FXCalibrationRegistry.importBundle(calibration);
assert.strictEqual(importedCalibration.models.length, 1);
assert.strictEqual(globalThis.FXCalibrationRegistry.list()[0].status, "demonstration-only");

const csv = globalThis.FXInsightData.parseCsv(text("insight/06-demo-production.csv"));
assert.strictEqual(csv.rows.length, 72);
assert.strictEqual(csv.errors.length, 0);
assert(csv.rows.some((row) => row.status === "fail"));

assert(text("knowledge/07-demo-knowledge.md").includes("合成演示知识"));
assert(text("DEMO-SCRIPT.zh-CN.md").includes("镜头"));

console.log(
  `Demo kit OK: PNG ${Math.round(image.length / 1024)}KB · G-code ${parsed.totalLayers} layers · ` +
    `${parsed.stats.filamentM.toFixed(2)}m · CSV ${csv.rows.length} rows`
);
