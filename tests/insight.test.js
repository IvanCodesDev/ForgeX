/* FORGE·X 智造洞察冒烟测试（node tests/insight.test.js）
   覆盖：示例数据生成 / CSV 解析与回环 / 成本口径 / 聚合统计 / 相关系数 / 意图识别 / 各意图报告结构 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("insight-data.js"));
require(J("insight-engine.js"));

const D = globalThis.FXInsightData, E = globalThis.FXInsightEngine;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n[1] 示例数据生成");
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
  const m3 = E.stats(rows.filter((r) => r.machine_id === "FX-256-03"));
  const m1 = E.stats(rows.filter((r) => r.machine_id === "FX-256-01"));
  check("故事线：03 号机故障率显著高于 01 号机", m3.failRate > m1.failRate + 0.08,
    `03=${(m3.failRate * 100).toFixed(1)}% vs 01=${(m1.failRate * 100).toFixed(1)}%`);
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
  check("KPI 找到重点机台 FX-256-03", k.worstMachine && k.worstMachine.id === "FX-256-03",
    k.worstMachine && k.worstMachine.id);
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
  let allOk = true, chartOk = true;
  for (const q of qs) {
    const r = E.analyze(q, rows);
    if (!r.title || !r.verdict || !Array.isArray(r.sections) || r.engine !== "local") allOk = false;
    if (r.chart && (!r.chart.kind || !Array.isArray(r.chart.items))) chartOk = false;
  }
  check("六类问题均产出完整报告", allOk);
  check("图表结构合法", chartOk);
  const mf = E.analyze("哪台机故障率最高", rows);
  check("机台分析给出视口联动 highlight", mf.highlight && mf.highlight.type === "machine" && mf.highlight.id === "FX-256-03",
    JSON.stringify(mf.highlight));
  check("结论命中 03 号机", mf.verdict.indexOf("FX-256-03") >= 0, mf.verdict);
  const empty = E.analyze("任何问题", []);
  check("空数据集安全返回", empty.title === "无数据" && empty.chart === null);
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
