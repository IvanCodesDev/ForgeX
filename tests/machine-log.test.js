/* 真机日志解析与 G-code 计划/实测对比 */
"use strict";

const fs = require("fs");
const path = require("path");

require(path.join(__dirname, "..", "js", "machine-log.js"));
const Log = globalThis.FXMachineLog;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("\n[1] 标准 JSON 真机日志");
const sample = fs.readFileSync(
  path.join(__dirname, "..", "logs", "example-machine-log.json"),
  "utf8"
);
const json = Log.parse(sample, { name: "example-machine-log.json" });
check("读出任务时长", json.actualTimeSec === 4380);
check("读出耗材长度与克重", json.filamentMm === 8240 && json.filamentG === 24.7);
check("读出完成层数与状态", json.completedLayers === 120 && json.status === "success");
check("读出温度遥测", json.samples.length === 4 && json.samples[1].nozzleC === 209.6);

const linked = Log.parse(JSON.stringify({
  format: "forgex-machine-log",
  version: 1,
  job: {
    jobId: "J-1",
    machineId: "FX-01",
    firmware: "Klipper 0.12",
    slicer: "OrcaSlicer 2.2",
    gcodeSha256: "a".repeat(64),
    durationSec: 100,
    status: "success",
  },
  telemetry: [],
}));
check(
  "保留任务、机型、固件与 G-code 责任链",
  linked.jobId === "J-1" &&
    linked.machineId === "FX-01" &&
    linked.firmware === "Klipper 0.12" &&
    linked.gcodeSha256 === "a".repeat(64)
);

console.log("\n[2] 通用 CSV 真机日志");
const csv = [
  "time_s,nozzle_c,bed_c,filament_mm,filament_g,completed_layers,status",
  "0,25,25,,,,running",
  "120,210,60,300,0.9,2,success",
].join("\n");
const csvLog = Log.parse(csv, { name: "machine.csv" });
check("CSV 时长可由最后时间读出", csvLog.actualTimeSec === 120);
check("CSV 最后一行任务汇总生效", csvLog.filamentMm === 300 && csvLog.completedLayers === 2);
check("CSV 遥测样本归一", csvLog.samples.length === 2 && csvLog.samples[1].bedC === 60);

console.log("\n[3] 计划 / 实测对比");
const planned = {
  totalLayers: 2,
  stats: { timeSec: 120, filamentM: 0.3, filamentG: 0.9 },
};
const compared = Log.compare(planned, csvLog);
check("生成时长、长度、克重、层数四项", compared.length === 4, compared.map((x) => x.name).join(","));
check("精确一致项标记为吻合", compared.every((x) => x.agrees));
check("每项保留解释，差异不冒充结论", compared.every((x) => x.note && x.note.length > 10));

const slow = Log.parse(JSON.stringify({
  format: "forgex-machine-log",
  version: 1,
  job: { durationSec: 200, status: "success" },
  telemetry: [],
}));
const slowTime = Log.compare(planned, slow)[0];
check("明显偏差被标记但仍保留两侧原值",
  !slowTime.agrees && slowTime.planned === 120 && slowTime.actual === 200);

console.log("\n[4] 错误与限制");
let err = null;
try {
  Log.parse("");
} catch (e) {
  err = e;
}
check("空日志明确报错", !!err && /为空/.test(err.message));
err = null;
try {
  Log.parse('{"format":"unknown","version":1}');
} catch (e) {
  err = e;
}
check("未知格式明确拒绝", !!err && /不支持/.test(err.message));

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
