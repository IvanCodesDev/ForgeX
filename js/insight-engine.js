/* FORGE·X 智造洞察 — 本地演示分析引擎（纯函数，node 可测）
   职责：对生产数据行做 KPI 汇总与自然语言问题的意图识别 + 聚合分析，
   输出与后端（InfiniSynapse 代理）同构的报告结构，保证后端就绪后 UI 零改动切换。
   报告结构：{ title, verdict, sections:[{h,lines[]}], chart:{kind,title,items:[{label,value,hint,color?}]}, highlight? } */
(function (root) {
  "use strict";

  var E = {};
  var fmtYuan = function (fen) { return (fen / 100).toFixed(2); };
  var pct = function (x) { return (x * 100).toFixed(1) + "%"; };

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

  /** KPI 看板汇总（洞察首屏） */
  E.kpis = function (rows) {
    var s = E.stats(rows);
    var byMachine = E.groupBy(rows, "machine_id");
    var worst = null;
    for (var m in byMachine) {
      var ms = E.stats(byMachine[m]);
      if (ms.total >= 5 && (!worst || ms.failRate > worst.failRate)) worst = { id: m, failRate: ms.failRate };
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

  E.detectIntent = function (question) {
    var q = String(question || "").toLowerCase();
    var best = { id: "overview", score: 0 };
    for (var i = 0; i < INTENTS.length; i++) {
      var score = 0;
      for (var k = 0; k < INTENTS[i].kw.length; k++)
        if (q.indexOf(INTENTS[i].kw[k]) >= 0) score++;
      if (score > best.score) best = { id: INTENTS[i].id, score: score };
    }
    return best.id;
  };

  /* ── 各意图分析器 ─────────────────────────── */

  function machineFault(rows) {
    var by = E.groupBy(rows, "machine_id");
    var items = [], detail = [];
    var worst = null;
    for (var m in by) {
      var s = E.stats(by[m]);
      items.push({ label: m, value: s.failRate, hint: s.fail + "/" + s.total + " 失败" });
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
    var feed = worst && reasonLines.length && (reasonLines[0].indexOf("堵料") === 0 || reasonLines[0].indexOf("断料") === 0);
    detail.push({ h: "故障归因（" + (worst ? worst.id : "—") + "）", lines: reasonLines.length ? reasonLines : ["无失败记录"] });
    detail.push({
      h: "建议",
      lines: worst ? [
        (feed ? "堵料/断料集中，优先检查送料系统：清理挤出齿轮、更换磨损 PTFE 管、校准挤出张力"
              : "失败类型分散，建议结合当班参数与环境温度排查"),
        "为 " + worst.id + " 安排预防性维护，并在维护后连续跟踪 10 个任务的失败率",
      ] : ["数据不足"],
    });
    return {
      title: "机台故障率排行",
      verdict: worst
        ? worst.id + " 故障率最高（" + pct(worst.s.failRate) + "，" + worst.s.fail + "/" + worst.s.total + "），主要故障：" + (reasonLines[0] || "—")
        : "各机台均无失败记录",
      sections: detail,
      chart: { kind: "bar-rate", title: "机台故障率", items: items },
      highlight: worst ? { type: "machine", id: worst.id } : null,
    };
  }

  function materialCmp(rows) {
    var by = E.groupBy(rows, "material");
    var items = [], lines = [];
    for (var m in by) {
      var s = E.stats(by[m]);
      items.push({ label: m, value: s.failRate, hint: s.fail + "/" + s.total + " 失败 · 良品均本 ¥" + fmtYuan(s.avgCostFen) });
      lines.push(m + "：失败率 " + pct(s.failRate) + "（" + s.fail + "/" + s.total + "），良品平均成本 ¥" + fmtYuan(s.avgCostFen));
    }
    items.sort(function (a, b) { return b.value - a.value; });

    // 悬垂件（传感器支架）子集对比——呼应文档用户故事
    var over = rows.filter(function (r) { return r.model_name === "传感器支架"; });
    var overLines = [];
    if (over.length >= 6) {
      var byM = E.groupBy(over, "material");
      for (var mm in byM) {
        var os = E.stats(byM[mm]);
        overLines.push(mm + "：" + pct(os.failRate) + "（" + os.fail + "/" + os.total + "）");
      }
    }
    var verdict = items.length
      ? "失败率最高的材料是 " + items[0].label + "（" + pct(items[0].value) + "）"
      : "无数据";
    var secs = [{ h: "各材料表现", lines: lines }];
    if (overLines.length) secs.push({ h: "悬垂件（传感器支架）分材料失败率", lines: overLines });
    secs.push({
      h: "建议",
      lines: [
        "高失败率材料优先核查温度窗口与风扇设置（ABS 需减风、保温腔体；PETG 降速防拉丝）",
        "悬垂件建议强制启用支撑，并将首层附着方案改为 brim",
      ],
    });
    return {
      title: "材料失败率对比",
      verdict: verdict,
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
    return {
      title: "层高与打印时长 / 质量关系",
      verdict: rDur == null
        ? "样本不足，无法计算相关性"
        : "层高与打印时长呈" + (rDur < -0.5 ? "显著负相关" : rDur < -0.2 ? "负相关" : "弱相关") + "（r=" + rDur.toFixed(2) + "）：层高越大速度越快",
      sections: [
        { h: "分层高统计", lines: lines },
        { h: "建议", lines: [
          "表面质量优先的展示件用 0.12mm；结构件用 0.20mm 平衡效率与强度",
          "0.28mm 草稿档时长最短，但注意悬垂与桥接质量下降，必要时提高风扇转速",
        ] },
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
    return {
      title: "成本趋势与拆解",
      verdict: "期间总成本 ¥" + fmtYuan(totalFen) + "，良品平均单件 ¥" + fmtYuan(all.avgCostFen) + "，失败损耗 ¥" + fmtYuan(failLossFen) + "（占 " + pct(totalFen ? failLossFen / totalFen : 0) + "）",
      sections: [
        { h: "成本拆解", lines: [
          "耗材成本 ≈ ¥" + fmtYuan(Math.round(matFen)) + "（占 " + pct(totalFen ? matFen / totalFen : 0) + "）",
          "能耗 + 机时折旧 ≈ ¥" + fmtYuan(Math.max(0, totalFen - Math.round(matFen))),
          "失败损耗 ¥" + fmtYuan(failLossFen) + " —— 降失败率是最直接的降本抓手",
        ] },
        { h: "建议", lines: [
          "优先整治故障率最高的机台（见「机台故障」分析），失败损耗可线性下降",
          "批量件切 0.28mm 草稿档可再降机时成本约 20–30%",
        ] },
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
    // 共性交叉：失败最多的 机台×模型×材料 组合
    var combo = E.groupBy(fails, "machine_id");
    var worstM = null;
    for (var m in combo) if (!worstM || combo[m].length > combo[worstM].length) worstM = m;
    var lines2 = [];
    if (worstM) {
      lines2.push("失败最集中的机台：" + worstM + "（" + combo[worstM].length + " 次，占 " + pct(fails.length ? combo[worstM].length / fails.length : 0) + "）");
      var byModel = E.groupBy(fails, "model_name");
      var worstMod = null;
      for (var mo in byModel) if (!worstMod || byModel[mo].length > byModel[worstMod].length) worstMod = mo;
      if (worstMod) lines2.push("失败最集中的模型：" + worstMod + "（" + byModel[worstMod].length + " 次）——悬垂结构建议默认开支撑");
    }
    return {
      title: "失败批次归因",
      verdict: rs.length
        ? "TOP 故障：" + rs[0].name + "（" + rs[0].n + " 次）" + (worstM ? "；" + worstM + " 是最需要保养的机台" : "")
        : "本数据集无失败记录",
      sections: [
        { h: "故障类型分布", lines: lines.length ? lines : ["无失败记录"] },
        { h: "共性交叉", lines: lines2.length ? lines2 : ["无"] },
        { h: "预防性维护建议", lines: [
          "堵料/断料多 → 检查送料齿轮与 PTFE 管路，建立 200 小时保养周期",
          "翘边/塌陷多 → 核查热床温度、首层 Z 偏移与支撑策略",
          "热失控出现即停机检查加热块接线与热敏电阻固定",
        ] },
      ],
      chart: { kind: "bar-value", title: "故障类型次数", items: items },
      highlight: worstM ? { type: "machine", id: worstM } : null,
    };
  }

  function overview(rows) {
    var k = E.kpis(rows);
    var byModel = E.groupBy(rows, "model_name");
    var items = [], lines = [];
    for (var m in byModel) {
      var s = E.stats(byModel[m]);
      items.push({ label: m, value: s.total, hint: s.total + " 件 · 失败率 " + pct(s.failRate) });
      lines.push(m + "：" + s.total + " 件，失败率 " + pct(s.failRate));
    }
    return {
      title: "生产概览",
      verdict: "共 " + k.total + " 个任务，良率 " + pct(k.yield) + "，良品平均成本 ¥" + fmtYuan(k.avgCostFen) +
        (k.worstMachine ? "；重点关注 " + k.worstMachine.id + "（故障率 " + pct(k.worstMachine.failRate) + "）" : ""),
      sections: [
        { h: "分模型产量", lines: lines },
        { h: "试试这样问", lines: [
          "「上周哪台机故障率最高，主要故障是什么」",
          "「PLA 和 PETG 在悬垂件上的失败率差多少」",
          "「层高与打印时长的相关性」 · 「本月成本趋势」",
        ] },
      ],
      chart: { kind: "bar-value", title: "分模型任务量", items: items },
      highlight: k.worstMachine ? { type: "machine", id: k.worstMachine.id } : null,
    };
  }

  /** 主入口：问题 + 数据行 → 报告（与后端产物同构） */
  E.analyze = function (question, rows) {
    if (!rows || !rows.length) {
      return { title: "无数据", verdict: "当前数据集为空，请先载入示例数据或上传 CSV", sections: [], chart: null };
    }
    var intent = E.detectIntent(question);
    var fn = { machine_fault: machineFault, material_cmp: materialCmp, corr_layer: corrLayer, cost_trend: costTrend, fail_root: failRoot }[intent] || overview;
    var report = fn(rows);
    report.intent = intent;
    report.rowCount = rows.length;
    report.engine = "local";   // 后端接入后改为 "infinisynapse"
    return report;
  };

  root.FXInsightEngine = E;
})(typeof window !== "undefined" ? window : globalThis);
