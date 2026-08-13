#!/usr/bin/env node
/* FORGE·X — 虚拟机群（Virtual Print Farm）

   用途：用**物理仿真**批量产出生产数据集，替代原来的概率抽样生成器。

   区别在哪里：

     旧生成器（js/insight-data.js 的 generateSample）
       machineFailBase = { "FX-256-03": 0.2, ... }
       failed = rnd() < pFail
       → 「03 号机故障率高」这个结论是写死进去的，分析引擎只是把它读了回来。

     虚拟机群（本工具）
       每台机器有确定性的固有物理特征（热端积碳、送料咬合力、加热器功率、
       料架阻力、环境温度、风扰、床面误差场），仿真按这些特征真实演化：
       热端积碳重的机器在低温工况下挤出负载爬升 → 触发堵料；
       加热器功率不足的机器够不到 ABS 的 255°C → 触发加热失败；
       开放机型 + 低室温 + 高收缩材料 → 首层附着不住 → 成品判废为翘边。
       → 「哪台机不行、什么工况下不行」是**算出来的**，不是抽出来的。

   这带来两个旧生成器给不了的性质：
     1. 结论可被证伪——改工艺参数，故障分布会跟着变；
     2. 有真实的交互效应——「某台机 × 某种材料」的组合才出问题，
        单看机台或单看材料都看不出来，这正是数据分析的用武之地。

   用法：
     node tools/farm-sim.js                                  # 默认 8 台机 × 200 单
     node tools/farm-sim.js --machines 12 --jobs 500 --seed 7
     node tools/farm-sim.js --out contracts/datasets/farm.csv --json contracts/datasets/farm-telemetry.json
     node tools/farm-sim.js --jobs 40 --quiet                # 只输出汇总

   注意：随机性只用于**排产**（这一单派给哪台机、用什么材料、什么参数），
   这是真实产线本来就有的多样性。成败与故障类型完全由物理决定，不做任何抽样。 */
"use strict";

const fs = require("fs");
const path = require("path");
const H = require("./headless-sim");

const FXU = H.FXU;
const FXModels = H.FXModels;
const FXMachineProfile = H.FXMachineProfile;

// 数据层（CSV 导出与字段口径的单一真源）
require(path.join(__dirname, "..", "frontend", "classic", "js", "insight-data.js"));
const D = globalThis.FXInsightData;

/* ── 参数解析 ─────────────────────────────── */

function parseArgs(argv) {
  const o = {
    machines: 8,
    jobs: 200,
    seed: 20260726,
    out: "",
    json: "",
    quiet: false,
    startDate: "2026-06-29",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--machines") o.machines = parseInt(next(), 10);
    else if (a === "--jobs") o.jobs = parseInt(next(), 10);
    else if (a === "--seed") o.seed = parseInt(next(), 10);
    else if (a === "--out") o.out = next();
    else if (a === "--json") o.json = next();
    else if (a === "--emit-js") o.emitJs = next();
    else if (a === "--start-date") o.startDate = next();
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error("未知参数：" + a);
  }
  if (!(o.machines > 0) || !(o.jobs > 0)) throw new Error("--machines / --jobs 必须为正整数");
  return o;
}

const HELP = `虚拟机群 — 用物理仿真产出生产数据集

  --machines N     机群规模（默认 8）
  --jobs N         总任务数（默认 200）
  --seed N         排产随机种子（默认 20260726），同种子结果完全一致
  --out FILE       导出生产数据 CSV
  --json FILE      导出完整遥测 JSON（含每台机的物理特征与每单的负载峰值）
  --emit-js FILE   生成前端可直接内联加载的数据模块（保持 file:// 直开可用）
  --start-date D   数据起始日期（默认 2026-06-29）
  --quiet          只输出汇总
`;

/* ── 机群构成 ─────────────────────────────── */

/** 机型配比：贴近真实打印农场——主力机型多台，特种机型少量 */
const FLEET_MIX = ["FX-256", "FX-256", "FX-256", "FX-220", "FX-220", "FX-Δ260", "FX-500", "FX-256"];

function buildFleet(n) {
  const fleet = [];
  const counter = {};
  for (let i = 0; i < n; i++) {
    const tag = FLEET_MIX[i % FLEET_MIX.length];
    counter[tag] = (counter[tag] || 0) + 1;
    const ctx = H.createHeadlessSim({ modelTag: tag, instance: counter[tag] });
    fleet.push({ tag, ctx, profile: ctx.sim.machineProfile, jobs: 0 });
  }
  return fleet;
}

/* ── 排产（唯一使用随机的地方） ─────────────── */

const MATERIALS = ["PLA", "PLA", "PLA", "PETG", "PETG", "ABS", "TPU"]; // 权重贴近实际用量
const LAYER_HEIGHTS = [0.12, 0.2, 0.2, 0.2, 0.28];

