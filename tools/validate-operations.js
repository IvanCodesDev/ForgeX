"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const rules = read("deploy/alerts/forgex.rules.yml");
const slo = read("deploy/SLO.md");
const runbook = read("deploy/RUNBOOK.md");
const compose = read("deploy/docker-compose.yml");
const checks = [];
function check(name, pass, actual = pass) {
  checks.push({ name, pass, actual });
  if (!pass) throw new Error(`${name} failed`);
}

for (const alert of [
  "ForgeXApiUnavailable",
  "ForgeXHttp5xxBudgetBurn",
  "ForgeXHttpLatencyHigh",
  "ForgeXGCodeQueueSaturated",
  "ForgeXGCodeDeadLetters",
  "ForgeXGCodeFailureRatioHigh",
]) {
  check(`alert:${alert}`, rules.includes(`alert: ${alert}`));
}
for (const metric of [
  "forgex_http_requests_total",
  "forgex_http_request_duration_ms_bucket",
  "forgex_gcode_job_queue_depth",
  "forgex_gcode_job_queue_capacity",
  "forgex_gcode_job_dead_letters_total",
  "forgex_gcode_jobs",
]) {
  check(`metric:${metric}`, rules.includes(metric));
}
for (const token of ["99.5%", "99%", "60 秒", "RPO", "RTO", "错误预算"]) {
  check(`slo:${token}`, slo.includes(token));
}
for (const token of [
  "ForgeXApiUnavailable",
  "ForgeXGCodeQueueSaturated",
  "ForgeXGCodeDeadLetters",
  "密钥轮换",
  "备份与恢复",
  "版本回滚",
]) {
  check(`runbook:${token}`, runbook.includes(token));
}
check("compose-previous-secret", compose.includes("InternalAuth__PreviousSharedSecret"));
check("compose-owner-quota", compose.includes("GCodeJobs__Admission__MaxActivePerOwner"));
check("compose-tenant-quota", compose.includes("GCodeJobs__Admission__MaxActivePerTenant"));
check("compose-versioned-node-image", compose.includes("${FORGEX_NODE_IMAGE:-forgex-insight:local}"));
check("compose-versioned-api-image", compose.includes("${FORGEX_API_IMAGE:-forgex-authority:local}"));

const report = {
  schemaVersion: "1.0",
  generatedAtUtc: new Date().toISOString(),
  result: "pass",
  summary: { passed: checks.length, total: checks.length },
  checks,
};
const artifact = path.join(root, "backend", "artifacts", "operations-validation.json");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Operations validation PASS: ${checks.length}/${checks.length}`);
console.log(artifact);
