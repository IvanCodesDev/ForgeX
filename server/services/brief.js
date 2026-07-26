/* 统计简报（Statistical Brief）—— 喂给 AI provider 的输入。

   这个模块是 P3 架构的关键一环，它同时解决三个问题：

   ① **云端产物不再弱于本地**
      旧做法是把整份 CSV 丢给 LLM，让它自己算、自己下结论，回来只有一段文字：
      没有图表、没有视口联动、数字无从校验。接上真 AI 反而功能更少。
      新做法是本地统计核先算好一切（含置信区间与显著性检验），
      LLM 只拿**已验证的事实**去组织叙述——图表与 highlight 始终由本地产出。

   ② **token 成本与数据量解耦**
      400 行 CSV ≈ 32KB；同一份数据的统计简报 ≈ 2KB，且行数再涨十倍也不会变大。
      上万行数据从此不会超限。

   ③ **数字不再由 LLM 心算**
      LLM 擅长组织语言，不擅长在上下文里做聚合统计与假设检验。
      让它复述已经算准的数，比让它自己算安全得多——
      这也意味着叙述里的每个数字都能在 evidence 里找到出处。 */
"use strict";

const engine = require("./local-engine");
const ST = engine.stats;

/** 数字格式化：保持与前端一致的口径 */
const pct = (x) => (x * 100).toFixed(1) + "%";
const yuan = (fen) => (fen / 100).toFixed(2);

/**
 * 由数据行构建统计简报。
 * @returns {{text, facts}} text 给 LLM 读；facts 保留结构化形式供服务端复用
 */
function buildBrief(rows) {
  const E = engine.engineApi;
  const s = E.stats(rows);
  const range = E.dateRange(rows);
  const minN = engine.MIN_SAMPLE;

  const facts = {
    rowCount: rows.length,
    dateRange: range,
    overall: {
      total: s.total, fail: s.fail, failRate: s.failRate,
      failRateCi: ST.wilson(s.fail, s.total),
      avgCostFen: s.avgCostFen, filamentG: s.filamentG, energyKwh: s.energyKwh,
    },
    machines: rankFacts(E, ST, rows, "machine_id", minN),
    materials: rankFacts(E, ST, rows, "material", minN),
    models: rankFacts(E, ST, rows, "model_name", minN),
    faults: faultFacts(E, ST, rows),
    layerHeight: layerFacts(E, ST, rows),
    costTrend: trendFacts(E, ST, rows),
  };

  const L = [];
  L.push("## 数据集概况");
  L.push(`- 记录数：${facts.rowCount}`);
  if (range) L.push(`- 时间跨度：${range.label}`);
  L.push(`- 总体失败率：${ST.fmtRateCi(facts.overall.failRateCi)}（${s.fail}/${s.total}）`);
  L.push(`- 良品平均成本：¥${yuan(s.avgCostFen)}；耗材合计 ${(s.filamentG / 1000).toFixed(2)} kg；能耗 ${s.energyKwh.toFixed(1)} kWh`);

  pushRank(L, "机台失败率排行", facts.machines, ST, minN);
  pushRank(L, "材料失败率排行", facts.materials, ST, minN);
  pushRank(L, "模型失败率排行", facts.models, ST, minN);

  if (facts.faults.length) {
    L.push("");
    L.push("## 故障类型分布（占全部失败的比例）");
    for (const f of facts.faults) {
      L.push(`- ${f.name}：${f.n} 次，${ST.fmtRateCi(f.ci)}`);
    }
  }

  if (facts.layerHeight) {
    const lh = facts.layerHeight;
    L.push("");
    L.push("## 层高与打印时长");
    if (lh.raw) {
      L.push(`- 未控制混杂：r=${lh.raw.r.toFixed(3)}（n=${lh.raw.n}，${ST.fmtP(lh.raw.pValue)}）`);
    }
    if (lh.partial) {
      L.push(`- 控制材料与模型后：r=${lh.partial.r.toFixed(3)}（n=${lh.partial.n}，${lh.partial.groups} 组，${ST.fmtP(lh.partial.pValue)}）`);
      L.push("- ⚠ 应以偏相关为准；相关不等于因果。");
    }
    for (const b of lh.buckets) {
      L.push(`- ${b.lh.toFixed(2)}mm：平均 ${b.avgDur} 分钟，n=${b.n}${b.n < minN ? "（样本不足）" : ""}`);
    }
  }

  if (facts.costTrend) {
    const t = facts.costTrend;
    L.push("");
    L.push("## 成本");
    L.push(`- 总成本 ¥${yuan(t.totalFen)}，失败损耗 ¥${yuan(t.failLossFen)}（占 ${pct(t.totalFen ? t.failLossFen / t.totalFen : 0)}）`);
    if (t.trend) {
      const word = { up: "上升", down: "下降", flat: "无显著趋势" }[t.trend.direction];
      L.push(`- 每日成本趋势：${word}（Mann-Kendall τ=${t.trend.tau.toFixed(3)}，${ST.fmtP(t.trend.pValue)}，${t.trend.n} 个日期点）`);
    }
  }

  L.push("");
  L.push("## 统计口径说明（务必遵守）");
  L.push(`- 分组样本量 < ${minN} 的一律不参与排名，上面已标注。`);
  L.push("- 「显著」一词只在标注了「显著高于其余」的条目上使用，其余情况必须说明差异未达显著。");
  L.push("- 所有比例都给了 95% 置信区间，请连同区间一起表述，不要只报点估计。");

  return { text: L.join("\n"), facts };
}