/** 各材料的标准工艺参数（相当于切片器预设，正常操作员会这么设） */
const MATERIAL_PRESET = {
  PLA: { nozzleTemp: 210, bedTemp: 60, fanSpeed: 100, speed: 120 },
  PETG: { nozzleTemp: 240, bedTemp: 80, fanSpeed: 40, speed: 90 },
  ABS: { nozzleTemp: 255, bedTemp: 100, fanSpeed: 15, speed: 100 },
  TPU: { nozzleTemp: 225, bedTemp: 50, fanSpeed: 50, speed: 45 },
};

/**
 * 生成一单的工单参数。这里的随机代表真实产线的订单多样性与操作员差异，
 * 不代表故障——故障由物理演化决定。
 */
function scheduleJob(rnd, models) {
  const material = MATERIALS[Math.floor(rnd() * MATERIALS.length)];
  const model = models[Math.floor(rnd() * models.length)];
  const preset = MATERIAL_PRESET[material];

  // 操作员偏差：多数按预设走，少数会自行调温/调速（真实车间就是这样）
  const tweak = rnd();
  const nozzleDelta = tweak < 0.72 ? 0 : Math.round((rnd() - 0.62) * 40); // 偏冷居多，模拟"省电/防拉丝"的经验主义调法
  const speedMul = tweak < 0.8 ? 1 : 0.8 + rnd() * 0.9;

  return {
    material,
    model,
    settings: {
      material,
      layerHeight: LAYER_HEIGHTS[Math.floor(rnd() * LAYER_HEIGHTS.length)],
      nozzleTemp: preset.nozzleTemp + nozzleDelta,
      bedTemp: preset.bedTemp,
      fanSpeed: preset.fanSpeed,
      speed: Math.round(preset.speed * speedMul),
      // 悬垂件是否开支撑：多数操作员会开，少数忘记（真实的人为失误）
      supportEnabled: rnd() > 0.12,
      simMult: 1,
    },
  };
}

