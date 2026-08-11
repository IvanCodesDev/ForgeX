/* FORGE·X 智造洞察测试（node tests/insight.test.js）
   覆盖：合成数据生成 / CSV 解析与回环 / 成本口径 / 聚合统计 / 相关系数 / 意图识别 /
        报告结构 / 统计守卫（最小样本量）/ 来源标记（provenance）

   ⚠ 测试原则：断言引擎的**性质**，不断言「生成器埋了什么就挖出什么」。
   历史教训：本文件曾断言「结论命中示例故事线 FX-256-03」——
   那只是在验证 generateSample 和 analyze 用了同一套常量（同义反复），
   把生成器里的 0.2 改成 0.02 测试就红，但引擎的正确性一点没变。
   现在改为：**自己构造带已知效应的数据集，检验引擎能否正确识别出该效应**。 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("insight-data.js"));
require(J("stats-kernel.js"));
require(J("insight-engine.js"));

const D = globalThis.FXInsightData, E = globalThis.FXInsightEngine;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

/** 构造一批记录：machine 台机器，共 n 单，其中 failN 单失败。用于注入已知效应。 */
function makeRows(machine, n, failN, opts) {
  opts = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const failed = i < failN;
    out.push({
      job_id: machine + "-" + i,
      date: opts.date || "2026-07-" + String(10 + (i % 20)).padStart(2, "0"),
      machine_id: machine,
      model_name: opts.model || "测试件",
      material: opts.material || "PLA",
      layer_height_mm: opts.lh || 0.2,
      duration_min: opts.dur || 100,
      filament_g: 30,
      cost_fen: 300,
      status: failed ? "fail" : "success",
      fail_reason: failed ? (opts.reason || "堵料") : "",
      energy_kwh: 0.4,
    });
  }
  return out;
}

console.log("\n[1] 合成数据生成（结构与确定性，不断言其内容含义）");
const rows = D.generateSample();
{
  check("默认生成 96 条", rows.length === 96, String(rows.length));
  const first = rows[0];
  let fieldsOk = true;
  for (const f of D.FIELDS) if (!(f in first)) { fieldsOk = false; break; }
  check("字段完整（12 列）", fieldsOk, Object.keys(first).join(","));
  check("确定性（同种子同结果）", D.generateSample()[10].job_id === rows[10].job_id && D.generateSample()[10].cost_fen === rows[10].cost_fen);
  const fails = rows.filter((r) => r.status === "fail");
  check("含失败样本（供归因分析）", fails.length >= 8, String(fails.length));
  check("失败行都有故障原因", fails.every((r) => r.fail_reason !== ""));
  check("成功行无故障原因", rows.filter((r) => r.status === "success").every((r) => r.fail_reason === ""));
  check("成本为正整数（分）", rows.every((r) => r.cost_fen > 0 && r.cost_fen === Math.round(r.cost_fen)));
  check("故障类型都在标准词表内", fails.every((r) => D.FAIL_REASONS.indexOf(r.fail_reason) >= 0),
    [...new Set(fails.map((r) => r.fail_reason))].join(","));
  // 关键：这份数据必须自我声明是合成的，否则界面无从标记
  check("声明为合成数据（synthetic=true）", D.PROVENANCE.sample.synthetic === true);
  check("合成数据带生成器与种子（可复现）",
    !!(D.PROVENANCE.sample.generator && D.PROVENANCE.sample.generator.seed),
    JSON.stringify(D.PROVENANCE.sample.generator));
}

console.log("\n[2] 成本口径");
{
  const fen = D.costFen("PLA", 1000, 1, 60);   // 1kg PLA + 1kWh + 1h 机时
  check("1kg PLA + 1kWh + 1h = 69 + 0.6 + 0.12 元", fen === 6900 + 60 + 12, String(fen));
}

