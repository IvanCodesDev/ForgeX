"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const start = Date.now();
const runner = spawnSync(
  process.execPath,
  [
    "tools/run-dotnet.js",
    "run",
    "--project",
    "backend/tests/ForgeX.PersistenceGate/ForgeX.PersistenceGate.csproj",
    "--configuration",
    "Release",
    "--no-build",
  ],
  { cwd: root, encoding: "utf8", windowsHide: true }
);
process.stdout.write(runner.stdout || "");
process.stderr.write(runner.stderr || "");
if (runner.status !== 0) process.exit(runner.status || 1);

const reportPath = path.join(root, "backend", "artifacts", "persistence-recovery-gate.json");
const source = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const backupPath = source.backup.path;
const backup = fs.readFileSync(backupPath);
const observedHash = crypto.createHash("sha256").update(backup).digest("hex");
const durationMs = Date.now() - start;
const checks = {
  sourceGatePassed: source.result === "pass" && source.passed === source.total,
  backupExists: backup.length === source.backup.bytes,
  backupHashMatches: observedHash === source.backup.sha256,
  restoreVerified: source.checks.some((item) => item.name === "restored-health-ready" && item.pass),
  corruptionRejected: source.checks.some((item) => item.name === "corrupt-backup-rejected" && item.pass),
  rtoObjectiveMet: durationMs < 5 * 60 * 1000,
};
const pass = Object.values(checks).every(Boolean);
const drill = {
  schemaVersion: "1.0",
  generatedAtUtc: new Date().toISOString(),
  result: pass ? "pass" : "fail",
  durationMs,
  rtoObjectiveMs: 5 * 60 * 1000,
  rpo: "zero accepted job metadata after HTTP 202",
  backup: { path: backupPath, bytes: backup.length, sha256: observedHash },
  checks,
};
const artifact = path.join(root, "backend", "artifacts", "recovery-drill.json");
fs.writeFileSync(artifact, `${JSON.stringify(drill, null, 2)}\n`);
if (!pass) throw new Error(`Recovery drill failed: ${JSON.stringify(checks)}`);
console.log(`Recovery drill PASS: duration=${durationMs}ms, RPO=0, RTO<5m`);
console.log(artifact);
