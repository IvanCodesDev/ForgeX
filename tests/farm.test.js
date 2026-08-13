/* FORGE·X 虚拟机群测试（node tests/farm.test.js）

   这套测试要证明的核心命题：**故障是算出来的，不是抽出来的。**

   证明方式（与 tests/insight.test.js 同一原则：断言性质，不断言常量）：
     1. 确定性 —— 同一机台编号永远得到同一组物理特征；同样的机器跑同样的活，
        结果必须完全一致。有任何概率抽样参与结果，这条就会红。
     2. 区分度 —— 完全相同的工艺参数下，物理特征差的机器失败、好的机器成功。
        如果失败是抽样出来的，两台机器的结果不会稳定分化。
     3. 效应可调转 —— 把物理特征对调，失败必须跟着换一台机器。
        这条排除了「碰巧和机台编号相关」的可能。
     4. 物理证据自洽 —— 判定为堵料的单子，其挤出负载指数必须真的越线，
        而其他机制的指数不越线。故障类型与机理必须对得上。
     5. 默认参数安全 —— 标准 PLA 工艺在全机群都应当跑通，
        否则「磨损让机器易感」就退化成了「磨损直接制造故障」。 */
"use strict";

const path = require("path");
const H = require(path.join(__dirname, "..", "tools", "headless-sim.js"));
require(path.join(__dirname, "..", "frontend", "classic", "js", "insight-data.js"));

const P = H.FXMachineProfile;
const D = globalThis.FXInsightData;
const models = H.FXModels.createBuiltins();
const GEAR = models[0];
const BRACKET = models[2];

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

/** 跑一单：指定机型/实例（或直接注入物理特征），返回结果 */
function run(opt) {
  const ctx = H.createHeadlessSim({
    modelTag: opt.modelTag || "FX-256",
    instance: opt.instance || 1,
    profileOverride: opt.profile || null,
  });
  const r = H.runJob({
    sim: ctx.sim,
    bus: ctx.bus,
    model: opt.model || GEAR,
    settings: Object.assign({ material: "PLA", simMult: 1 }, opt.settings || {}),
  });
  r.profile = ctx.sim.machineProfile;
  return r;
}

/* ══════════════════════════════════════════════ */

console.log("\n[1] 机台物理特征：确定性与结构性");
{
  P.resetCache();
  const a = P.of("FX-256-03");
  P.resetCache();
  const b = P.of("FX-256-03");
  check("同一机台编号 → 同一组物理特征", JSON.stringify(a) === JSON.stringify(b));

  const c = P.of("FX-256-04");
  check("不同机台 → 不同物理特征", a.hotendFouling !== c.hotendFouling || a.feederGrip !== c.feederGrip);

  check("机型标签解析正确", P.modelTagOf("FX-256-03") === "FX-256" && P.modelTagOf("FX-Δ260-01") === "FX-Δ260",
    P.modelTagOf("FX-Δ260-01"));
  check("封闭腔体由机型决定（不是随机）", P.of("FX-256-01").enclosed === true && P.of("FX-220-01").enclosed === false);
  check("封闭机型环境温度高于开放机型", P.of("FX-256-01").ambientC > P.of("FX-220-01").ambientC,
    `${P.of("FX-256-01").ambientC} vs ${P.of("FX-220-01").ambientC}`);

  // 各字段必须落在声明的物理区间内，否则机理模型的标定会失效
  let inRange = true, bad = "";
  for (let i = 1; i <= 12; i++) {
    for (const tag of ["FX-256", "FX-220", "FX-Δ260", "FX-500"]) {
      const p = P.of(tag + "-" + String(i).padStart(2, "0"));
      if (!(p.hotendFouling >= 0 && p.hotendFouling <= 1)) { inRange = false; bad = "fouling " + p.id; }
      if (!(p.feederGrip >= 0.6 && p.feederGrip <= 1)) { inRange = false; bad = "grip " + p.id; }
      if (!(p.heaterHealth >= 0.8 && p.heaterHealth <= 1)) { inRange = false; bad = "heater " + p.id; }
    }
  }
  check("48 台机器的特征全部落在声明区间内", inRange, bad);
}

