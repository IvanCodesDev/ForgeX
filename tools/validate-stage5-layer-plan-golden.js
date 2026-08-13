"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("../frontend/classic/js/gcode-parser.js");

const ROOT = path.resolve(__dirname, "..");
const STAGE0 = path.join(ROOT, "tests", "golden", "stage0-golden.json");
const OUTPUT = path.join(ROOT, "tests", "golden", "stage5-layer-plan-golden.json");
const write = process.argv.includes("--write");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function layerSummary(layer, index) {
  const pathTypeCounts = {};
  let filamentLengthMm = 0;
  for (const item of layer.paths) {
    pathTypeCounts[item.type] = (pathTypeCounts[item.type] || 0) + 1;
    filamentLengthMm += item.filamentMm;
  }
  return {
    index,
    zMm: layer.z,
    pathCount: layer.paths.length,
    extrusionLengthMm: layer.extLen,
    travelLengthMm: layer.travelLen,
    timeSeconds: layer.timeSec,
    filamentLengthMm,
    pathTypeCounts: Object.fromEntries(
      Object.entries(pathTypeCounts).sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

const stage0 = JSON.parse(fs.readFileSync(STAGE0, "utf8"));
const unique = new Map();
for (const item of stage0.cases.filter((entry) => entry.category === "gcode")) {
  const key = `${item.input.path}|${item.parameters.bedSize}|${item.parameters.origin}`;
  if (!unique.has(key)) unique.set(key, item);
}

const cases = [...unique.values()]
  .map((item) => {
    const inputPath = item.input.path.replaceAll("\\", "/");
    const bytes = fs.readFileSync(path.join(ROOT, inputPath));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== item.input.sha256) {
      throw new Error(`Layer-plan input hash mismatch: ${inputPath}`);
    }
    const parsed = globalThis.FXGcodeParser.parse(bytes.toString("utf8"), {
      bedSize: item.parameters.bedSize,
      densityG: item.parameters.densityG,
      origin: item.parameters.origin,
    });
    return {
      id: `layer-plan-${path.basename(inputPath, ".gcode")}-${item.parameters.origin}`,
      inputPath,
      inputSha256: actualSha256,
      bedSizeMm: item.parameters.bedSize,
      coordinateOrigin: item.parameters.origin,
      materialDensityGPerCm3: item.parameters.densityG,
      numericAbsoluteTolerance: item.tolerance.numericAbs,
      numericRelativeTolerance: item.tolerance.numericRel,
      layers: parsed.layers.map(layerSummary),
    };
  })
  .sort((left, right) => left.id.localeCompare(right.id));

const document = {
  format: "forgex-stage5-layer-plan-golden",
  schemaVersion: 1,
  generator: "tools/validate-stage5-layer-plan-golden.js",
  updatePolicy: "Only regenerate after reviewing an intentional JS/C# layer-plan contract change.",
  caseCount: cases.length,
  cases,
};
const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (write) {
  fs.writeFileSync(OUTPUT, serialized);
  console.log(`Stage 5 layer-plan golden updated: ${path.relative(ROOT, OUTPUT)} (${cases.length} cases)`);
} else {
  if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, "utf8") !== serialized) {
    console.error("Stage 5 layer-plan golden is stale; review changes, then run with --write.");
    process.exit(1);
  }
  console.log(`Stage 5 layer-plan golden OK: ${cases.length} cases`);
}
