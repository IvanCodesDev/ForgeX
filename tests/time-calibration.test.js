/* P6 打印时间校准模型 */
"use strict";

const path = require("path");
require(path.join(__dirname, "..", "js", "time-calibration.js"));
const Cal = globalThis.FXTimeCalibration;

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
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

console.log("\n[1] 稳健拟合");
const exact = [100, 200, 400, 800].map((planned, i) => ({
  id: `job-${i + 1}`,
  plannedTimeSec: planned,
  actualTimeSec: 90 + 1.25 * planned,
  machineId: "FX-TEST",
  firmware: "Marlin",
}));
const model = Cal.fit(exact, { machineId: "FX-TEST", firmware: "Marlin" });
check("输出带版本与方法", model.format === "forgex-time-calibration" && model.method === "theil-sen");
check("恢复运动倍率", near(model.motionScale, 1.25, 1e-9), String(model.motionScale));
check("恢复固定开销", near(model.fixedOverheadSec, 90, 1e-9), String(model.fixedOverheadSec));
check("保留校准作用域", model.scope.machineId === "FX-TEST" && model.scope.firmware === "Marlin");
check("训练误差为零", model.trainingMetrics.maeSec < 1e-9);
check("四样本生成留一交叉验证", model.crossValidation && model.crossValidation.sampleCount === 4);
check("预测使用固定开销与倍率", near(Cal.predict(model, 300), 465, 1e-9));
const duplicateDuration = Cal.fit(exact.concat({
  id: "same-duration",
  plannedTimeSec: 200,
  actualTimeSec: 340,
}));
check(
  "重复计划时长的交叉验证不串用别的样本预测",
  duplicateDuration.crossValidation &&
    duplicateDuration.crossValidation.sampleCount === 5 &&
    duplicateDuration.crossValidation.maeSec < 1e-9
);

console.log("\n[2] 抗单点异常");
const outlier = exact.concat({
  id: "paused-job",
  plannedTimeSec: 600,
  actualTimeSec: 3000,
});
const robust = Cal.fit(outlier);
check("单个暂停异常不摧毁主斜率", near(robust.motionScale, 1.25, 0.05), String(robust.motionScale));
check("模型暴露异常造成的最大相对误差", robust.trainingMetrics.maxApe > 0.5);

console.log("\n[3] G-code / 日志配对观测");
const gcode = { stats: { timeSec: 120 } };
const log = { name: "machine.json", actualTimeSec: 180, machineId: "FX-01", firmware: "Klipper" };
const pair = Cal.fromPair(gcode, log);
check("从现有结构建立样本", pair.plannedTimeSec === 120 && pair.actualTimeSec === 180);
check("沿用日志机型与固件", pair.machineId === "FX-01" && pair.firmware === "Klipper");
const observation = Cal.observation(gcode, log);
check("单任务展示原始倍率", near(observation.rawRatio, 1.5, 1e-9));
check("单任务不冒充完整校准", /至少三个/.test(observation.note));

console.log("\n[4] 防御性边界");
let err = null;
try {
  Cal.fit(exact.slice(0, 2));
} catch (e) {
  err = e;
}
check("少于三组任务明确拒绝", !!err && /至少需要 3/.test(err.message));
err = null;
try {
  Cal.fit([
    { plannedTimeSec: 100, actualTimeSec: 150 },
    { plannedTimeSec: 100, actualTimeSec: 160 },
    { plannedTimeSec: 100, actualTimeSec: 170 },
  ]);
} catch (e) {
  err = e;
}
check("计划时长无变化时拒绝拟合", !!err && /不同的计划时长/.test(err.message));
err = null;
try {
  Cal.fromPair({ stats: { timeSec: 0 } }, { actualTimeSec: 10 });
} catch (e) {
  err = e;
}
check("无效配对任务明确拒绝", !!err && /缺少有效/.test(err.message));

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