console.log("\n[2] 结果确定性：同样的机器跑同样的活，结果必须一致");
{
  const s = { material: "PLA", nozzleTemp: 185, layerHeight: 0.2, speed: 120 };
  const r1 = run({ modelTag: "FX-220", instance: 1, settings: s });
  const r2 = run({ modelTag: "FX-220", instance: 1, settings: s });
  check("两次运行状态一致", r1.status === r2.status, `${r1.status} vs ${r2.status}`);
  check("两次运行故障类型一致", String(r1.fault) === String(r2.fault), `${r1.fault} vs ${r2.fault}`);
  check("两次运行耗材量一致", Math.abs(r1.usedG - r2.usedG) < 1e-9, `${r1.usedG} vs ${r2.usedG}`);
  check("两次运行机时一致", Math.abs(r1.elapsedSec - r2.elapsedSec) < 1e-6);
  // 这条是「无概率抽样」的直接证据：只要结果里混入 Math.random，上面几条就会不稳定
  check("负载峰值也逐位一致",
    r1.telemetry && r2.telemetry && r1.telemetry.clogLoadMax === r2.telemetry.clogLoadMax,
    r1.telemetry && `${r1.telemetry.clogLoadMax} vs ${r2.telemetry.clogLoadMax}`);
}

console.log("\n[3] 默认工艺在全机群都安全（磨损只是易感，不直接制造故障）");
{
  let allOk = true, firstBad = "";
  for (const tag of ["FX-256", "FX-220", "FX-Δ260", "FX-500"]) {
    for (let i = 1; i <= 3; i++) {
      const r = run({ modelTag: tag, instance: i, settings: { material: "PLA" } });
      if (r.status !== "success") { allOk = false; firstBad = `${r.machineId}:${r.fault}`; break; }
    }
  }
  check("12 台机器跑标准 PLA 全部成功", allOk, firstBad);
}

console.log("\n[4] 区分度：同样的坏工况，好机器扛得住、差机器扛不住");
{
  // 温度调低 25°C —— 热端积碳重的机器挤出负载会越线，干净的不会
  const cold = { material: "PLA", nozzleTemp: 185 };
  const clean = run({ profile: cleanProfile({ hotendFouling: 0.02 }), settings: cold });
  const dirty = run({ profile: cleanProfile({ hotendFouling: 0.95 }), settings: cold });
  check("低温工况：干净热端跑通", clean.status === "success", clean.fault);
  check("低温工况：重度积碳堵料", dirty.status === "fail" && dirty.fault.indexOf("堵") >= 0, dirty.fault);

  // 高流量 —— 咬合力弱的机器打滑，强的不会
  const fast = { material: "TPU", nozzleTemp: 225, bedTemp: 50, speed: 200 };
  const grippy = run({ profile: cleanProfile({ feederGrip: 1.0, spoolDrag: 0.0 }), settings: fast });
  const slippy = run({ profile: cleanProfile({ feederGrip: 0.62, spoolDrag: 0.9 }), settings: fast });
  check("高流量：咬合力强的机器不打滑", grippy.status === "success" || grippy.fault.indexOf("断料") < 0, grippy.fault);
  check("高流量：咬合力弱的机器断料", slippy.status === "fail" && slippy.fault.indexOf("断料") >= 0, slippy.fault);

  // ABS 255°C —— 加热器功率不足的机器够不到目标
  const abs = { material: "ABS", nozzleTemp: 255, bedTemp: 100, fanSpeed: 15 };
  const strongHeat = run({ profile: cleanProfile({ heaterHealth: 0.99 }), settings: abs });
  const weakHeat = run({ profile: cleanProfile({ heaterHealth: 0.78 }), settings: abs });
  check("ABS：加热器健康的机器跑通", strongHeat.status === "success", strongHeat.fault);
  check("ABS：加热器功率不足 → 加热失败", weakHeat.status === "fail" && weakHeat.fault.indexOf("加热") >= 0, weakHeat.fault);
}

console.log("\n[5] 效应可调转：把物理特征对调，失败必须跟着换机器");
{
  const cold = { material: "PLA", nozzleTemp: 185 };
  const A = run({ profile: cleanProfile({ hotendFouling: 0.95, id: "A" }), settings: cold });
  const B = run({ profile: cleanProfile({ hotendFouling: 0.02, id: "B" }), settings: cold });
  check("A（积碳重）失败、B（干净）成功", A.status === "fail" && B.status === "success",
    `A=${A.status}/${A.fault} B=${B.status}`);

  // 对调特征后重跑：失败必须落到另一边
  const A2 = run({ profile: cleanProfile({ hotendFouling: 0.02, id: "A" }), settings: cold });
  const B2 = run({ profile: cleanProfile({ hotendFouling: 0.95, id: "B" }), settings: cold });
  check("特征对调后 A 成功、B 失败（结论跟着物理走，不跟着编号走）",
    A2.status === "success" && B2.status === "fail",
    `A2=${A2.status} B2=${B2.status}/${B2.fault}`);
}

