/* FORGE·X 仿真核心测试（node tests/sim-calib.test.js）
   用 stub 打印机在 node 中驱动完整状态机：预热 → 调平 → 逐层打印 → 完成。
   覆盖：床面误差场确定性 / 探测→拟合→补偿数据链自洽 / 运行遥测 / 成品实测质量报告 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("slicer.js"));
require(J("models.js"));
require(J("machine-profile.js"));
require(J("sim.js"));

const FXU = globalThis.FXU, FXSim = globalThis.FXSim;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

/* ── stub 打印机（只保留 sim 消费的契约面） ── */
function makePrinter(id) {
  return {
    ID: id, MODEL_NAME: "STUB-" + id, MODEL_TAG: "STUB-" + id, KIN_TAG: "stub", NOZZLE_Y: 200, bedTopY: 0,
    nozzleHotFrac: 0, bedHotFrac: 0, fanFrac: 0, extrudeRate: 0,
    setBedTopY(y) { this.bedTopY = y; },
    setHeadXY() {}, setStateLED() {}, setSpoolFrac() {}, setFilamentColor() {},
    attachPart() {}, updatePartTf() {}, showGhost() {}, showPart() {},
    beginLayer() {}, endLayer() {}, setLayerProgress() {}, setGrownHeight() {},
    clearPart() {}, hideSlicePreview() {}, showSlicePreview() {},
  };
}

function makeSim() {
  const printer = makePrinter("fx256");
  const fx = { printer, swapPrinter(id) { this.printer = makePrinter(id); return this.printer; } };
  const bus = new FXU.EventBus();
  const sim = new FXSim(fx, bus);
  return { sim, bus };
}

/* 3 层迷你圆片模型（快速跑全状态机） */
function tinyModel() {
  const pts = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 10, y: Math.sin(a) * 10 });
  }
  const zones = [{ z0: 0, z1: 0.6, loops: [{ pts }] }];
  return {
    id: "tiny", kind: "outline", name: "迷你圆片", dims: "Ø20 × 0.6 mm",
    height: 0.6, zones,
    outlinesAt() { return { loops: zones[0].loops }; },
    needSupport: false, footprintR: 10,
  };
}

console.log("\n[1] 床面误差场（机台固有 · 确定性）");
{
  const { sim } = makeSim();
  const a = sim.bedErrorAt(30, -40), b = sim.bedErrorAt(30, -40);
  check("同点两次采样一致", a === b, `${a} vs ${b}`);
  check("误差量级合理（|e| < 0.3mm）", Math.abs(a) < 0.3, String(a));
  const { sim: sim2 } = makeSim();
  check("同机型跨实例一致（按 ID 派生种子）", sim2.bedErrorAt(30, -40) === a);
  sim2.setPrinterModel("delta260");
  const c = sim2.bedErrorAt(30, -40);
  check("不同机型误差场不同", c !== a, `${c} vs ${a}`);
}

console.log("\n[2] 调平数据链：探测 → 9点拟合 → 网格 → 补偿自洽");
{
  const { sim } = makeSim();
  sim.setModel(tinyModel(), true);
  sim.runLeveling();
  check("进入 level 状态", sim.state === "level");
  for (let i = 0; i < 2000 && sim.state === "level"; i++) sim.tick(0.25, i * 0.25);
  check("调平完成回到待机", sim.state === "idle", sim.state);
  check("9 个探测样本已记录", sim.levelMesh && sim.levelMesh.samples.length === 9);
  const err00 = sim.bedErrorAt(0, 0);
  const centerSample = sim.levelMesh.samples[4];      // 3×3 中心点 (0,0)
  check("中心探测值 = 误差场实测（±6µm 读数噪声）", Math.abs(centerSample - err00) <= 0.006,
    `sample=${centerSample.toFixed(4)} field=${err00.toFixed(4)}`);
  check("网格中心 = 中心探测值（拟合插值过点）", Math.abs(sim.levelMesh.grid[2][2] - centerSample) < 1e-9);
  check("补偿插值过探测点", Math.abs(sim.meshCompAt(0, 0) - centerSample) < 1e-9);
  const compAt100 = sim.meshCompAt(100, 100);
  const probeNE = sim.levelMesh.samples[2];           // 行序 y=+100 行、x=+100 列
  check("角部补偿贴近对应探测值（±20µm）", Math.abs(compAt100 - probeNE) < 0.02,
    `comp=${compAt100.toFixed(4)} probe=${probeNE.toFixed(4)}`);
  // fade：首层全量、6mm 处归零
  const c0 = sim._zCompAt(0, 0, 0);
  check("Z=0 全量补偿", Math.abs(c0 - sim.meshCompAt(0, 0)) < 1e-9);
  check("Z≥6mm 补偿归零", sim._zCompAt(0, 0, 6) === 0);
  // 重复调平稳定（床不会变，只有读数噪声）
  const s1 = sim.levelMesh.samples.slice();
  sim.runLeveling();
  for (let i = 0; i < 2000 && sim.state === "level"; i++) sim.tick(0.25, i * 0.25);
  const s2 = sim.levelMesh.samples;
  const maxDiff = Math.max(...s1.map((v, i) => Math.abs(v - s2[i])));
  check("重复调平结果稳定（差 < 12µm）", maxDiff < 0.012, `maxDiff=${(maxDiff * 1000).toFixed(1)}µm`);
}