console.log("\n[3] CSV 解析");
{
  const csv = [
    "任务编号,日期,机台,模型,材料,层高,耗时,耗材克重,成本元,状态,故障类型,能耗",
    "J1,2026-07-01,FX-256-01,行星齿轮,PLA,0.2,95,34.2,3.51,success,,0.38",
    'J2,2026-07-02,"FX-256,02",传感器支架,ABS,0.2,40,12.0,1.20,失败,翘边,0.22',
  ].join("\n");
  const out = D.parseCsv(csv);
  check("中文表头解析出 2 行", out.rows.length === 2, JSON.stringify(out.errors));
  check("成本元 → 分（3.51 → 351）", out.rows[0].cost_fen === 351, String(out.rows[0].cost_fen));
  check("带引号逗号字段正确切分", out.rows[1].machine_id === "FX-256,02", out.rows[1].machine_id);
  check("中文状态归一化 fail", out.rows[1].status === "fail");
  check("数字字段为 number", typeof out.rows[0].duration_min === "number" && out.rows[0].duration_min === 95);
  const bad = D.parseCsv("a,b\n1,2");
  check("缺少 status 列报错", bad.rows.length === 0 && bad.errors.length > 0, JSON.stringify(bad.errors));
  const dirty = D.parseCsv([
    "machine_id,status,duration_min,cost_fen",
    "M-1,running,20,100",
    "M-2,success,12oops,80",
    "M-3,success,21,90",
  ].join("\n"));
  check("未知状态行不会静默归为 success", dirty.rows.length === 1 && dirty.rows[0].machine_id === "M-3",
    JSON.stringify(dirty));
  check("非法非空数值行不会静默归零", dirty.errors.some((e) => /第 3 行.*duration_min/.test(e)),
    JSON.stringify(dirty.errors));
}

console.log("\n[4] CSV 导出回环");
{
  const text = D.toCsv(rows.slice(0, 5));
  const back = D.parseCsv(text);
  check("导出→再解析行数一致", back.rows.length === 5, String(back.rows.length));
  check("关键字段回环无损", back.rows[0].job_id === rows[0].job_id && back.rows[0].cost_fen === rows[0].cost_fen
    && back.rows[0].status === rows[0].status, JSON.stringify(back.rows[0]));
}

console.log("\n[5] 聚合与统计");
{
  const s = E.stats(rows);
  check("total = ok + fail", s.total === s.ok + s.fail);
  check("良率 + 失败率 = 1", Math.abs(s.yield + s.failRate - 1) < 1e-9);
  const g = E.groupBy(rows, "material");
  let sum = 0;
  for (const k in g) sum += g[k].length;
  check("groupBy 分组行数守恒", sum === rows.length, String(sum));
  const k = E.kpis(rows);
  // 断言 KPI 的**性质**：给出的重点机台必须真实存在、且样本量达标
  check("KPI 重点机台样本量达标", !k.worstMachine || k.worstMachine.n >= E.MIN_SAMPLE,
    JSON.stringify(k.worstMachine));
  check("KPI 重点机台确实是失败率最高者",
    !k.worstMachine || Object.entries(E.groupBy(rows, "machine_id"))
      .filter(([, g2]) => g2.length >= E.MIN_SAMPLE)
      .every(([, g2]) => E.stats(g2).failRate <= k.worstMachine.failRate + 1e-9),
    JSON.stringify(k.worstMachine));
  check("KPI 时间跨度按数据实算（不写死「近三周」）",
    !!(k.dateRange && k.dateRange.from && k.dateRange.to && k.dateRange.days > 0),
    JSON.stringify(k.dateRange));
}

console.log("\n[6] 相关系数");
{
  check("完全正相关 r≈1", Math.abs(E.pearson([[1, 2], [2, 4], [3, 6]]) - 1) < 1e-9);
  check("完全负相关 r≈-1", Math.abs(E.pearson([[1, 6], [2, 4], [3, 2]]) + 1) < 1e-9);
  check("样本不足返回 null", E.pearson([[1, 1], [2, 2]]) === null);
}

console.log("\n[7] 意图识别");
{
  check("机台故障", E.detectIntent("上周哪台机故障率最高") === "machine_fault");
  check("材料对比", E.detectIntent("PLA 和 PETG 在悬垂件上的失败率差多少") === "material_cmp");
  check("层高相关性", E.detectIntent("层高与表面质量的相关性") === "corr_layer");
  check("成本趋势", E.detectIntent("本月单件成本与耗材成本趋势") === "cost_trend");
  check("失败归因", E.detectIntent("失败批次有没有共性") === "fail_root");
  check("兜底 overview", E.detectIntent("随便看看") === "overview");
}

