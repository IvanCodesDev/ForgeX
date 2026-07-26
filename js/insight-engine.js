/* FORGE·X 智造洞察 — 规则分析引擎（纯函数，node 可测）
   注意：这不是 AI。这是一组确定性的聚合统计 + 关键词意图路由。
   任何界面文案都不得把本引擎称作「AI 分析」——真 AI 走 provider 通道（见 doc/优化文档.md §4.2）。

   职责：对生产数据行做 KPI 汇总与自然语言问题的意图路由 + 聚合分析，
   输出与后端 provider 同构的报告结构，保证切换引擎时 UI 零改动。
   报告结构：{ title, verdict, confidence, sections:[{h,lines[]}],
              chart:{kind,title,items:[{label,value,hint,weak?}]}, highlight?, provenance? } */
(function (root) {
  "use strict";

  var E = {};
  var fmtYuan = function (fen) { return (fen / 100).toFixed(2); };
  var pct = function (x) { return (x * 100).toFixed(1) + "%"; };

  /** 参与「最差/最优」排名所需的最小样本量。
      低于此值的分组只展示、不排名——否则「跑过 1 单且失败」的机台会以 100% 故障率登顶。
      KPI 看板与各分析器必须共用此常量，否则两处口径会打架。 */
  E.MIN_SAMPLE = 5;

  /** 结论可信度（P0 仅按样本量给的粗粒度启发式，不是统计置信度）。
      P3 由 StatsKernel 换成真实置信区间 + 显著性检验，见 doc/优化文档.md §5 P3.1。 */
  E.confidence = function (totalN, rankedGroups) {
    if (!totalN || (rankedGroups != null && rankedGroups < 2)) return "insufficient-data";
    if (totalN < 30) return "low";
    if (totalN < 100) return "medium";
    return "high";
  };

  /* ── 基础聚合 ─────────────────────────────── */

  E.groupBy = function (rows, key) {
    var m = {};
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i][key] == null || rows[i][key] === "" ? "未知" : String(rows[i][key]);
      (m[k] = m[k] || []).push(rows[i]);
    }
    return m;
  };

  E.stats = function (rows) {
    var s = { total: rows.length, fail: 0, durMin: 0, filamentG: 0, costFen: 0, energyKwh: 0 };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status === "fail") s.fail++;
      s.durMin += r.duration_min || 0;
      s.filamentG += r.filament_g || 0;
      s.costFen += r.cost_fen || 0;
      s.energyKwh += r.energy_kwh || 0;
    }
    s.ok = s.total - s.fail;
    s.failRate = s.total ? s.fail / s.total : 0;
    s.yield = s.total ? s.ok / s.total : 0;
    s.avgCostFen = s.ok ? Math.round(s.costFen / s.ok) : 0;   // 成本按良品分摊
    return s;
  };

  /** Pearson 相关系数（样本数不足返回 null） */
  E.pearson = function (pairs) {
    var n = pairs.length;
    if (n < 3) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += pairs[i][0]; sy += pairs[i][1]; }
    var mx = sx / n, my = sy / n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var a = pairs[j][0] - mx, b = pairs[j][1] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    var den = Math.sqrt(dx * dy);
    return den < 1e-9 ? 0 : num / den;
  };

  /** 数据集实际时间跨度 → {from, to, days, label}；无 date 列时返回 null（不得假造「近三周」） */
  E.dateRange = function (rows) {
    var min = null, max = null;
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i].date;
      if (!d) continue;
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
    if (min === null) return null;
    var days = Math.round((Date.parse(max + "T00:00:00Z") - Date.parse(min + "T00:00:00Z")) / 86400000) + 1;
    if (!isFinite(days) || days < 1) days = 1;
    return {
      from: min, to: max, days: days,
      label: days <= 1 ? min : min + " → " + max + "（" + days + " 天）",
    };
  };

  /** KPI 看板汇总（洞察首屏） */
  E.kpis = function (rows) {
    var s = E.stats(rows);
    var byMachine = E.groupBy(rows, "machine_id");
    var worst = null, ranked = 0;
    for (var m in byMachine) {
      var ms = E.stats(byMachine[m]);
      if (ms.total < E.MIN_SAMPLE) continue;          // 与 machineFault 同口径，避免两处结论打架
      ranked++;
      if (!worst || ms.failRate > worst.failRate) worst = { id: m, failRate: ms.failRate, n: ms.total };
    }
    var reasons = E.groupBy(rows.filter(function (r) { return r.status === "fail"; }), "fail_reason");
    var topReason = null;
    for (var k in reasons) {
      if (k !== "未知" && (!topReason || reasons[k].length > topReason.n)) topReason = { name: k, n: reasons[k].length };
    }
    return {
      total: s.total, yield: s.yield, avgCostFen: s.avgCostFen,
      filamentKg: s.filamentG / 1000, energyKwh: s.energyKwh,
      worstMachine: worst, topReason: topReason,
      rankedMachines: ranked, dateRange: E.dateRange(rows),
    };
  };

  /* ── 意图识别（轻量关键词路由） ─────────────── */

  var INTENTS = [
    { id: "machine_fault",  kw: ["机台", "哪台", "故障率", "设备", "机器", "保养", "维护"] },
    { id: "material_cmp",   kw: ["材料", "pla", "petg", "abs", "tpu", "对比", "差多少", "失败率差"] },
    { id: "corr_layer",     kw: ["层高", "相关", "相关性", "表面", "时长关系"] },
    { id: "cost_trend",     kw: ["成本", "耗材成本", "趋势", "花了", "费用", "单件"] },
    { id: "fail_root",      kw: ["失败", "共性", "归因", "原因", "为什么失败", "失败批次"] },
  ];

  /** 本引擎支持的分析维度——「听不懂」时如实告知用户能问什么 */
  E.SUPPORTED = [
    "机台故障率排行与归因",
    "材料失败率对比",
    "层高与打印时长的关系",
    "成本趋势与拆解",
    "失败批次归因",
  ];

  /** 返回 {id, score}。score===0 表示一条关键词都没命中——调用方必须如实告知用户，不得静默当成「概览」。 */
  E.matchIntent = function (question) {
    var q = String(question || "").toLowerCase();
    var best = { id: "overview", score: 0 };
    for (var i = 0; i < INTENTS.length; i++) {
      var score = 0;
      for (var k = 0; k < INTENTS[i].kw.length; k++)
        if (q.indexOf(INTENTS[i].kw[k]) >= 0) score++;
      if (score > best.score) best = { id: INTENTS[i].id, score: score };
    }
    return best;
  };

  E.detectIntent = function (question) {
    return E.matchIntent(question).id;
  };

  /* ── 各意图分析器 ─────────────────────────── */

  function machineFault(rows) {
    var by = E.groupBy(rows, "machine_id");
    var items = [], detail = [];
    var worst = null, ranked = 0, skipped = [];
    for (var m in by) {
      var s = E.stats(by[m]);
      var enough = s.total >= E.MIN_SAMPLE;
      items.push({
        label: m, value: s.failRate, weak: !enough,
        hint: s.fail + "/" + s.total + " 失败" + (enough ? "" : " · 样本不足，不参与排名"),
      });
      if (!enough) { skipped.push(m + "（n=" + s.total + "）"); continue; }
      ranked++;
      if (!worst || s.failRate > worst.s.failRate) worst = { id: m, s: s };
    }
    items.sort(function (a, b) { return b.value - a.value; });

    var reasonLines = [];
    if (worst) {
      var reasons = E.groupBy(by[worst.id].filter(function (r) { return r.status === "fail"; }), "fail_reason");
      var rs = [];
      for (var k in reasons) rs.push({ name: k, n: reasons[k].length });
      rs.sort(function (a, b) { return b.n - a.n; });
      for (var i = 0; i < rs.length; i++) reasonLines.push(rs[i].name + " × " + rs[i].n);
    }

    if (!worst) {
      detail.push({
        h: "为什么没有排名",
        lines: [
          "参与排名需要每台机 ≥ " + E.MIN_SAMPLE + " 个任务，当前没有任何机台达标。",
          skipped.length ? "样本不足的机台：" + skipped.join("、") : "数据集中没有机台字段。",
          "继续积累数据后重新提问即可得到排名。",
        ],
      });
    } else {
      detail.push({ h: "故障归因（" + worst.id + "，n=" + worst.s.total + "）", lines: reasonLines.length ? reasonLines : ["该机台无失败记录"] });
      // 建议由实际统计量驱动：只有当某类故障确实占主导（≥40%）时才给出对应的针对性动作
      var advice = [];
      var topN = reasonLines.length ? parseInt(reasonLines[0].split(" × ")[1], 10) : 0;
      var topName = reasonLines.length ? reasonLines[0].split(" × ")[0] : "";
      var dominant = worst.s.fail > 0 && topN / worst.s.fail >= 0.4;
      if (dominant && (topName === "堵料" || topName === "断料")) {
        advice.push("「" + topName + "」占该机台失败的 " + pct(topN / worst.s.fail) +
          "（" + topN + "/" + worst.s.fail + "），指向送料链路：检查挤出齿轮磨损、PTFE 管内壁、挤出张力。");
      } else if (dominant) {
        advice.push("「" + topName + "」占该机台失败的 " + pct(topN / worst.s.fail) +
          "（" + topN + "/" + worst.s.fail + "），建议围绕该故障类型专项排查。");
      } else if (worst.s.fail > 0) {
        advice.push("故障类型分散（最高一类仅占 " + pct(topN / worst.s.fail) + "），无单一主因，建议结合当班参数与环境温度逐单排查。");
      }
      if (ranked >= 2) {
        var fleet = E.stats(rows);
        advice.push("该机故障率 " + pct(worst.s.failRate) + " vs 机群整体 " + pct(fleet.failRate) +
          "（本引擎未做显著性检验，差异是否统计显著需更多样本判定）。");
      }
      advice.push("维护后建议连续跟踪 " + Math.max(10, E.MIN_SAMPLE * 2) + " 个任务，对比失败率是否回落。");
      detail.push({ h: "建议", lines: advice });
      if (skipped.length) {
        detail.push({ h: "未参与排名", lines: ["以下机台样本不足 " + E.MIN_SAMPLE + " 个任务：" + skipped.join("、")] });
      }
    }

    return {
      title: "机台故障率排行",
      confidence: worst ? E.confidence(rows.length, ranked) : "insufficient-data",
      verdict: worst
        ? worst.id + " 故障率最高（" + pct(worst.s.failRate) + "，" + worst.s.fail + "/" + worst.s.total + "）" +
          (reasonLines.length ? "，主要故障：" + reasonLines[0] : "")
        : "样本不足：没有机台达到 " + E.MIN_SAMPLE + " 个任务的最小样本量，无法给出可信排名",
      sections: detail,
      chart: { kind: "bar-rate", title: "机台故障率", items: items },
      highlight: worst ? { type: "machine", id: worst.id } : null,
    };
  }

  function materialCmp(rows) {
    var by = E.groupBy(rows, "material");
    var items = [], lines = [];
    var worst = null, ranked = 0, skipped = [];
    for (var m in by) {
      var s = E.stats(by[m]);
      var enough = s.total >= E.MIN_SAMPLE;
      items.push({
        label: m, value: s.failRate, weak: !enough,
        hint: s.fail + "/" + s.total + " 失败 · 良品均本 ¥" + fmtYuan(s.avgCostFen) + (enough ? "" : " · 样本不足"),
      });
      lines.push(m + "：失败率 " + pct(s.failRate) + "（" + s.fail + "/" + s.total + "），良品平均成本 ¥" + fmtYuan(s.avgCostFen) +
        (enough ? "" : "　← 样本不足 " + E.MIN_SAMPLE + "，不参与排名"));
      if (!enough) { skipped.push(m); continue; }
      ranked++;
      if (!worst || s.failRate > worst.rate) worst = { name: m, rate: s.failRate, n: s.total };
    }
    items.sort(function (a, b) { return b.value - a.value; });

    // 「问题最集中的模型」上的分材料对比：由数据选出，不写死模型名
    // （旧实现硬编码 model_name === "传感器支架"，用户上传的数据里没有这个中文名，该段会静默消失）
    var byModel = E.groupBy(rows, "model_name");
    var focus = null;
    for (var mo in byModel) {
      var mos = E.stats(byModel[mo]);
      if (mos.total < E.MIN_SAMPLE || mos.fail === 0) continue;
      if (!focus || mos.failRate > focus.s.failRate) focus = { name: mo, s: mos };
    }
    var focusLines = [];
    if (focus) {
      var byM = E.groupBy(byModel[focus.name], "material");
      for (var mm in byM) {
        var os = E.stats(byM[mm]);
        focusLines.push(mm + "：" + pct(os.failRate) + "（" + os.fail + "/" + os.total + "）" +
          (os.total < E.MIN_SAMPLE ? "　← 样本不足" : ""));
      }
    }

    var secs = [{ h: "各材料表现", lines: lines }];
    if (focusLines.length) {
      secs.push({
        h: "失败率最高的模型「" + focus.name + "」上的分材料表现（n=" + focus.s.total + "）",
        lines: focusLines,
      });
    }
    // 建议只在数据支持时给出，不再无条件输出通用工艺套话
    var advice = [];
    if (worst && ranked >= 2) {
      advice.push("失败率最高的是 " + worst.name + "（" + pct(worst.rate) + "，n=" + worst.n +
        "）：优先核查该材料的温度窗口、风扇曲线与首层附着方案。");
    }
    if (focus) {
      advice.push("「" + focus.name + "」整体失败率 " + pct(focus.s.failRate) + "，高于其他模型；若为悬垂结构，核查支撑策略与首层方案。");
    }
    if (skipped.length) {
      advice.push("样本不足未参与排名的材料：" + skipped.join("、") + "（各需 ≥ " + E.MIN_SAMPLE + " 个任务）。");
    }
    if (!advice.length) advice.push("当前数据量不足以给出材料层面的可信建议。");
    secs.push({ h: "建议", lines: advice });

    return {
      title: "材料失败率对比",
      confidence: worst ? E.confidence(rows.length, ranked) : "insufficient-data",
      verdict: worst
        ? "失败率最高的材料是 " + worst.name + "（" + pct(worst.rate) + "，n=" + worst.n + "）"
        : "样本不足：没有材料达到 " + E.MIN_SAMPLE + " 个任务的最小样本量，无法排名",
      sections: secs,
      chart: { kind: "bar-rate", title: "各材料失败率", items: items },
    };
  }

  function corrLayer(rows) {
    var ok = rows.filter(function (r) { return r.status === "success" && r.layer_height_mm > 0; });
    var pairsDur = [], byLh = E.groupBy(ok, "layer_height_mm");
    for (var i = 0; i < ok.length; i++) pairsDur.push([ok[i].layer_height_mm, ok[i].duration_min]);
    var rDur = E.pearson(pairsDur);

    var items = [], lines = [];
    var lhKeys = [];
    for (var k in byLh) lhKeys.push(parseFloat(k));
    lhKeys.sort(function (a, b) { return a - b; });
    for (var j = 0; j < lhKeys.length; j++) {
      var g = byLh[String(lhKeys[j])];
      var s = E.stats(g);
      var avgDur = Math.round(s.durMin / Math.max(1, s.total));
      items.push({ label: lhKeys[j].toFixed(2) + "mm", value: avgDur, hint: "平均 " + avgDur + " 分钟 · " + s.total + " 件" });
      lines.push(lhKeys[j].toFixed(2) + "mm：平均时长 " + avgDur + " 分钟，失败率 " + pct(s.failRate));
    }
    // 混杂因素警告：不同材料/模型的基准耗时差异巨大（例如 TPU 远慢于 PLA），
    // 而材料与层高在样本中并非独立分配，因此这个 r 是「未控制混杂」的粗相关，不能当因果读。
    // P3 由 StatsKernel 提供控制材料/模型后的偏相关，见 doc/优化文档.md §5 P3.1。
    var matN = 0, modN = 0, seenMat = {}, seenMod = {};
    for (var q = 0; q < ok.length; q++) {
      if (ok[q].material && !seenMat[ok[q].material]) { seenMat[ok[q].material] = 1; matN++; }
      if (ok[q].model_name && !seenMod[ok[q].model_name]) { seenMod[ok[q].model_name] = 1; modN++; }
    }
    var confounded = matN > 1 || modN > 1;

    var caveats = [];
    if (confounded) {
      caveats.push("本相关系数**未控制混杂因素**：样本跨 " + matN + " 种材料、" + modN +
        " 种模型，各自的基准耗时差异会混入 r 值。");
      caveats.push("要判断「层高本身」的影响，需固定材料与模型后再比较（或做偏相关）——当前引擎尚不支持。");
    }
    caveats.push("相关不等于因果：本结论只描述数据中的共变关系。");

    return {
      title: "层高与打印时长关系",
      confidence: rDur == null ? "insufficient-data" : (confounded ? "low" : E.confidence(ok.length, lhKeys.length)),
      verdict: rDur == null
        ? "样本不足（有效成功样本 " + ok.length + " 条，需 ≥3），无法计算相关性"
        : "层高与打印时长的相关系数 r=" + rDur.toFixed(2) +
          "（" + (rDur < -0.5 ? "强负相关" : rDur < -0.2 ? "中等负相关" : rDur < 0.2 ? "无明显相关" : "正相关") + "，n=" + ok.length + "）" +
          (confounded ? "；该值未控制材料与模型差异，仅供参考" : ""),
      sections: [
        { h: "分层高统计", lines: lines },
        { h: "读数说明", lines: caveats },
      ],
      chart: { kind: "bar-value", title: "各层高平均时长（分钟）", items: items },
    };
  }

  function costTrend(rows) {
    var by = E.groupBy(rows, "date");
    var dates = [];
    for (var d in by) dates.push(d);
    dates.sort();
    var items = [], totalFen = 0, matFen = 0;
    for (var i = 0; i < dates.length; i++) {
      var s = E.stats(by[dates[i]]);
      totalFen += s.costFen;
      items.push({ label: dates[i].slice(5), value: s.costFen / 100, hint: dates[i] + " · ¥" + fmtYuan(s.costFen) + " · " + s.total + " 件" });
    }
    var priceTab = typeof FXInsightData !== "undefined" ? FXInsightData.PRICE.material : null;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      matFen += (r.filament_g / 1000) * ((priceTab && priceTab[r.material]) || 8000);
    }
    var all = E.stats(rows);
    var failLossFen = 0;
    for (var k = 0; k < rows.length; k++) if (rows[k].status === "fail") failLossFen += rows[k].cost_fen || 0;
    var range = E.dateRange(rows);
    // 成本口径必须随报告一起披露：单价表是可配置的估算值，不是权威数据
    var profile = (typeof FXInsightData !== "undefined" && FXInsightData.COST_PROFILE) || null;

    var advice = [];
    if (failLossFen > 0) {
      advice.push("失败损耗 ¥" + fmtYuan(failLossFen) + " 占总成本 " + pct(totalFen ? failLossFen / totalFen : 0) +
        "：降低失败率是本数据集中最直接的降本项。");
    } else {
      advice.push("本期无失败损耗。");
    }
    advice.push("以上金额按下方口径换算得出；换成你自己的采购价与电价后结论可能变化。");

    return {
      title: "成本趋势与拆解",
      confidence: E.confidence(rows.length, dates.length),
      verdict: "期间（" + (range ? range.label : "时间范围未知") + "）总成本 ¥" + fmtYuan(totalFen) +
        "，良品平均单件 ¥" + fmtYuan(all.avgCostFen) + "，失败损耗 ¥" + fmtYuan(failLossFen) +
        "（占 " + pct(totalFen ? failLossFen / totalFen : 0) + "）",
      sections: [
        { h: "成本拆解", lines: [
          "耗材成本 ≈ ¥" + fmtYuan(Math.round(matFen)) + "（占 " + pct(totalFen ? matFen / totalFen : 0) + "）",
          "能耗 + 机时折旧 ≈ ¥" + fmtYuan(Math.max(0, totalFen - Math.round(matFen))),
          "失败损耗 ¥" + fmtYuan(failLossFen),
        ] },
        { h: "建议", lines: advice },
        { h: "计价口径", lines: profile ? [
          profile.label + "（" + profile.id + "）",
          "材料 " + Object.keys(profile.material).map(function (k2) { return k2 + " ¥" + (profile.material[k2] / 100).toFixed(0) + "/kg"; }).join("、"),
          "电价 ¥" + (profile.powerFenPerKwh / 100).toFixed(2) + "/kWh · 机时折旧 ¥" + (profile.machineFenPerHour / 100).toFixed(2) + "/h",
          "出处：" + profile.source,
        ] : ["计价口径未知（成本列由上传数据直接提供）"] },
      ],
      chart: { kind: "line", title: "每日成本（元）", items: items },
    };
  }

  function failRoot(rows) {
    var fails = rows.filter(function (r) { return r.status === "fail"; });
    var byReason = E.groupBy(fails, "fail_reason");
    var items = [], lines = [];
    var rs = [];
    for (var k in byReason) rs.push({ name: k, n: byReason[k].length });
    rs.sort(function (a, b) { return b.n - a.n; });
    for (var i = 0; i < rs.length; i++) {
      items.push({ label: rs[i].name, value: rs[i].n, hint: rs[i].n + " 次" });
      lines.push(rs[i].name + "：" + rs[i].n + " 次（占失败 " + pct(fails.length ? rs[i].n / fails.length : 0) + "）");
    }
    // 共性交叉：失败最集中的机台 / 模型。
    // 注意「失败次数最多」≠「最该保养」——产量大的机台失败次数自然多，
    // 所以这里同时给出该机台的失败率与样本量，并只在样本量达标时才下「需要保养」的判断。
    var combo = E.groupBy(fails, "machine_id");
    var worstM = null;
    for (var m in combo) if (!worstM || combo[m].length > combo[worstM].length) worstM = m;
    var lines2 = [], maintain = null;
    if (worstM) {
      var mAll = E.stats(rows.filter(function (r) { return String(r.machine_id) === worstM; }));
      lines2.push("失败次数最多的机台：" + worstM + "（" + combo[worstM].length + " 次，占全部失败的 " +
        pct(fails.length ? combo[worstM].length / fails.length : 0) + "）");
      lines2.push("该机台失败率 " + pct(mAll.failRate) + "（" + mAll.fail + "/" + mAll.total + "）" +
        (mAll.total >= E.MIN_SAMPLE ? "" : "　← 样本不足 " + E.MIN_SAMPLE + "，不足以下结论"));
      if (mAll.total >= E.MIN_SAMPLE) maintain = { id: worstM, s: mAll };
      var byModel = E.groupBy(fails, "model_name");
      var worstMod = null;
      for (var mo in byModel) if (!worstMod || byModel[mo].length > byModel[worstMod].length) worstMod = mo;
      if (worstMod) {
        var modAll = E.stats(rows.filter(function (r) { return String(r.model_name) === worstMod; }));
        lines2.push("失败次数最多的模型：" + worstMod + "（" + byModel[worstMod].length + " 次，失败率 " +
          pct(modAll.failRate) + "，n=" + modAll.total + "）");
      }
    }

    // 维护建议按实际出现的故障类型生成，不再无条件罗列全部套话
    var TIPS = {
      "堵料": "堵料：检查挤出齿轮磨损与 PTFE 管内壁，确认热端温度是否偏低导致回抽拉丝堆积。",
      "断料": "断料：检查料架阻力、耗材是否打结，以及断料检测开关的灵敏度。",
      "热失控": "热失控：立即检查加热块接线与热敏电阻固定，这类故障有安全风险，优先处理。",
      "翘边": "翘边：核查热床温度、首层 Z 偏移与附着方案（brim/raft），以及环境风扰。",
      "悬垂塌陷": "悬垂塌陷：核查支撑生成策略与桥接风扇转速。",
    };
    var tips = [];
    for (var t = 0; t < rs.length; t++) {
      if (TIPS[rs[t].name]) tips.push(TIPS[rs[t].name] + "（本期 " + rs[t].n + " 次）");
    }
    if (!tips.length) tips.push(fails.length ? "本期故障类型未在已知词表中，无对应处置建议。" : "本期无失败记录。");

    return {
      title: "失败批次归因",
      confidence: fails.length ? E.confidence(rows.length, rs.length) : "insufficient-data",
      verdict: rs.length
        ? "TOP 故障：" + rs[0].name + "（" + rs[0].n + " 次，占失败 " + pct(rs[0].n / fails.length) + "）" +
          (maintain ? "；" + maintain.id + " 失败最集中（失败率 " + pct(maintain.s.failRate) + "，n=" + maintain.s.total + "）" : "")
        : "本数据集无失败记录",
      sections: [
        { h: "故障类型分布", lines: lines.length ? lines : ["无失败记录"] },
        { h: "共性交叉", lines: lines2.length ? lines2 : ["无"] },
        { h: "针对性处置", lines: tips },
      ],
      chart: { kind: "bar-value", title: "故障类型次数", items: items },
      highlight: maintain ? { type: "machine", id: maintain.id } : null,
    };
  }

  /** matched=false 表示问题没命中任何分析维度——必须在报告里明说，不能假装这就是用户要的答案 */
  function overview(rows, matched) {
    var k = E.kpis(rows);
    var byModel = E.groupBy(rows, "model_name");
    var items = [], lines = [];
    for (var m in byModel) {
      var s = E.stats(byModel[m]);
      items.push({ label: m, value: s.total, hint: s.total + " 件 · 失败率 " + pct(s.failRate) });
      lines.push(m + "：" + s.total + " 件，失败率 " + pct(s.failRate) + (s.total < E.MIN_SAMPLE ? "　← 样本不足" : ""));
    }
    var secs = [];
    if (!matched) {
      secs.push({
        h: "没有匹配到分析维度",
        lines: ["本引擎是规则引擎（非 AI），只能回答下列维度的问题："]
          .concat(E.SUPPORTED.map(function (s2) { return "· " + s2; }))
          .concat(["以下是数据集的总体情况，供参考。"]),
      });
    }
    secs.push({ h: "分模型产量", lines: lines });
    secs.push({ h: "可以这样问", lines: E.SUPPORTED.map(function (s3) { return "· " + s3; }) });

    return {
      title: matched ? "生产概览" : "未识别的问题 · 生产概览",
      confidence: E.confidence(rows.length, k.rankedMachines),
      verdict: (matched ? "" : "未能识别问题对应的分析维度，以下为总体概览：") +
        "共 " + k.total + " 个任务" + (k.dateRange ? "（" + k.dateRange.label + "）" : "") +
        "，良率 " + pct(k.yield) + "，良品平均成本 ¥" + fmtYuan(k.avgCostFen) +
        (k.worstMachine ? "；失败率最高 " + k.worstMachine.id + "（" + pct(k.worstMachine.failRate) + "，n=" + k.worstMachine.n + "）" : ""),
      sections: secs,
      chart: { kind: "bar-value", title: "分模型任务量", items: items },
      highlight: k.worstMachine ? { type: "machine", id: k.worstMachine.id } : null,
    };
  }

  /**
   * 主入口：问题 + 数据行 → 报告（与后端 provider 产物同构）。
   * opts.provenance — 数据来源标记，必须原样带进报告：
   *   合成数据产出的结论不得在任何界面上被当成真实产线结论展示。
   */
  E.analyze = function (question, rows, opts) {
    opts = opts || {};
    var prov = opts.provenance || null;
    if (!rows || !rows.length) {
      return {
        schemaVersion: 1, title: "无数据",
        verdict: "当前数据集为空，请先载入示例数据或上传 CSV",
        confidence: "insufficient-data", sections: [], chart: null,
        intent: "empty", rowCount: 0, engine: "local-rules", provenance: prov,
      };
    }
    var hit = E.matchIntent(question);
    var fn = { machine_fault: machineFault, material_cmp: materialCmp, corr_layer: corrLayer, cost_trend: costTrend, fail_root: failRoot }[hit.id];
    var report = fn ? fn(rows) : overview(rows, hit.score > 0);
    report.schemaVersion = 1;
    report.intent = hit.id;
    report.intentMatched = hit.score > 0;
    report.rowCount = rows.length;
    report.engine = "local-rules";        // 规则引擎，不是 AI；provider 通道会覆写为具体 provider id
    report.provenance = prov;
    if (!report.confidence) report.confidence = E.confidence(rows.length);
    return report;
  };

  root.FXInsightEngine = E;
})(typeof window !== "undefined" ? window : globalThis);