console.log("\n[3] 全流程：预热 → 调平 → 打印 → 完成（遥测与实测报告）");
{
  const { sim, bus } = makeSim();
  sim.simMult = 8;
  let jobRecord = null, actualEvt = null;
  bus.on("job-record", (r) => { jobRecord = r; });
  bus.on("quality-actual", (q) => { actualEvt = q; });
  sim.setModel(tinyModel(), true);
  sim.start();
  check("进入预热", sim.state === "heat");
  check("遥测已初始化", !!sim._telemetry);
  check("首层不均匀度已实测（≥0）", sim._telemetry.firstLayerUneven >= 0,
    String(sim._telemetry.firstLayerUneven));
  let guard = 40000;
  while (sim.state !== "done" && guard-- > 0) sim.tick(0.25, 0);
  check("全流程跑完（done）", sim.state === "done", `state=${sim.state} guard=${guard}`);
  check("经过自动调平（levelMesh 生成）", !!sim.levelMesh);
  check("job-record 上报 success", jobRecord && jobRecord.status === "success");
  const q = sim.lastQuality;
  check("实测质量报告已生成", !!q && q.kind === "actual");
  check("报告五个实测维度齐全", q && q.checks.length === 5,
    q ? q.checks.map((c) => c.name).join("/") : "null");
  check("quality-actual 事件已广播", actualEvt === q);
  check("综合分与评级合法", q && q.score >= 4 && q.score <= 99 && ["A", "B", "C", "D"].includes(q.grade),
    q ? `${q.grade}/${q.score}` : "null");
  check("干净打印 → 过程扰动高分", q.checks[2].score >= 90, String(q.checks[2].score));
  check("已调平 → 首层维度引用网格实测", q.checks[1].tip.includes("9 点实测网格"), q.checks[1].tip);
  check("实测耗材量 > 0", q.usedG > 0, String(q.usedG));
  check("回抽执行被运行遥测记录", sim._telemetry.retractions > 0 && sim._telemetry.retractedMm > 0,
    `${sim._telemetry.retractions}/${sim._telemetry.retractedMm}`);
  check("实测报告包含回抽与拉丝", q.checks[3].name.includes("回抽"), q.checks[3].name);
}

console.log("\n[4] 热失控监测链：物理注入 → 温度真实下跌 → 监测器凭偏差发现");
{
  const { sim, bus } = makeSim();
  sim.simMult = 8;
  let faultEvt = null;
  bus.on("fault", (f) => { faultEvt = f; });
  sim.setModel(tinyModel(), true);
  sim.start();
  let guard = 40000;
  while (sim.state !== "print" && guard-- > 0) sim.tick(0.25, 0);
  check("到达打印态", sim.state === "print", sim.state);

  sim.injectFault("thermal");
  check("注入后不立即报警（监测器还没发现）", !sim.faultInfo);
  check("物理层已注入（加热器失效）", sim.nozzleT.heaterBroken === true);
  guard = 8000;
  while (!sim.faultInfo && guard-- > 0) sim.tick(0.25, 0);
  check("监测器发现热失控并拉响保护", !!sim.faultInfo && sim.faultInfo.name === "热失控保护",
    sim.faultInfo && sim.faultInfo.name);
  check("发现时温度确实已偏离目标 >15°C", sim.nozzleT.target - sim.nozzleNow > 15 || sim.nozzleT.target <= 26,
    `now=${sim.nozzleNow && sim.nozzleNow.toFixed(1)} target=${sim.nozzleT.target}`);
  check("故障事件已广播 + 遥测已实录", faultEvt && sim._telemetry.faults.indexOf("热失控保护") >= 0);
  check("进入故障暂停态", sim.state === "fault", sim.state);

  sim.resume();
  check("排障后加热器修复", sim.nozzleT.heaterBroken === false);
  check("温度目标恢复设定值", sim.nozzleT.target === sim.settings.nozzleTemp);
  guard = 40000;
  while (sim.state !== "done" && guard-- > 0) sim.tick(0.25, 0);
  check("恢复后可打完（done）", sim.state === "done", sim.state);
  check("实测报告记录本次故障", sim.lastQuality && sim.lastQuality.checks[2].tip.includes("热失控保护"),
    sim.lastQuality && sim.lastQuality.checks[2].tip);
}

