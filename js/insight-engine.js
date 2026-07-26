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

  /** 统计核（js/stats-kernel.js）。所有置信区间、显著性检验、偏相关、趋势都走它。 */
  var ST = typeof FXStats !== "undefined" ? FXStats : (typeof require !== "undefined" ? null : null);

  /** 参与「最差/最优」排名所需的最小样本量。
      低于此值的分组只展示、不排名——否则「跑过 1 单且失败」的机台会以 100% 故障率登顶。
      KPI 看板与各分析器必须共用此常量，否则两处口径会打架。 */
  E.MIN_SAMPLE = ST ? ST.MIN_SAMPLE : 5;

  /**
   * 结论可信度。由**统计证据**决定，不再是单纯的样本量启发式：
   *   high    差异统计显著，且样本量充足
   *   medium  差异统计显著，但样本量偏小（结论方向可信，幅度未必准）
   *   low     未达显著 / 存在未控制的混杂因素 —— 只能当线索，不能当结论
   *   insufficient-data  连排名的资格都不够
   */
  E.confidence = function (totalN, opts) {
    opts = opts || {};
    if (opts.insufficient || !totalN) return "insufficient-data";
    if (opts.significant === false) return "low";
    if (opts.confounded) return "low";
    if (opts.significant === true) return totalN >= 60 ? "high" : "medium";
    // 无显著性可言的场景（如纯描述性概览）退回样本量启发式
    if (totalN < 30) return "low";
    if (totalN < 100) return "medium";
    return "high";
  };

  /** 汇总一组行 → rankByRate 需要的 {key,k,n} 列表 */
  function rateGroups(rows, key) {
    var by = E.groupBy(rows, key);
    var out = [];
    for (var k in by) {
      var s = E.stats(by[k]);
      out.push({ key: k, k: s.fail, n: s.total });
    }
    return out;
  }

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

  /** KPI 看板汇总（洞察首屏）。与 machineFault 走同一套统计核，避免两处结论打架。 */
  E.kpis = function (rows) {
    var s = E.stats(rows);
    var rank = ST.rankByRate(rateGroups(rows, "machine_id"), { minSample: E.MIN_SAMPLE });
    var top = rank.ranked.length ? rank.ranked[0] : null;
    // worstMachine 带上区间与显著性：KPI 卡上要能一眼看出这是「已确认」还是「仅线索」
    var worst = top ? {
      id: top.key, failRate: top.rate, n: top.n,
      ci: top.ci, pValue: top.pValue, significant: top.significant,
    } : null;
    var ranked = rank.ranked.length;
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

  /**
   * 机台故障率排行。
   *
   * 与重构前的关键区别：不再是「谁的比例大谁最差」。
   * 6/20 和 3/10 的失败率都是 30%，但证据强度完全不同；1/2 和 40/80 更是天差地别。
   * 现在每组给 Wilson 置信区间，并与「其余各组合并」做 Fisher 精确检验——
   * 只有排第一**且**差异统计显著，才敢说「这台最差」。
   */
  function machineFault(rows) {
    var rank = ST.rankByRate(rateGroups(rows, "machine_id"), { minSample: E.MIN_SAMPLE });
    var by = E.groupBy(rows, "machine_id");
    var evidence = [];

    // 图表：全部机台都画，样本不足的标 weak
    var items = [];
    for (var i = 0; i < rank.ranked.length; i++) {
      var g = rank.ranked[i];
      items.push({
        label: g.key, value: g.rate, weak: false,
        ciLo: g.ci.lo, ciHi: g.ci.hi,        // 前端据此画误差线：让证据强度可见，而不只写在文字里
        hint: g.k + "/" + g.n + " 失败 · 95%CI " + pct(g.ci.lo) + "–" + pct(g.ci.hi),
      });
    }
    for (var s = 0; s < rank.skipped.length; s++) {
      var sk = rank.skipped[s];
      items.push({
        label: sk.key, value: sk.ci.p, weak: true,
        ciLo: sk.ci.lo, ciHi: sk.ci.hi,      // 样本不足的组区间极宽，画出来一眼就懂为什么不能排名
        hint: sk.k + "/" + sk.n + " 失败 · " + sk.reason + "，不参与排名",
      });
    }
    items.sort(function (a, b) { return b.value - a.value; });

    var top = rank.ranked.length ? rank.ranked[0] : null;
    var sections = [];

    if (!top) {
      sections.push({
        h: "为什么没有排名",
        lines: [
          "参与排名需要每台机 ≥ " + E.MIN_SAMPLE + " 个任务，当前没有任何机台达标。",
          rank.skipped.length
            ? "样本不足的机台：" + rank.skipped.map(function (x) { return x.key + "（n=" + x.n + "）"; }).join("、")
            : "数据集中没有机台字段。",
          "继续积累数据后重新提问即可得到排名。",
        ],
      });
      return {
        title: "机台故障率排行",
        confidence: "insufficient-data",
        verdict: "样本不足：没有机台达到 " + E.MIN_SAMPLE + " 个任务的最小样本量，无法给出可信排名",
        sections: sections, evidence: evidence,
        chart: { kind: "bar-rate", title: "机台故障率", items: items },
        highlight: null,
      };
    }

    /* 排行表：每台都带区间，一眼能看出「点估计接近但证据强度差很多」 */
    var rankLines = rank.ranked.map(function (g, idx) {
      return (idx + 1) + ". " + g.key + "：" + ST.fmtRateCi(g.ci) + "，n=" + g.n +
        (g.significant ? "　← 显著高于其余机台（" + ST.fmtP(g.pValue) + "）" : "");
    });
    sections.push({ h: "失败率排行（含 95% 置信区间）", lines: rankLines });

    /* 故障归因：只对排第一的机台做，且给出每类故障的占比区间 */
    var fails = by[top.key].filter(function (r) { return r.status === "fail"; });
    var byReason = E.groupBy(fails, "fail_reason");
    var rs = [];
    for (var k in byReason) rs.push({ name: k, n: byReason[k].length });
    rs.sort(function (a, b) { return b.n - a.n; });
    var reasonLines = rs.map(function (r) {
      var ci = ST.wilson(r.n, fails.length);
      return r.name + " × " + r.n + "（占该机台失败 " + ST.fmtRateCi(ci) + "）";
    });
    sections.push({
      h: "故障归因（" + top.key + "，n=" + top.n + "）",
      lines: reasonLines.length ? reasonLines : ["该机台无失败记录"],
    });

    /* 结论与建议：由算出来的统计量驱动，不用模板套话 */
    var advice = [];
    if (top.significant) {
      advice.push(
        top.key + " 的失败率 " + ST.fmtRateCi(top.ci) + " 显著高于其余机台合计 " +
        pct(top.vsRest.rate) + "（" + top.vsRest.k + "/" + top.vsRest.n + "），" +
        "Fisher 精确检验 " + ST.fmtP(top.pValue) + "，优势比 " + top.oddsRatio.toFixed(2) + "。"
      );
      evidence.push(ST.evidence(
        top.key + " 的失败率显著高于其余机台",
        "Fisher 精确检验（2×2，双侧）",
        { n: top.n + top.vsRest.n, pValue: top.pValue, ci95: [top.ci.lo, top.ci.hi], statistic: top.oddsRatio }
      ));
    } else {
      advice.push(
        top.key + " 的失败率 " + ST.fmtRateCi(top.ci) + " 排第一，但与其余机台（" +
        pct(top.vsRest.rate) + "）的差异**未达统计显著**（" + ST.fmtP(top.pValue) + "）——" +
        "以现有样本量还不能断定它更差，把它当线索而不是结论。"
      );
      advice.push("需要多少数据才能判定：各机台样本量翻倍后重新分析，或对该机台专项跟踪 " +
        Math.max(20, top.n) + " 个任务。");
      evidence.push(ST.evidence(
        top.key + " 排名第一但差异未达显著",
        "Fisher 精确检验（2×2，双侧）",
        { n: top.n + top.vsRest.n, pValue: top.pValue, ci95: [top.ci.lo, top.ci.hi] }
      ));
    }

    // 针对性动作只在某类故障确实占主导时给出（占比区间下界 > 40%）
    if (rs.length && fails.length) {
      var domCi = ST.wilson(rs[0].n, fails.length);
      if (domCi.lo > 0.4) {
        var tip = FAULT_ACTION[rs[0].name];
        advice.push("「" + rs[0].name + "」占该机台失败的 " + ST.fmtRateCi(domCi) +
          "，区间下界已超 40%，可判定为主因。" + (tip ? tip : ""));
        evidence.push(ST.evidence(
          "「" + rs[0].name + "」是 " + top.key + " 的主导故障类型",
          "Wilson 置信区间下界 > 40%",
          { n: fails.length, ci95: [domCi.lo, domCi.hi] }
        ));
      } else if (rs.length > 1) {
        advice.push("故障类型分散（最高一类占比区间 " + ST.fmtRateCi(domCi) +
          "，下界未超 40%），无法判定单一主因，建议逐单排查。");
      }
    }
    if (rank.skipped.length) {
      sections.push({
        h: "未参与排名",
        lines: ["以下机台样本不足 " + E.MIN_SAMPLE + " 个任务：" +
          rank.skipped.map(function (x) { return x.key + "（n=" + x.n + "）"; }).join("、")],
      });
    }
    sections.push({ h: "建议", lines: advice });

    return {
      title: "机台故障率排行",
      confidence: E.confidence(rows.length, { significant: top.significant }),
      verdict: top.significant
        ? top.key + " 故障率最高且显著高于其余机台：" + ST.fmtRateCi(top.ci) +
          "（" + top.k + "/" + top.n + "，" + ST.fmtP(top.pValue) + "）" +
          (rs.length ? "，主要故障：" + rs[0].name + " × " + rs[0].n : "")
        : top.key + " 故障率排第一（" + ST.fmtRateCi(top.ci) + "，" + top.k + "/" + top.n +
          "），但与其余机台的差异未达统计显著（" + ST.fmtP(top.pValue) + "），证据不足以判定它更差",
      sections: sections,
      evidence: evidence,
      chart: { kind: "bar-rate", title: "机台故障率（误差线为 95%CI）", items: items },
      // 即使未达显著也给出定位入口：排第一的机台值得看一眼，
      // 但 verdict 与 confidence 会如实说明证据强度，不让用户误以为已经定论。
      highlight: { type: "machine", id: top.key },
    };
  }

  /** 故障类型 → 针对性处置动作。只在该类故障被判定为主因时才附上。 */
  var FAULT_ACTION = {
    "堵料": "指向热端：检查积碳与内壁粗糙度，核对喷嘴温度是否低于材料推荐值、体积流量是否超出材料上限。",
    "断料": "指向送料链路：检查挤出齿轮咬合与磨损、料架阻力，以及料盘余量是否长期偏低。",
    "热失控": "指向加热系统：核查加热器有效功率与热敏电阻固定。这类故障有安全风险，优先处理。",
    "翘边": "指向首层附着：核查热床温度是否低于材料下限、环境温度与风扰，以及是否需要封闭腔体。",
    "悬垂塌陷": "指向支撑策略：核查悬垂面是否启用支撑，以及冷却/层高/速度是否足以成形桥接段。",
  };


  /**
   * 材料失败率对比。同样用 Fisher 检验而不是比大小——
   * ABS 42.9%(n=49) vs PETG 11.4%(n=149) 是真差异；
   * 而 20%(n=10) vs 15%(n=12) 只是噪声，不能拿去改工艺。
   */
  function materialCmp(rows) {
    var rank = ST.rankByRate(rateGroups(rows, "material"), { minSample: E.MIN_SAMPLE });
    var byMat = E.groupBy(rows, "material");
    var evidence = [], sections = [];

    var items = rank.ranked.map(function (g) {
      var s = E.stats(byMat[g.key]);
      return {
        label: g.key, value: g.rate, weak: false,
        ciLo: g.ci.lo, ciHi: g.ci.hi,
        hint: g.k + "/" + g.n + " 失败 · 95%CI " + pct(g.ci.lo) + "–" + pct(g.ci.hi) +
          " · 良品均本 ¥" + fmtYuan(s.avgCostFen),
      };
    }).concat(rank.skipped.map(function (sk) {
      return { label: sk.key, value: sk.ci.p, weak: true, ciLo: sk.ci.lo, ciHi: sk.ci.hi,
        hint: sk.k + "/" + sk.n + " · " + sk.reason };
    }));
    items.sort(function (a, b) { return b.value - a.value; });

    var top = rank.ranked.length ? rank.ranked[0] : null;
    if (!top) {
      return {
        title: "材料失败率对比",
        confidence: "insufficient-data",
        verdict: "样本不足：没有材料达到 " + E.MIN_SAMPLE + " 个任务的最小样本量，无法比较",
        sections: [{ h: "为什么无法比较", lines: rank.skipped.map(function (x) { return x.key + "：n=" + x.n + "，" + x.reason; }) }],
        evidence: evidence,
        chart: { kind: "bar-rate", title: "各材料失败率", items: items },
      };
    }

    sections.push({
      h: "各材料表现（含 95% 置信区间）",
      lines: rank.ranked.map(function (g, i) {
        var s = E.stats(byMat[g.key]);
        return (i + 1) + ". " + g.key + "：失败率 " + ST.fmtRateCi(g.ci) + "，n=" + g.n +
          "，良品均本 ¥" + fmtYuan(s.avgCostFen) +
          (g.significant ? "　← 显著高于其余材料（" + ST.fmtP(g.pValue) + "）" : "");
      }).concat(rank.skipped.map(function (x) { return x.key + "：n=" + x.n + "，" + x.reason + "，不参与排名"; })),
    });

    /* 两两对比：只列出统计显著的材料对，避免用户从一堆噪声差异里挑结论 */
    var pairLines = [];
    for (var i = 0; i < rank.ranked.length; i++) {
      for (var j = i + 1; j < rank.ranked.length; j++) {
        var A = rank.ranked[i], B = rank.ranked[j];
        var cmp = ST.compareRates(A.k, A.n, B.k, B.n);
        if (!cmp.significant) continue;
        pairLines.push(A.key + " vs " + B.key + "：" + pct(A.rate) + " vs " + pct(B.rate) +
          "，差 " + (cmp.diff * 100).toFixed(1) + " 个百分点（" + ST.fmtP(cmp.pValue) +
          "，优势比 " + cmp.oddsRatio.toFixed(2) + "）");
        evidence.push(ST.evidence(A.key + " 的失败率显著高于 " + B.key, "Fisher 精确检验（2×2，双侧）",
          { n: A.n + B.n, pValue: cmp.pValue, statistic: cmp.oddsRatio }));
      }
    }
    sections.push({
      h: "两两对比（仅列统计显著的差异）",
      lines: pairLines.length ? pairLines
        : ["各材料之间的差异均未达统计显著——以现有样本量还分不出高下。"],
    });

    /* 问题最集中的模型上的分材料表现（由数据选出，不写死模型名） */
    var byModel = E.groupBy(rows, "model_name");
    var focus = null;
    for (var mo in byModel) {
      var mos = E.stats(byModel[mo]);
      if (mos.total < E.MIN_SAMPLE || mos.fail === 0) continue;
      if (!focus || mos.failRate > focus.s.failRate) focus = { name: mo, s: mos };
    }
    if (focus) {
      var sub = ST.rankByRate(rateGroups(byModel[focus.name], "material"), { minSample: E.MIN_SAMPLE });
      var subLines = sub.ranked.map(function (g) {
        return g.key + "：" + ST.fmtRateCi(g.ci) + "，n=" + g.n;
      }).concat(sub.skipped.map(function (x) { return x.key + "：n=" + x.n + "，样本不足"; }));
      sections.push({
        h: "失败率最高的模型「" + focus.name + "」上的分材料表现（n=" + focus.s.total + "）",
        lines: subLines.length ? subLines : ["该模型下无足够样本"],
      });
    }

    var advice = [];
    if (top.significant) {
      advice.push(top.key + " 的失败率 " + ST.fmtRateCi(top.ci) + " 显著高于其余材料合计 " +
        pct(top.vsRest.rate) + "（" + ST.fmtP(top.pValue) + "）：优先核查该材料的温度窗口、" +
        "床温下限与环境条件（高收缩材料对腔体与风扰尤其敏感）。");
      evidence.push(ST.evidence(top.key + " 的失败率显著高于其余材料", "Fisher 精确检验（2×2，双侧）",
        { n: top.n + top.vsRest.n, pValue: top.pValue, ci95: [top.ci.lo, top.ci.hi], statistic: top.oddsRatio }));
    } else {
      advice.push(top.key + " 失败率排第一（" + ST.fmtRateCi(top.ci) + "），但与其余材料的差异" +
        "未达统计显著（" + ST.fmtP(top.pValue) + "），不足以据此调整材料选型。");
    }
    if (rank.skipped.length) {
      advice.push("样本不足未参与排名：" + rank.skipped.map(function (x) { return x.key; }).join("、") +
        "（各需 ≥ " + E.MIN_SAMPLE + " 个任务）。");
    }
    sections.push({ h: "建议", lines: advice });

    return {
      title: "材料失败率对比",
      confidence: E.confidence(rows.length, { significant: top.significant }),
      verdict: top.significant
        ? "失败率最高的材料是 " + top.key + "：" + ST.fmtRateCi(top.ci) + "（n=" + top.n +
          "），显著高于其余材料（" + ST.fmtP(top.pValue) + "）"
        : top.key + " 失败率排第一（" + ST.fmtRateCi(top.ci) + "，n=" + top.n +
          "），但差异未达统计显著（" + ST.fmtP(top.pValue) + "）",
      sections: sections,
      evidence: evidence,
      chart: { kind: "bar-rate", title: "各材料失败率（误差线为 95%CI）", items: items },
    };
  }

  /**
   * 层高与打印时长的关系。
   *
   * 这里是全项目最容易得出错误结论的地方：直接算 Pearson r 会把材料混进去——
   * TPU 又慢又常用大层高，PLA 又快又常用小层高，算出来的 r 反映的是「材料」不是「层高」。
   * 所以同时给出两个数：未控制的粗相关，和控制材料+模型后的偏相关。
   * 两者差得远，就说明粗相关是混杂造成的假象。
   */
  function corrLayer(rows) {
    var ok = rows.filter(function (r) { return r.status === "success" && r.layer_height_mm > 0 && r.duration_min > 0; });
    var evidence = [], sections = [];

    var raw = ST.pearson(ok.map(function (r) { return [r.layer_height_mm, r.duration_min]; }));
    var partial = ST.partialCorrelation(ok, "layer_height_mm", "duration_min", ["material", "model_name"]);

    // 分层高统计（描述性，始终给出）
    var byLh = E.groupBy(ok, "layer_height_mm");
    var lhKeys = [];
    for (var k in byLh) lhKeys.push(parseFloat(k));
    lhKeys.sort(function (a, b) { return a - b; });
    var items = [], lines = [];
    for (var j = 0; j < lhKeys.length; j++) {
      var g = byLh[String(lhKeys[j])];
      var s = E.stats(g);
      var avgDur = Math.round(s.durMin / Math.max(1, s.total));
      items.push({
        label: lhKeys[j].toFixed(2) + "mm", value: avgDur, weak: s.total < E.MIN_SAMPLE,
        hint: "平均 " + avgDur + " 分钟 · n=" + s.total + (s.total < E.MIN_SAMPLE ? "（样本不足）" : ""),
      });
      lines.push(lhKeys[j].toFixed(2) + "mm：平均时长 " + avgDur + " 分钟，n=" + s.total +
        (s.total < E.MIN_SAMPLE ? "　← 样本不足" : ""));
    }
    sections.push({ h: "分层高统计（成功任务）", lines: lines.length ? lines : ["无有效样本"] });

    if (!raw) {
      return {
        title: "层高与打印时长关系",
        confidence: "insufficient-data",
        verdict: "有效成功样本仅 " + ok.length + " 条（需 ≥4），无法计算相关性",
        sections: sections, evidence: evidence,
        chart: { kind: "bar-value", title: "各层高平均时长（分钟）", items: items },
      };
    }

    var cmpLines = [
      "未控制混杂：r=" + raw.r.toFixed(3) + "（" + ST.describeR(raw.r) + "，n=" + raw.n +
        "，95%CI " + raw.ci95[0].toFixed(3) + "–" + raw.ci95[1].toFixed(3) + "，" + ST.fmtP(raw.pValue) + "）",
    ];
    evidence.push(ST.evidence("层高与时长的粗相关", "Pearson + Fisher-z 正态近似",
      { n: raw.n, statistic: raw.r, ci95: raw.ci95, pValue: raw.pValue }));

    var confounded = true;
    if (partial) {
      cmpLines.push("控制材料与模型后：r=" + partial.r.toFixed(3) + "（" + ST.describeR(partial.r) +
        "，有效样本 " + partial.n + "，" + partial.groups + " 个「材料×模型」组，95%CI " +
        partial.ci95[0].toFixed(3) + "–" + partial.ci95[1].toFixed(3) + "，" + ST.fmtP(partial.pValue) + "）");
      evidence.push(ST.evidence("层高与时长的偏相关（控制材料与模型）", partial.method,
        { n: partial.n, statistic: partial.r, ci95: partial.ci95, pValue: partial.pValue }));

      var shift = Math.abs(raw.r - partial.r);
      confounded = shift > 0.15;
      if (confounded) {
        cmpLines.push("两者相差 " + shift.toFixed(2) + "——说明粗相关里有相当一部分来自材料/模型差异，应以偏相关为准。");
      } else {
        cmpLines.push("两者接近（相差 " + shift.toFixed(2) + "），混杂影响不大。");
      }
    } else {
      cmpLines.push("控制材料与模型后有效样本不足，无法计算偏相关——粗相关可能被混杂因素支配，请谨慎解读。");
    }
    sections.push({ h: "相关性（两个口径对照）", lines: cmpLines });

    sections.push({
      h: "读数说明",
      lines: [
        "相关不等于因果：以上只描述数据中的共变关系，不能推断「调大层高就会更快」。",
        "要验证因果，需要固定其他参数只改层高的对照实验。",
        partial ? "偏相关口径：按「材料×模型」组内中心化后求相关，自由度已扣除组数。"
                : "当前样本无法支撑偏相关计算。",
      ],
    });

    var eff = partial || raw;
    return {
      title: "层高与打印时长关系",
      confidence: E.confidence(ok.length, { significant: eff.significant, confounded: confounded }),
      verdict: partial
        ? "控制材料与模型后，层高与打印时长 r=" + partial.r.toFixed(2) + "（" + ST.describeR(partial.r) +
          "，n=" + partial.n + "，" + ST.fmtP(partial.pValue) + "）；未控制时为 r=" + raw.r.toFixed(2) +
          "，两者差异说明混杂因素的影响程度"
        : "层高与打印时长 r=" + raw.r.toFixed(2) + "（" + ST.describeR(raw.r) + "，n=" + raw.n +
          "，" + ST.fmtP(raw.pValue) + "）；未控制材料与模型差异，仅供参考",
      sections: sections,
      evidence: evidence,
      chart: { kind: "bar-value", title: "各层高平均时长（分钟）", items: items },
    };
  }

  /**
   * 成本趋势与拆解。趋势用 Mann-Kendall 非参数检验，
   * 不假设线性、不被个别异常日支配——「看着像在涨」和「统计上在涨」是两回事。
   */
  function costTrend(rows) {
    var by = E.groupBy(rows, "date");
    var dates = [];
    for (var d in by) dates.push(d);
    dates.sort();

    var items = [], series = [], totalFen = 0;
    for (var i = 0; i < dates.length; i++) {
      var s = E.stats(by[dates[i]]);
      totalFen += s.costFen;
      series.push(s.costFen / 100);
      items.push({
        label: dates[i].slice(5), value: s.costFen / 100,
        hint: dates[i] + " · ¥" + fmtYuan(s.costFen) + " · " + s.total + " 件",
      });
    }

    var profile = (typeof FXInsightData !== "undefined" && FXInsightData.COST_PROFILE) || null;
    var matFen = 0;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var unit = (profile && profile.material[r.material]) || (profile ? profile.materialDefaultFen : 8000);
      matFen += (r.filament_g / 1000) * unit;
    }
    var all = E.stats(rows);
    var failLossFen = 0;
    for (var m = 0; m < rows.length; m++) if (rows[m].status === "fail") failLossFen += rows[m].cost_fen || 0;
    var range = E.dateRange(rows);

    var evidence = [], sections = [];
    var trend = ST.mannKendall(series);
    var TREND_WORD = { up: "上升", down: "下降", flat: "无显著趋势" };
    var trendLines = [];
    if (trend) {
      trendLines.push("每日成本：" + TREND_WORD[trend.direction] + "（Mann-Kendall τ=" + trend.tau.toFixed(3) +
        "，" + ST.fmtP(trend.pValue) + "，" + trend.n + " 个日期点）");
      trendLines.push(trend.significant
        ? "该趋势在 95% 水平下统计显著。"
        : "日间波动尚不能判定为趋势——不要据此推断成本正在变化。");
      evidence.push(ST.evidence("每日成本" + TREND_WORD[trend.direction], trend.method,
        { n: trend.n, statistic: trend.tau, pValue: trend.pValue }));
    } else {
      trendLines.push("日期点少于 4 个，无法做趋势检验。");
    }
    sections.push({ h: "趋势检验", lines: trendLines });

    var lossCi = ST.wilson(all.fail, all.total);
    sections.push({
      h: "成本拆解",
      lines: [
        "耗材成本 ≈ ¥" + fmtYuan(Math.round(matFen)) + "（占 " + pct(totalFen ? matFen / totalFen : 0) + "）",
        "能耗 + 机时折旧 ≈ ¥" + fmtYuan(Math.max(0, totalFen - Math.round(matFen))),
        "失败损耗 ¥" + fmtYuan(failLossFen) + "（占总成本 " + pct(totalFen ? failLossFen / totalFen : 0) +
          "；失败率 " + ST.fmtRateCi(lossCi) + "）",
      ],
    });

    var advice = [];
    if (failLossFen > 0 && lossCi.p > 0) {
      var saveFen = Math.round(failLossFen * (1 - lossCi.lo / lossCi.p));
      advice.push("失败损耗占总成本 " + pct(totalFen ? failLossFen / totalFen : 0) +
        "。失败率的 95% 区间是 " + pct(lossCi.lo) + "–" + pct(lossCi.hi) +
        "，即便只压到区间下界也约可节省 ¥" + fmtYuan(saveFen) + "。");
    } else {
      advice.push("本期无失败损耗。");
    }
    advice.push("以上金额按下方口径换算；换成你自己的采购价与电价后结论可能变化。");
    sections.push({ h: "建议", lines: advice });

    sections.push({
      h: "计价口径",
      lines: profile ? [
        profile.label + "（" + profile.id + "）",
        "材料 " + Object.keys(profile.material).map(function (k2) {
          return k2 + " ¥" + (profile.material[k2] / 100).toFixed(0) + "/kg";
        }).join("、"),
        "电价 ¥" + (profile.powerFenPerKwh / 100).toFixed(2) + "/kWh · 机时折旧 ¥" +
          (profile.machineFenPerHour / 100).toFixed(2) + "/h",
        "出处：" + profile.source,
      ] : ["计价口径未知（成本列由上传数据直接提供）"],
    });

    return {
      title: "成本趋势与拆解",
      confidence: E.confidence(rows.length, trend ? { significant: trend.significant } : {}),
      verdict: "期间（" + (range ? range.label : "时间范围未知") + "）总成本 ¥" + fmtYuan(totalFen) +
        "，良品平均单件 ¥" + fmtYuan(all.avgCostFen) + "，失败损耗 ¥" + fmtYuan(failLossFen) +
        "（占 " + pct(totalFen ? failLossFen / totalFen : 0) + "）" +
        (trend ? "；每日成本" + TREND_WORD[trend.direction] + "（" + ST.fmtP(trend.pValue) + "）" : ""),
      sections: sections,
      evidence: evidence,
      chart: { kind: "line", title: "每日成本（元）", items: items },
    };
  }

  /**
   * 失败批次归因。
   * 「失败次数最多」≠「最该保养」——产量大的机台失败次数自然多。
   * 所以次数排行与失败率排行分开给，后者才带统计检验。
   */
  function failRoot(rows) {
    var fails = rows.filter(function (r) { return r.status === "fail"; });
    var evidence = [], sections = [];

    var byReason = E.groupBy(fails, "fail_reason");
    var rs = [];
    for (var k in byReason) rs.push({ name: k, n: byReason[k].length });
    rs.sort(function (a, b) { return b.n - a.n; });

    var items = rs.map(function (r) { return { label: r.name, value: r.n, hint: r.n + " 次" }; });
    var lines = rs.map(function (r) {
      return r.name + "：" + r.n + " 次（占失败 " + ST.fmtRateCi(ST.wilson(r.n, fails.length)) + "）";
    });
    sections.push({ h: "故障类型分布", lines: lines.length ? lines : ["无失败记录"] });

    // 机台维度：用失败率排行（带检验），而不是失败次数
    var rank = ST.rankByRate(rateGroups(rows, "machine_id"), { minSample: E.MIN_SAMPLE });
    var byMachineAll = E.groupBy(rows, "machine_id");
    var crossLines = [];
    if (fails.length) {
      var byM = E.groupBy(fails, "machine_id");
      var mostCount = null;
      for (var m in byM) if (!mostCount || byM[m].length > byM[mostCount].length) mostCount = m;
      if (mostCount) {
        var mAll = E.stats(byMachineAll[mostCount]);
        crossLines.push("失败「次数」最多：" + mostCount + "（" + byM[mostCount].length + " 次）—— " +
          "但它的失败「率」是 " + ST.fmtRateCi(ST.wilson(mAll.fail, mAll.total)) + "（n=" + mAll.total + "）");
      }
      if (rank.worst) {
        crossLines.push("失败「率」最高且显著：" + rank.worst.key + "（" + ST.fmtRateCi(rank.worst.ci) +
          "，n=" + rank.worst.n + "，" + ST.fmtP(rank.worst.pValue) + "）—— 这台才是该优先保养的");
        evidence.push(ST.evidence(rank.worst.key + " 的失败率显著高于其余机台", "Fisher 精确检验（2×2，双侧）",
          { n: rank.worst.n + rank.worst.vsRest.n, pValue: rank.worst.pValue,
            ci95: [rank.worst.ci.lo, rank.worst.ci.hi] }));
      } else if (rank.ranked.length) {
        crossLines.push("失败率最高的是 " + rank.ranked[0].key + "（" + ST.fmtRateCi(rank.ranked[0].ci) +
          "），但与其余机台的差异未达统计显著（" + ST.fmtP(rank.ranked[0].pValue) +
          "），暂不能断定该优先保养谁");
      }
      var byModel = E.groupBy(fails, "model_name");
      var worstMod = null;
      for (var mo in byModel) if (!worstMod || byModel[mo].length > byModel[worstMod].length) worstMod = mo;
      if (worstMod) {
        var modAll = E.stats(E.groupBy(rows, "model_name")[worstMod]);
        crossLines.push("失败次数最多的模型：" + worstMod + "（" + byModel[worstMod].length + " 次，失败率 " +
          ST.fmtRateCi(ST.wilson(modAll.fail, modAll.total)) + "，n=" + modAll.total + "）");
      }
    }
    sections.push({ h: "共性交叉（次数 vs 比率）", lines: crossLines.length ? crossLines : ["无失败记录"] });

    // 处置建议：只对占比区间下界超过 20% 的故障类型给出
    var tips = [];
    for (var t = 0; t < rs.length; t++) {
      var ci2 = ST.wilson(rs[t].n, fails.length);
      if (ci2.lo < 0.2) continue;
      var act = FAULT_ACTION[rs[t].name];
      if (act) tips.push(rs[t].name + "（占 " + ST.fmtRateCi(ci2) + "）：" + act);
    }
    if (!tips.length) {
      tips.push(fails.length
        ? "没有任何故障类型的占比区间下界超过 20%，故障分散，无单一处置重点。"
        : "本期无失败记录。");
    }
    sections.push({ h: "针对性处置", lines: tips });

    var topCi = rs.length ? ST.wilson(rs[0].n, fails.length) : null;
    return {
      title: "失败批次归因",
      confidence: fails.length ? E.confidence(rows.length, { significant: !!rank.worst }) : "insufficient-data",
      verdict: rs.length
        ? "TOP 故障：" + rs[0].name + "（" + rs[0].n + " 次，占失败 " + ST.fmtRateCi(topCi) + "）" +
          (rank.worst
            ? "；" + rank.worst.key + " 的失败率显著高于其余机台（" + ST.fmtP(rank.worst.pValue) + "），应优先保养"
            : "；各机台失败率差异未达统计显著，暂无法指定优先保养对象")
        : "本数据集无失败记录",
      sections: sections,
      evidence: evidence,
      chart: { kind: "bar-value", title: "故障类型次数", items: items },
      highlight: rank.worst ? { type: "machine", id: rank.worst.key }
        : rank.ranked.length ? { type: "machine", id: rank.ranked[0].key } : null,
    };
  }

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
        confidence: "insufficient-data", sections: [], chart: null, evidence: [],
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
    // evidence：每条结论的计算依据（方法/样本量/统计量/置信区间/p 值）。
    // 这是「AI 说了什么」与「计算得出什么」的分界线——没有 evidence 的结论不该被采信。
    if (!report.evidence) report.evidence = [];
    if (!report.confidence) report.confidence = E.confidence(rows.length);
    return report;
  };

  root.FXInsightEngine = E;
})(typeof window !== "undefined" ? window : globalThis);