console.log("\n[6] 成品判废：翘边 / 悬垂塌陷在打印完成时评估");
{
  // 悬垂件不开支撑 → 必然塌陷（这不是概率问题）
  const noSup = run({ model: BRACKET, settings: { material: "PLA", supportEnabled: false } });
  const withSup = run({ model: BRACKET, settings: { material: "PLA", supportEnabled: true } });
  check("悬垂件不开支撑 → 悬垂塌陷", noSup.status === "fail" && noSup.fault === "悬垂塌陷", noSup.fault);
  check("悬垂件开支撑 → 成功", withSup.status === "success", withSup.fault);
  check("判废发生在打印完成后（跑满了所有层）", noSup.layers > 0 && noSup.elapsedSec > 0);

  // ABS 床温远低于材料下限 + 开放机型 → 翘边
  const warp = run({
    modelTag: "FX-220", instance: 1,
    settings: { material: "ABS", nozzleTemp: 250, bedTemp: 60, fanSpeed: 15, supportEnabled: true },
  });
  check("ABS 床温不足 + 开放机型 → 翘边", warp.status === "fail" && warp.fault === "翘边", warp.fault);
  check("翘边风险指数确实越线", warp.telemetry && warp.telemetry.warpRisk >= 1, warp.telemetry && String(warp.telemetry.warpRisk));

  // 床温给足 → 同一台机器的翘边风险必须显著下降（哪怕仍未过关）。
  // 注意：开放机型在低室温 + 有风环境下跑 ABS 本来就基本必翘——ABS 需要封闭腔体是
  // 真实的工艺常识，模型如实反映了这一点，不应为了让测试好看而把它调软。
  const okBed = run({
    modelTag: "FX-220", instance: 1,
    settings: { material: "ABS", nozzleTemp: 250, bedTemp: 100, fanSpeed: 15, supportEnabled: true },
  });
  check("床温从 60 提到 100 后翘边风险显著下降",
    okBed.telemetry && warp.telemetry && okBed.telemetry.warpRisk < warp.telemetry.warpRisk * 0.75,
    okBed.telemetry && `${warp.telemetry.warpRisk} → ${okBed.telemetry.warpRisk}`);

  // 封闭机型 + 正确床温 → ABS 跑得通。这条才是「参数正确就能成功」的正解，
  // 同时证明翘边模型确实在区分腔体结构，而不是一律判死。
  const enclosed = run({
    modelTag: "FX-256", instance: 2,
    settings: { material: "ABS", nozzleTemp: 250, bedTemp: 100, fanSpeed: 15, supportEnabled: true },
  });
  check("封闭机型 + 正确床温 → ABS 不翘边", enclosed.fault !== "翘边", enclosed.fault);
  check("封闭机型的翘边风险低于开放机型（同样参数）",
    enclosed.telemetry && okBed.telemetry && enclosed.telemetry.warpRisk < okBed.telemetry.warpRisk,
    enclosed.telemetry && `封闭 ${enclosed.telemetry.warpRisk} vs 开放 ${okBed.telemetry.warpRisk}`);
}

console.log("\n[7] 物理证据自洽：故障类型必须与越线的机制对得上");
{
  const dirty = run({ profile: cleanProfile({ hotendFouling: 0.95 }), settings: { material: "PLA", nozzleTemp: 185 } });
  const t = dirty.telemetry;
  check("堵料单：挤出负载指数越线", t && t.clogLoadMax >= 1, t && String(t.clogLoadMax));
  check("堵料单：送料打滑指数未越线（不是断料）", t && t.slipRiskMax < 1, t && String(t.slipRiskMax));

  const slippy = run({
    profile: cleanProfile({ feederGrip: 0.62, spoolDrag: 0.9, hotendFouling: 0.0 }),
    settings: { material: "TPU", nozzleTemp: 225, bedTemp: 50, speed: 150 },
  });
  const t2 = slippy.telemetry;
  check("断料单：送料打滑指数越线", t2 && t2.slipRiskMax >= 1, t2 && String(t2.slipRiskMax));

  // 故障单的遥测不能因为中止而丢失——那是最有分析价值的物理证据
  check("故障单仍保留遥测快照", !!dirty.telemetry && dirty.status === "fail");
}

