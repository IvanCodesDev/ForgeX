"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const composePath = path.join(root, "deploy", "docker-compose.yml");
const source = fs.readFileSync(composePath, "utf8");

function render(values) {
  return source.replace(/\$\{([A-Z0-9_]+)(?::[-?][^}]*)?\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? values[name] : whole
  );
}

const shared = {
  GCODE_AUTHORITY_INTERNAL_SECRET: "rollback-drill-secret-32-bytes-minimum",
  GCODE_AUTHORITY_INTERNAL_SECRET_PREVIOUS: "",
};
const current = render({
  ...shared,
  FORGEX_NODE_IMAGE: "forgex-insight:stage6-candidate",
  FORGEX_API_IMAGE: "forgex-authority:stage6-candidate",
});
const rollback = render({
  ...shared,
  FORGEX_NODE_IMAGE: "forgex-insight:stage5-verified",
  FORGEX_API_IMAGE: "forgex-authority:stage5-verified",
});
const imageLines = (value) =>
  value
    .split(/\r?\n/)
    .filter((line) => /^\s+image:/.test(line))
    .map((line) => line.trim());
const volumeBlock = (value) => value.slice(value.lastIndexOf("\nvolumes:"));
const checks = {
  currentPairSelected:
    current.includes("forgex-insight:stage6-candidate") && current.includes("forgex-authority:stage6-candidate"),
  rollbackPairSelected:
    rollback.includes("forgex-insight:stage5-verified") && rollback.includes("forgex-authority:stage5-verified"),
  imagePairChanged: JSON.stringify(imageLines(current)) !== JSON.stringify(imageLines(rollback)),
  namedVolumesPreserved: volumeBlock(current) === volumeBlock(rollback),
  noUnresolvedImageVariables:
    !imageLines(current).some((line) => line.includes("${")) &&
    !imageLines(rollback).some((line) => line.includes("${")),
  runbookRequiresNoBuild: fs.readFileSync(path.join(root, "deploy", "RUNBOOK.md"), "utf8").includes("up -d --no-build"),
};
const pass = Object.values(checks).every(Boolean);
const report = {
  schemaVersion: "1.0",
  generatedAtUtc: new Date().toISOString(),
  result: pass ? "pass" : "fail",
  executionLevel: "isolated-compose-render",
  composeSha256: crypto.createHash("sha256").update(source).digest("hex"),
  currentImages: imageLines(current),
  rollbackImages: imageLines(rollback),
  checks,
  liveCommand:
    "powershell -File deploy/drills/rehearse-version-rollback.ps1 -PreviousNodeImage <TAG> -PreviousApiImage <TAG> -Apply",
};
const artifact = path.join(root, "backend", "artifacts", "release-rollback-drill.json");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
if (!pass) throw new Error(`Release rollback rehearsal failed: ${JSON.stringify(checks)}`);
console.log(`Release rollback rehearsal PASS: ${imageLines(rollback).join(", ")}`);
console.log(artifact);