console.log("\n[8] 报告结构（与后端产物同构）");
{
  const qs = [
    "哪台机故障率最高，主要故障是什么",
    "PLA 和 PETG 失败率对比",
    "层高与打印时长的相关性",
    "本月成本趋势",
    "失败批次共性归因",
    "总体概览",
  ];
  let allOk = true, chartOk = true, badEngine = "";
  for (const q of qs) {
    const r = E.analyze(q, rows);
    if (!r.title || !r.verdict || !Array.isArray(r.sections)) allOk = false;
    if (r.engine !== "local-rules") { allOk = false; badEngine = String(r.engine); }
    if (r.chart && (!r.chart.kind || !Array.isArray(r.chart.items))) chartOk = false;
  }
  check("六类问题均产出完整报告", allOk, badEngine && "engine=" + badEngine);
  check("图表结构合法", chartOk);
  // 引擎标识必须自称规则引擎——不得冒充 AI（界面文案据此渲染）
  check("引擎如实标注 local-rules（不冒充 AI）", E.analyze("概览", rows).engine === "local-rules");
  const empty = E.analyze("任何问题", []);
  check("空数据集安全返回", empty.title === "无数据" && empty.chart === null);
  check("空数据集可信度为 insufficient-data", empty.confidence === "insufficient-data", empty.confidence);
}

console.log("\n[9] 统计守卫：最小样本量（防「1 单 1 失败 = 100% 故障率」登顶）");
{
  // 注入已知效应：TINY 只跑 1 单且失败（100%）；BIG 跑 20 单失败 4 次（20%）
  const mix = makeRows("TINY", 1, 1).concat(makeRows("BIG", 20, 4));
  const r = E.analyze("哪台机故障率最高", mix);
  check("样本不足的机台不被评为最差", r.highlight && r.highlight.id === "BIG",
    JSON.stringify(r.highlight));
  check("结论不指向 1 单样本的机台", r.verdict.indexOf("TINY") < 0, r.verdict);
  check("图表仍展示样本不足的机台但标记 weak",
    r.chart.items.some((it) => it.label === "TINY" && it.weak === true),
    JSON.stringify(r.chart.items));
  check("样本不足的机台在报告中被列出",
    JSON.stringify(r.sections).indexOf("TINY") >= 0);

  // 全部机台都样本不足时，必须明说无法排名，而不是硬挑一个
  const allTiny = makeRows("A", 2, 2).concat(makeRows("B", 1, 0));
  const r2 = E.analyze("哪台机故障率最高", allTiny);
  check("全员样本不足 → 拒绝排名", r2.highlight === null, JSON.stringify(r2.highlight));
  check("全员样本不足 → 可信度 insufficient-data", r2.confidence === "insufficient-data", r2.confidence);
  check("全员样本不足 → 结论明说样本不足", r2.verdict.indexOf("样本不足") >= 0, r2.verdict);
}

console.log("\n[10] 已知效应识别（构造数据 → 引擎能否找出来）");
{
  // 注入：BAD 失败率 40%（n=20），OK 失败率 5%（n=20）——两者样本量都达标
  const ds = makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1));
  const r = E.analyze("哪台机故障率最高", ds);
  check("识别出注入的高故障机台", r.highlight && r.highlight.id === "BAD", JSON.stringify(r.highlight));
  check("结论中报出真实失败率 40%", r.verdict.indexOf("40.0%") >= 0, r.verdict);
  check("结论中报出样本量", r.verdict.indexOf("8/20") >= 0, r.verdict);

  // 反向注入：把效应调转，引擎必须跟着变（证明它在算数据，不是在读常量）
  const flipped = makeRows("BAD", 20, 1).concat(makeRows("OK", 20, 8));
  const r2 = E.analyze("哪台机故障率最高", flipped);
  check("效应调转后结论随之调转", r2.highlight && r2.highlight.id === "OK", JSON.stringify(r2.highlight));
}