console.log("\n[8] 故障词表：仿真侧与分析侧单一真源");
{
  check("五类故障全部可由仿真产生", D.SIM_FAULTS.length === D.FAIL_REASONS.length && D.FAIL_REASONS.length === 5,
    D.SIM_FAULTS.join(","));
  const cases = [
    ["喷嘴堵塞预警", "堵料"],
    ["断料检测触发", "断料"],
    ["热失控保护", "热失控"],
    ["加热失败", "热失控"],
    ["翘边", "翘边"],
    ["悬垂塌陷", "悬垂塌陷"],
  ];
  let mapOk = true, badCase = "";
  for (const [raw, want] of cases) {
    if (D.normalizeFault(raw) !== want) { mapOk = false; badCase = `${raw} → ${D.normalizeFault(raw)}，期望 ${want}`; }
  }
  check("仿真故障名全部能归入标准词表", mapOk, badCase);
  check("未知故障归为「未知」，不猜具体类型", D.normalizeFault("莫名其妙的错误") === D.FAULT_UNKNOWN);
  check("成功单不产生故障类型", D.normalizeFault("") === "");
  check("每类故障都注明了物理机理",
    D.FAULT_TAXONOMY.every((f) => typeof f.mech === "string" && f.mech.length > 8));
}

console.log("\n[9] 遥测贯通：仿真的物理量进入生产记录");
{
  const ctx = H.createHeadlessSim({ modelTag: "FX-500", instance: 1 });
  H.runJob({ sim: ctx.sim, bus: ctx.bus, model: GEAR, settings: { material: "PLA", simMult: 1 } });
  const rec = D.recordFromSim(ctx.sim, "success", "");
  check("机台编号取自实际机型（不写死）", rec.machine_id === "FX-500-01", rec.machine_id);
  check("生产记录挂上遥测", !!rec._telemetry);
  check("遥测含挤出负载峰值", rec._telemetry && typeof rec._telemetry.clogLoadMax === "number",
    rec._telemetry && String(rec._telemetry.clogLoadMax));
  check("遥测含机台物理特征（可追溯到是哪台机器的什么毛病）",
    !!(rec._telemetry && rec._telemetry.machineProfile && rec._telemetry.machineProfile.id === "FX-500-01"));
  check("遥测含本单工艺参数", rec._telemetry && rec._telemetry.nozzleTemp === 210);
  check("标准 CSV 字段不受污染（遥测不进 CSV）",
    D.toCsv([rec]).split("\n")[0].split(",").length === D.FIELDS.length);
}

console.log("\n[10] 机群数据集：可复现且带交互效应");
{
  const farm = require(path.join(__dirname, "..", "tools", "farm-sim.js"));
  check("排产参数解析可用", farm.parseArgs(["--jobs", "5", "--seed", "1"]).jobs === 5);
  check("材料预设覆盖四种材料", Object.keys(farm.MATERIAL_PRESET).length === 4);
  check("normalizeFault 转发到数据层", farm.normalizeFault("喷嘴堵塞预警") === "堵料");

  // 小批量跑两次，验证同 seed 完全可复现
  const fleetA = farm.buildFleet(3);
  const fleetB = farm.buildFleet(3);
  check("同规模机群 → 同一组机台特征",
    JSON.stringify(fleetA.map((m) => m.profile)) === JSON.stringify(fleetB.map((m) => m.profile)));

  const rndA = H.FXU.mulberry32(99), rndB = H.FXU.mulberry32(99);
  const jobA = farm.scheduleJob(rndA, models), jobB = farm.scheduleJob(rndB, models);
  check("同 seed → 同一份排产", JSON.stringify(jobA.settings) === JSON.stringify(jobB.settings));
}

/** 造一个「除指定字段外都健康」的物理特征，用于隔离单一变量做对照实验 */
function cleanProfile(over) {
  return Object.assign({
    id: "TEST-01", modelTag: "FX-256", seed: 1,
    enclosed: true, buildMm: 256,
    hotendFouling: 0.0, feederGrip: 1.0, spoolDrag: 0.0,
    heaterHealth: 0.99, heaterTauMul: 1, beltWear: 0,
    ambientC: 32, draft: 0.05,
  }, over || {});
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