/* ── 主流程 ───────────────────────────────── */

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("参数错误：" + e.message + "\n\n" + HELP);
    process.exit(2);
  }
  if (opt.help) {
    console.log(HELP);
    return;
  }

  const rnd = FXU.mulberry32(opt.seed);
  const models = FXModels.createBuiltins();
  const fleet = buildFleet(opt.machines);
  const startMs = Date.parse(opt.startDate + "T00:00:00Z");

  if (!opt.quiet) {
    console.log(`\n虚拟机群：${opt.machines} 台 × ${opt.jobs} 单 · seed=${opt.seed}`);
    console.log("\n机台固有物理特征（确定性，由机台编号决定）");
    console.log("  机台          机型     积碳  咬合  料阻  加热  温上限  环境  风扰  腔体");
    for (const m of fleet) {
      const p = m.profile;
      console.log(
        "  " +
          p.id.padEnd(13) +
          m.tag.padEnd(9) +
          p.hotendFouling.toFixed(2).padStart(5) +
          p.feederGrip.toFixed(2).padStart(6) +
          p.spoolDrag.toFixed(2).padStart(6) +
          p.heaterHealth.toFixed(2).padStart(6) +
          FXMachineProfile.heaterCeilingC(p, p.ambientC).toFixed(0).padStart(7) +
          "°C" +
          String(p.ambientC).padStart(6) +
          "°C" +
          p.draft.toFixed(2).padStart(6) +
          (p.enclosed ? "  封闭" : "  开放")
      );
    }
    console.log("");
  }

  const rows = [];
  const telemetry = [];
  let done = 0;

  for (let i = 0; i < opt.jobs; i++) {
    const m = fleet[Math.floor(rnd() * fleet.length)];
    const job = scheduleJob(rnd, models);
    const sim = m.ctx.sim;

    H.resetForNextJob(sim, { newSpool: m.jobs > 0 && m.jobs % 25 === 0 });
    const r = H.runJob({ sim, bus: m.ctx.bus, model: job.model, settings: job.settings });
    m.jobs++;

    const durMin = Math.max(1, Math.round(r.elapsedSec / 60));
    const g = Math.round(r.usedG * 10) / 10;
    const kwh = Math.round((durMin / 60) * (job.material === "ABS" ? 0.34 : 0.24) * 100) / 100;
    const dayOff = Math.floor(rnd() * 21);
    const date = new Date(startMs + dayOff * 86400000).toISOString().slice(0, 10);

    rows.push({
      job_id: "FARM-" + String(10001 + i).slice(1),
      date,
      machine_id: r.machineId,
      model_name: job.model.name,
      material: job.material,
      layer_height_mm: job.settings.layerHeight,
      duration_min: durMin,
      filament_g: g,
      cost_fen: D.costFen(job.material, g, kwh, durMin),
      status: r.status,
      fail_reason: r.status === "fail" ? normalizeFault(r.fault) : "",
      energy_kwh: kwh,
    });

    const t = r.telemetry || {};
    telemetry.push({
      job_id: rows[rows.length - 1].job_id,
      machine_id: r.machineId,
      status: r.status,
      raw_fault: r.fault || null,
      nozzle_temp_c: job.settings.nozzleTemp,
      bed_temp_c: job.settings.bedTemp,
      speed_mm_s: job.settings.speed,
      support_enabled: job.settings.supportEnabled,
      layers: r.layers,
      clog_load_max: round2(t.clogLoadMax),
      slip_risk_max: round2(t.slipRiskMax),
      warp_risk: t.warpRisk != null ? t.warpRisk : null,
      overhang_risk: t.overhangRisk != null ? t.overhangRisk : null,
      temp_dev_max_c: round2(t.tempDevMax),
      first_layer_uneven_mm: round3(t.firstLayerUneven),
      leveled: !!t.leveled,
      quality_score: r.quality ? r.quality.score : null,
    });

    done++;
    if (!opt.quiet && done % 25 === 0) process.stdout.write(`  已完成 ${done}/${opt.jobs}\r`);
  }

  report(rows, telemetry, fleet, opt);

  if (opt.out) {
    ensureDir(opt.out);
    fs.writeFileSync(opt.out, "﻿" + D.toCsv(rows) + "\n", "utf8");
    console.log(`\n生产数据已写入：${opt.out}（${rows.length} 行）`);
  }
  if (opt.json) {
    ensureDir(opt.json);
    fs.writeFileSync(
      opt.json,
      JSON.stringify(
        {
          generator: "tools/farm-sim.js",
          version: 1,
          seed: opt.seed,
          machines: fleet.map((m) => m.profile),
          jobs: telemetry,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`遥测数据已写入：${opt.json}`);
  }
  if (opt.emitJs) {
    ensureDir(opt.emitJs);
    fs.writeFileSync(opt.emitJs, emitJsModule(rows, fleet, opt), "utf8");
    console.log(`前端数据模块已写入：${opt.emitJs}`);
  }
}

/**
 * 生成前端可内联加载的数据模块。
 * 为什么不直接 fetch CSV：前端要保持 `file://` 双击直开可用，
 * 那个协议下 fetch 本地文件会被浏览器拦截。内联成经典脚本是唯一不牺牲该特性的方案。
 * 数据以 CSV 文本内嵌，加载时用既有的 parseCsv 还原——口径与上传路径完全一致。
 */
function emitJsModule(rows, fleet, opt) {
  const csv = D.toCsv(rows);
  const machines = fleet.map((m) => ({
    id: m.profile.id,
    modelTag: m.profile.modelTag,
    enclosed: m.profile.enclosed,
    hotendFouling: m.profile.hotendFouling,
    feederGrip: m.profile.feederGrip,
    spoolDrag: m.profile.spoolDrag,
    heaterHealth: m.profile.heaterHealth,
    ambientC: m.profile.ambientC,
    draft: m.profile.draft,
  }));
  return `/* FORGE·X — 内置机群仿真数据集（自动生成，请勿手工编辑）

   生成方式：node tools/farm-sim.js --machines ${opt.machines} --jobs ${opt.jobs} --seed ${opt.seed} --emit-js ${opt.emitJs}

   这份数据由**物理仿真**产出，不是概率抽样：
   ${machines.length} 台虚拟机器各有确定性的固有物理特征（热端积碳、送料咬合力、
   加热器功率、料架阻力、环境温度、风扰），仿真按这些特征真实演化，
   故障是「特征 × 本单工艺参数」相互作用的结果。同 seed 完全可复现。

   它仍然不是真实产线数据——但它与旧的合成数据有本质区别：
   旧数据把「03 号机故障率 20%」写死进生成器，分析引擎只是把它读回来；
   这份数据里没有任何一台机器被指定过故障率，机台间的差异是算出来的。

   数据以 CSV 文本内嵌，加载时用 FXInsightData.parseCsv 还原，
   与用户上传路径完全同口径。内嵌而非 fetch 是为了保持 file:// 直开可用。 */
(function (root) {
  "use strict";

  root.FXFarmDataset = {
    version: 1,
    seed: ${opt.seed},
    generator: "tools/farm-sim.js",
    machines: ${JSON.stringify(machines, null, 2).split("\n").join("\n    ")},
    csv: ${JSON.stringify(csv)},
    /** 解析为行数据（惰性，只算一次） */
    rows: function () {
      if (!this._rows) this._rows = root.FXInsightData.parseCsv(this.csv).rows;
      return this._rows;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
`;
}

/** 仿真故障名 → 标准故障类型。规则收敛在数据层（单一真源），此处只做转发。 */
const normalizeFault = (name) => D.normalizeFault(name);

/* ── 汇总输出 ─────────────────────────────── */

function report(rows, telemetry, fleet, opt) {
  const total = rows.length;
  const fails = rows.filter((r) => r.status === "fail");
  console.log(`\n\n═══ 汇总：${total} 单，失败 ${fails.length}（${pct(fails.length / total)}） ═══\n`);

  console.log("按机台（失败率由高到低）");
  const byM = groupBy(rows, "machine_id");
  const mRows = Object.keys(byM)
    .map((id) => {
      const g = byM[id];
      const f = g.filter((r) => r.status === "fail");
      const prof = fleet.find((m) => m.profile.id === id);
      return { id, n: g.length, f: f.length, rate: f.length / g.length, prof: prof && prof.profile };
    })
    .sort((a, b) => b.rate - a.rate);
  for (const r of mRows) {
    const reasons = topReasons(byM[r.id]);
    console.log(
      `  ${r.id.padEnd(13)} ${String(r.f).padStart(3)}/${String(r.n).padEnd(4)} ${pct(r.rate).padStart(6)}` +
        `   主因：${reasons || "—"}` +
        (r.prof
          ? `   [积碳 ${r.prof.hotendFouling.toFixed(2)} 咬合 ${r.prof.feederGrip.toFixed(2)} 加热 ${r.prof.heaterHealth.toFixed(2)}]`
          : "")
    );
  }

  console.log("\n按材料");
  const byMat = groupBy(rows, "material");
  for (const k of Object.keys(byMat).sort()) {
    const g = byMat[k];
    const f = g.filter((r) => r.status === "fail");
    console.log(
      `  ${k.padEnd(6)} ${String(f.length).padStart(3)}/${String(g.length).padEnd(4)} ${pct(f.length / g.length).padStart(6)}   主因：${topReasons(g) || "—"}`
    );
  }

  console.log("\n故障类型分布");
  const byR = groupBy(fails, "fail_reason");
  for (const k of Object.keys(byR).sort((a, b) => byR[b].length - byR[a].length)) {
    console.log(
      `  ${k.padEnd(10)} ${String(byR[k].length).padStart(3)} 次（占失败 ${pct(byR[k].length / Math.max(1, fails.length))}）`
    );
  }

  // 交互效应：单看机台或单看材料都发现不了的组合问题，是这份数据最有价值的部分
  console.log("\n机台 × 材料 交互（失败率 ≥ 40% 且样本 ≥ 3 的组合）");
  const combo = {};
  for (const r of rows) {
    const k = r.machine_id + " × " + r.material;
    (combo[k] = combo[k] || []).push(r);
  }
  let found = 0;
  for (const k of Object.keys(combo)) {
    const g = combo[k];
    if (g.length < 3) continue;
    const f = g.filter((r) => r.status === "fail");
    if (f.length / g.length < 0.4) continue;
    found++;
    console.log(`  ${k.padEnd(24)} ${f.length}/${g.length} ${pct(f.length / g.length).padStart(6)}   ${topReasons(g)}`);
  }
  if (!found) console.log("  （无显著组合）");

  if (!opt.quiet) {
    console.log("\n物理证据抽样（失败单的负载峰值）");
    const shown = telemetry.filter((t) => t.status === "fail").slice(0, 6);
    for (const t of shown) {
      console.log(
        `  ${t.job_id} ${t.machine_id.padEnd(12)} ${String(t.raw_fault).padEnd(14)}` +
          ` clog=${t.clog_load_max} slip=${t.slip_risk_max} warp=${t.warp_risk} over=${t.overhang_risk}` +
          ` 喷嘴设定=${t.nozzle_temp_c}°C`
      );
    }
  }
}

/* ── 小工具 ───────────────────────────────── */

function groupBy(rows, key) {
  const m = {};
  for (const r of rows) (m[r[key]] = m[r[key]] || []).push(r);
  return m;
}
function topReasons(rows) {
  const f = rows.filter((r) => r.status === "fail");
  const c = {};
  for (const r of f) c[r.fail_reason] = (c[r.fail_reason] || 0) + 1;
  return Object.keys(c)
    .sort((a, b) => c[b] - c[a])
    .slice(0, 2)
    .map((k) => `${k}×${c[k]}`)
    .join(" ");
}
function pct(x) {
  return (x * 100).toFixed(1) + "%";
}
function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}
function round3(v) {
  return v == null ? null : Math.round(v * 1000) / 1000;
}
function ensureDir(file) {
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (require.main === module) main();

module.exports = { buildFleet, scheduleJob, normalizeFault, parseArgs, MATERIAL_PRESET };