console.log("\n[11] 诚实性：来源标记 / 未识别问题 / 机台 ID");
{
  const r = E.analyze("概览", rows, { provenance: D.PROVENANCE.sample });
  check("报告携带 provenance", !!r.provenance && r.provenance.synthetic === true, JSON.stringify(r.provenance));

  const unknown = E.analyze("今天天气怎么样", rows);
  check("未匹配到分析维度时如实标注", unknown.intentMatched === false, String(unknown.intentMatched));
  check("未匹配时标题写明「未识别」", unknown.title.indexOf("未识别") >= 0, unknown.title);
  check("未匹配时列出支持的维度",
    JSON.stringify(unknown.sections).indexOf(E.SUPPORTED[0]) >= 0);
  const matched = E.analyze("哪台机故障率最高", rows);
  check("匹配到维度时 intentMatched=true", matched.intentMatched === true);

  // 机台 ID 必须来自仿真器实际装载的机型，不再写死 FX-256-01
  check("机台 ID 取自当前机型（FX-500）",
    D.machineIdFromSim({ printer: { MODEL_TAG: "FX-500" } }) === "FX-500-01",
    D.machineIdFromSim({ printer: { MODEL_TAG: "FX-500" } }));
  check("机台 ID 取自当前机型（FX-Δ260）",
    D.machineIdFromSim({ printer: { MODEL_TAG: "FX-Δ260" } }) === "FX-Δ260-01");
  check("无机型信息时不冒充具体机台",
    D.machineIdFromSim({}) === "UNKNOWN-01", D.machineIdFromSim({}));

  // 故障词表：P2 起五类故障已全部可由物理仿真产生（三类运行中报警 + 两类完成时判废）
  check("仿真可产故障全部在标准词表内",
    D.SIM_FAULTS.every((f) => D.FAIL_REASONS.indexOf(f) >= 0), D.SIM_FAULTS.join(","));
  check("词表覆盖运行中报警与完成时判废两个阶段",
    D.FAULT_TAXONOMY.some((f) => f.stage === "runtime") && D.FAULT_TAXONOMY.some((f) => f.stage === "scrap"));
  check("未知故障有独立取值，不并入任何具体故障",
    D.FAIL_REASONS.indexOf(D.FAULT_UNKNOWN) < 0, D.FAULT_UNKNOWN);
  check("normalizeFault 不猜：无法归类返回「未知」",
    D.normalizeFault("某种没见过的错误") === D.FAULT_UNKNOWN);
}

console.log("\n[12] 计价口径可溯与可替换");
{
  check("计价口径带出处说明", !!(D.COST_PROFILE.source && D.COST_PROFILE.id), D.COST_PROFILE.id);
  const before = D.costFen("PLA", 1000, 0, 0);
  D.setCostProfile({ id: "test", material: { PLA: 10000 } });
  const after = D.costFen("PLA", 1000, 0, 0);
  check("替换计价口径后金额随之变化", before === 6900 && after === 10000, `${before} → ${after}`);
  check("未覆盖的字段沿用原值", D.COST_PROFILE.powerFenPerKwh === 60, String(D.COST_PROFILE.powerFenPerKwh));
  // 还原，避免影响后续用例
  D.setCostProfile({ id: "cn-retail-2026q3", material: { PLA: 6900, PETG: 8900, ABS: 7900, TPU: 15900 } });
  check("未知材料落到兜底单价", D.costFen("UNOBTAINIUM", 1000, 0, 0) === D.COST_PROFILE.materialDefaultFen);
}