console.log("\n[5] 实测质量纯函数（遥测 → 报告边界行为）");
{
  const base = {
    printTime: 600, tempTime: 580, tempDevSum: 580 * 0.8, tempDevMax: 4,
    offSpeedTime: 0, faults: [], pauses: 0, tunes: 0,
    leveled: true, levelMax: 0.08, firstLayerUneven: 0.02, usedG0: 0,
    settings0: {},
  };
  const st = { material: "PLA" };
  const clean = FXSim.computeActualQuality(base, st, null, { elapsed: 600, usedG: 12 });
  check("干净遥测 → A/B 级", clean.score >= 78, `${clean.grade}/${clean.score}`);

  const faulty = FXSim.computeActualQuality(
    Object.assign({}, base, { faults: ["断料检测触发", "热失控保护"], pauses: 2, tempDevMax: 18, tempDevSum: 580 * 3 }),
    st, null, { elapsed: 900, usedG: 12 });
  check("故障遥测 → 分数显著下降", faulty.score < clean.score - 15, `${faulty.score} vs ${clean.score}`);
  check("扰动维度列出故障实录", faulty.checks[2].tip.includes("断料检测触发") && faulty.checks[2].tip.includes("热失控保护"));

  const unleveled = FXSim.computeActualQuality(
    Object.assign({}, base, { leveled: false, levelMax: null, firstLayerUneven: 0.18 }),
    st, null, { elapsed: 600, usedG: 12 });
  check("未调平且床面差 → 首层维度亮红", unleveled.checks[1].score < 55, String(unleveled.checks[1].score));
  check("未调平提示运行调平", unleveled.checks[1].tip.includes("自动调平"));

  const offSpeed = FXSim.computeActualQuality(
    Object.assign({}, base, { offSpeedTime: 300 }),
    st, null, { elapsed: 600, usedG: 12 });
  check("变速 50% 时间 → 速度一致性降分", offSpeed.checks[4].score < clean.checks[4].score);

  const noRetract = FXSim.computeActualQuality(
    Object.assign({}, base, {
      travelMoves: 20, travelMm: 1000, retractions: 0, retractedMm: 0,
      stringingRiskWeighted: 1000, stringingTravelMm: 1000, retractionStress: 0,
    }),
    st, null, { elapsed: 600, usedG: 12 });
  const tunedRetract = FXSim.computeActualQuality(
    Object.assign({}, base, {
      travelMoves: 20, travelMm: 1000, retractions: 20, retractedMm: 24,
      stringingRiskWeighted: 90, stringingTravelMm: 1000, retractionStress: 0,
    }),
    st, null, { elapsed: 600, usedG: 12 });
  check("回抽不足 → 拉丝实测维度明显降分",
    noRetract.checks[3].score < tunedRetract.checks[3].score - 30,
    `${noRetract.checks[3].score} vs ${tunedRetract.checks[3].score}`);
}

console.log("\n[6] 回抽参数进入切片估时");
{
  const { sim } = makeSim();
  sim.setModel(tinyModel(), true);
  sim.updateSettings({ retraction: 0 });
  const without = sim.slice.stats.timeSec;
  sim.updateSettings({ retraction: 2 });
  const withRetraction = sim.slice.stats.timeSec;
  check("增加回抽会增加真实运动阶段与估时", withRetraction > without,
    `${without.toFixed(3)} → ${withRetraction.toFixed(3)}`);
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