function rankFacts(E, ST, rows, key, minN) {
  const by = E.groupBy(rows, key);
  const groups = Object.keys(by).map((k) => {
    const st = E.stats(by[k]);
    return { key: k, k: st.fail, n: st.total };
  });
  const rank = ST.rankByRate(groups, { minSample: minN });
  return {
    ranked: rank.ranked.map((g) => ({
      key: g.key, k: g.k, n: g.n, rate: g.rate,
      ci: [g.ci.lo, g.ci.hi], pValue: g.pValue, significant: g.significant,
    })),
    skipped: rank.skipped.map((x) => ({ key: x.key, k: x.k, n: x.n })),
    worst: rank.worst ? rank.worst.key : null,
    fleetRate: rank.fleet.rate,
  };
}

function pushRank(L, title, r, ST, minN) {
  if (!r.ranked.length && !r.skipped.length) return;
  L.push("");
  L.push("## " + title);
  r.ranked.forEach((g, i) => {
    L.push(`${i + 1}. ${g.key}：${pct(g.rate)}（95%CI ${pct(g.ci[0])}–${pct(g.ci[1])}），n=${g.n}，失败 ${g.k}` +
      (g.significant ? `　← **显著高于其余**（${ST.fmtP(g.pValue)}）` : `　（与其余差异未达显著，${ST.fmtP(g.pValue)}）`));
  });
  if (r.skipped.length) {
    L.push(`- 样本不足未参与排名（n < ${minN}）：` + r.skipped.map((x) => `${x.key}(n=${x.n})`).join("、"));
  }
}

function faultFacts(E, ST, rows) {
  const fails = rows.filter((r) => r.status === "fail");
  if (!fails.length) return [];
  const by = E.groupBy(fails, "fail_reason");
  return Object.keys(by)
    .map((k) => ({ name: k, n: by[k].length, ci: ST.wilson(by[k].length, fails.length) }))
    .sort((a, b) => b.n - a.n);
}

function layerFacts(E, ST, rows) {
  const ok = rows.filter((r) => r.status === "success" && r.layer_height_mm > 0 && r.duration_min > 0);
  if (ok.length < 4) return null;
  const raw = ST.pearson(ok.map((r) => [r.layer_height_mm, r.duration_min]));
  const partial = ST.partialCorrelation(ok, "layer_height_mm", "duration_min", ["material", "model_name"]);
  const byLh = E.groupBy(ok, "layer_height_mm");
  const buckets = Object.keys(byLh)
    .map((k) => {
      const st = E.stats(byLh[k]);
      return { lh: parseFloat(k), n: st.total, avgDur: Math.round(st.durMin / Math.max(1, st.total)) };
    })
    .sort((a, b) => a.lh - b.lh);
  return { raw, partial, buckets };
}

function trendFacts(E, ST, rows) {
  const by = E.groupBy(rows, "date");
  const dates = Object.keys(by).sort();
  let totalFen = 0, failLossFen = 0;
  const series = [];
  for (const d of dates) {
    const st = E.stats(by[d]);
    totalFen += st.costFen;
    series.push(st.costFen / 100);
  }
  for (const r of rows) if (r.status === "fail") failLossFen += r.cost_fen || 0;
  return { totalFen, failLossFen, trend: ST.mannKendall(series) };
}

module.exports = { buildBrief };