console.log("\n[13] 统计严谨性：结论必须带证据，不显著必须明说");
{
  // 真差异：8/20 vs 1/20，Fisher p≈0.02
  const strong = E.analyze("哪台机故障率最高", makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1)));
  check("显著差异 → 结论断言「显著高于」", strong.verdict.indexOf("显著高于") >= 0, strong.verdict);
  check("显著差异 → 结论带 p 值", /p[<=]/.test(strong.verdict), strong.verdict);
  check("显著差异 → 结论带置信区间", strong.verdict.indexOf("95%CI") >= 0, strong.verdict);
  check("显著差异 → 可信度不为 low", strong.confidence !== "low", strong.confidence);

  // 噪声差异：5/20 vs 4/20，不应被当成结论
  const weak = E.analyze("哪台机故障率最高", makeRows("A", 20, 5).concat(makeRows("B", 20, 4)));
  check("噪声差异 → 结论明说「未达统计显著」", weak.verdict.indexOf("未达统计显著") >= 0, weak.verdict);
  check("噪声差异 → 可信度降为 low", weak.confidence === "low", weak.confidence);
  check("噪声差异 → 不出现「显著高于」这类断言", weak.verdict.indexOf("显著高于") < 0, weak.verdict);
  // 仍给出定位入口，但措辞不得让用户以为已定论
  check("噪声差异 → 仍提供 highlight 供排查", !!weak.highlight, JSON.stringify(weak.highlight));

  // evidence 契约
  check("报告带 evidence 数组", Array.isArray(strong.evidence) && strong.evidence.length > 0,
    JSON.stringify(strong.evidence && strong.evidence.length));
  const ev = strong.evidence[0];
  check("evidence 含 claim / method / n / pValue",
    !!(ev.claim && ev.method && typeof ev.n === "number" && typeof ev.pValue === "number"), JSON.stringify(ev));
  check("evidence 的 method 写明具体检验", /Fisher/.test(ev.method), ev.method);
  check("空数据集也有 evidence 字段（哪怕为空）", Array.isArray(E.analyze("x", []).evidence));
}

console.log("\n[14] 混杂因素：层高分析必须给出两个口径");
{
  // 构造辛普森结构：组内层高↑时长↓，但 TPU 组整体又慢又用大层高 → 粗相关为正
  const ds = [];
  const push = (mat, lh, dur, n) => {
    for (let i = 0; i < n; i++) ds.push({
      job_id: `${mat}-${lh}-${i}`, date: "2026-07-01", machine_id: "M1",
      model_name: "件A", material: mat, layer_height_mm: lh,
      duration_min: dur + i, filament_g: 30, cost_fen: 300,
      status: "success", fail_reason: "", energy_kwh: 0.4,
    });
  };
  push("PLA", 0.12, 60, 6); push("PLA", 0.28, 40, 6);     // 组内：层高↑ 时长↓
  push("TPU", 0.12, 200, 6); push("TPU", 0.28, 180, 6);   // 同上，但整体慢得多

  const r = E.analyze("层高与打印时长的相关性", ds);
  check("同时给出未控制与已控制两个口径",
    JSON.stringify(r.sections).indexOf("未控制混杂") >= 0 &&
    JSON.stringify(r.sections).indexOf("控制材料与模型后") >= 0);
  check("结论以偏相关为主口径", r.verdict.indexOf("控制材料与模型后") >= 0, r.verdict);
  check("偏相关识别出真实的负向关系", /r=-/.test(r.verdict), r.verdict);
  check("明确声明相关不等于因果",
    JSON.stringify(r.sections).indexOf("相关不等于因果") >= 0);
  check("evidence 记录了两个口径", r.evidence.length >= 2, String(r.evidence.length));
  check("偏相关的 evidence 写明控制了哪些变量",
    r.evidence.some((e) => /控制材料与模型/.test(e.claim)), JSON.stringify(r.evidence.map((e) => e.claim)));
}

console.log("\n[15] KPI 与分析器口径一致（不再各自为政）");
{
  const ds = makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1)).concat(makeRows("TINY", 2, 2));
  const k = E.kpis(ds);
  const r = E.analyze("哪台机故障率最高", ds);
  check("KPI 与分析器指向同一台机器", k.worstMachine.id === r.highlight.id,
    `${k.worstMachine.id} vs ${r.highlight.id}`);
  check("KPI 的 worstMachine 带置信区间", !!(k.worstMachine.ci && k.worstMachine.ci.lo >= 0));
  check("KPI 的 worstMachine 带显著性标记", typeof k.worstMachine.significant === "boolean");
  check("样本不足的机台不进 KPI", k.worstMachine.id !== "TINY", k.worstMachine.id);
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
