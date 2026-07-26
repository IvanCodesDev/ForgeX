/* FORGE·X — 统计核（纯逻辑，node 可测；不得引用 DOM 或 THREE）

   这个模块存在的理由：让「A 比 B 差」这句话有依据。

   重构前的分析引擎是这样下结论的：
       if (s.failRate > worst.failRate) worst = ...;   // 谁的比例大谁最差
   6/20 和 3/10 的失败率都是 30%，但前者的证据强度明显更高；
   1/2 和 40/80 也都是 50%，前者根本说明不了任何事。
   只比点估计，等于把噪声当信号。

   这里提供的是**能被追问的统计量**：
     - 比例给 Wilson 置信区间（小样本下比正态近似可靠得多）
     - 两组比较用 Fisher 精确检验（不依赖大样本近似，2×2 下是精确的）
     - 相关性支持**控制混杂变量的偏相关**（组内中心化，等价于 ANCOVA 口径）
     - 趋势用 Mann-Kendall（非参数，不假设线性、不受异常值支配）

   诚实性约定：所有近似都在注释里写明适用范围。
   本模块不做「看起来很统计」的装饰性计算——每个返回值都要能解释它是怎么来的。 */
(function (root) {
  "use strict";

  var S = {};

  /** 参与排名/比较所需的最小样本量。低于此值只展示、不下结论。 */
  S.MIN_SAMPLE = 5;

  /** 显著性水平（双侧） */
  S.ALPHA = 0.05;

  /* ══ 数值基础 ══════════════════════════════ */

  /** 标准正态 CDF。Abramowitz-Stegun 7.1.26 的 erf 近似，绝对误差 < 1.5e-7。 */
  S.normalCdf = function (x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989422804014327 * Math.exp((-x * x) / 2);
    var p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  };

  /** lnΓ(x)，Lanczos 近似（g=7, n=9）。相对误差 < 1e-13，n 上万也稳。 */
  var LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  S.lnGamma = function (x) {
    if (x < 0.5) {
      // 反射公式，避免小参数下的精度损失
      return Math.log(Math.PI / Math.sin(Math.PI * x)) - S.lnGamma(1 - x);
    }
    x -= 1;
    var a = LANCZOS[0];
    var t = x + 7.5;
    for (var i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  };

  /** ln C(n, k)。用 lnΓ 而非阶乘连乘，n 大时不会溢出。 */
  S.lnChoose = function (n, k) {
    if (k < 0 || k > n) return -Infinity;
    return S.lnGamma(n + 1) - S.lnGamma(k + 1) - S.lnGamma(n - k + 1);
  };

  /* ══ 比例的置信区间 ════════════════════════ */

  /**
   * Wilson score 区间。
   *
   * 为什么不用教科书上的正态近似（p̂ ± z·√(p̂(1-p̂)/n)）：
   * 那个公式在 p̂ 接近 0 或 1 时会给出超出 [0,1] 的荒谬区间，
   * 小样本下覆盖率也差得多。0 次失败时它给出的区间宽度是 0——
   * 相当于宣称「这台机器绝不会坏」，而我们恰恰要避免这种过度自信。
   * Wilson 区间在这两种情形下都表现正常，是比例区间的推荐默认。
   *
   * @returns {{p, lo, hi, n, k, width}} p 为点估计，[lo,hi] 为 95%（默认）区间
   */
  S.wilson = function (k, n, conf) {
    if (!(n > 0)) return { p: 0, lo: 0, hi: 1, n: 0, k: 0, width: 1 };
    var z = zFor(conf == null ? 0.95 : conf);
    var p = k / n;
    var z2 = z * z;
    var denom = 1 + z2 / n;
    var center = (p + z2 / (2 * n)) / denom;
    var margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
    var lo = Math.max(0, center - margin);
    var hi = Math.min(1, center + margin);
    return { p: p, lo: lo, hi: hi, n: n, k: k, width: hi - lo };
  };

  function zFor(conf) {
    // 常用置信度直接查表，避免实现分位数反函数
    if (conf >= 0.99) return 2.5758293035489004;
    if (conf >= 0.98) return 2.3263478740408408;
    if (conf >= 0.95) return 1.959963984540054;
    if (conf >= 0.9) return 1.6448536269514722;
    return 1.959963984540054;
  }

  /* ══ 两组比例的比较 ════════════════════════ */

  /**
   * Fisher 精确检验（2×2，双侧）。
   *
   *      | 失败 | 成功
   *   A  |  a   |  b
   *   B  |  c   |  d
   *
   * 为什么用精确检验而不是卡方：卡方依赖大样本近似，任一格期望频数 <5 时就不可靠——
   * 而「某台机器只跑了 8 单、失败 3 次」正是我们最常遇到的情形。
   * Fisher 在固定边缘和下枚举全部可能表格，不做任何近似。
   *
   * 双侧 p 值口径：所有「出现概率不高于观测表」的表格概率之和（Fisher/Irwin 约定）。
   *
   * @returns {{pValue, oddsRatio, a, b, c, d, n}}
   */
  S.fisherExact = function (a, b, c, d) {
    a = a | 0; b = b | 0; c = c | 0; d = d | 0;
    var n = a + b + c + d;
    if (n <= 0) return { pValue: 1, oddsRatio: null, a: a, b: b, c: c, d: d, n: 0 };

    // 固定边缘和：r1/r2 为行和，c1 为第一列和（第二列和由总数推出，无需单独变量）
    var r1 = a + b, r2 = c + d, c1 = a + c;
    var lnDen = S.lnChoose(n, c1);
    var pObs = Math.exp(S.lnChoose(r1, a) + S.lnChoose(r2, c) - lnDen);

    var lo = Math.max(0, c1 - r2);
    var hi = Math.min(r1, c1);
    var p = 0;
    var EPS = 1e-7;
    for (var x = lo; x <= hi; x++) {
      var px = Math.exp(S.lnChoose(r1, x) + S.lnChoose(r2, c1 - x) - lnDen);
      if (px <= pObs * (1 + EPS)) p += px;
    }
    // Haldane-Anscombe 修正：任一格为 0 时 OR 会退化为 0/∞，加 0.5 使其可比
    var or_ = b * c === 0 || a * d === 0
      ? ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5))
      : (a * d) / (b * c);

    return { pValue: Math.min(1, p), oddsRatio: or_, a: a, b: b, c: c, d: d, n: n };
  };

  /**
   * 比较两组的失败率：给出各自的 Wilson 区间、差值、以及 Fisher 检验的 p 值。
   * @returns {{a, b, diff, pValue, significant, oddsRatio, enough}}
   */
  S.compareRates = function (kA, nA, kB, nB, opt) {
    opt = opt || {};
    var minN = opt.minSample == null ? S.MIN_SAMPLE : opt.minSample;
    var A = S.wilson(kA, nA), B = S.wilson(kB, nB);
    var f = S.fisherExact(kA, nA - kA, kB, nB - kB);
    var enough = nA >= minN && nB >= minN;
    return {
      a: A, b: B,
      diff: A.p - B.p,
      pValue: f.pValue,
      oddsRatio: f.oddsRatio,
      // 样本量不足时不给显著性结论——p 值算得出来不等于结论可用
      significant: enough && f.pValue < (opt.alpha == null ? S.ALPHA : opt.alpha),
      enough: enough,
    };
  };

  /* ══ 分组排名（带证据） ════════════════════ */

  /**
   * 按失败率对分组排名，每组带 Wilson 区间，并与「其余各组合并」做 Fisher 检验。
   *
   * 「与其余合并比较」而不是「与总体比较」：后者把被检验组自己也算进对照，
   * 会稀释差异，是常见的统计误用。
   *
   * @param groups {Array<{key, k, n}>}  k=失败数, n=总数
   * @returns {{ranked, skipped, worst, minSample}}
   *   ranked  样本量达标的组，按点估计降序，每组含 ci / pValue / significant
   *   skipped 样本量不足的组（只展示，不参与排名）
   *   worst   排名第一且**统计上显著**的组；无则为 null
   */
  S.rankByRate = function (groups, opt) {
    opt = opt || {};
    var minN = opt.minSample == null ? S.MIN_SAMPLE : opt.minSample;
    var alpha = opt.alpha == null ? S.ALPHA : opt.alpha;

    var totalK = 0, totalN = 0;
    for (var i = 0; i < groups.length; i++) { totalK += groups[i].k; totalN += groups[i].n; }

    var ranked = [], skipped = [];
    for (var j = 0; j < groups.length; j++) {
      var g = groups[j];
      var ci = S.wilson(g.k, g.n);
      if (g.n < minN) {
        skipped.push({ key: g.key, k: g.k, n: g.n, ci: ci, reason: "样本量 " + g.n + " < " + minN });
        continue;
      }
      // 该组 vs 其余各组合并
      var restK = totalK - g.k, restN = totalN - g.n;
      var f = restN > 0 ? S.fisherExact(g.k, g.n - g.k, restK, restN - restK) : { pValue: 1, oddsRatio: null };
      ranked.push({
        key: g.key, k: g.k, n: g.n, rate: ci.p, ci: ci,
        vsRest: { k: restK, n: restN, rate: restN ? restK / restN : 0 },
        pValue: f.pValue,
        oddsRatio: f.oddsRatio,
        significant: restN >= minN && f.pValue < alpha,
      });
    }
    ranked.sort(function (a, b) { return b.rate - a.rate || b.n - a.n; });

    // 「最差」必须同时满足：排第一 + 与其余组的差异统计显著
    var worst = ranked.length && ranked[0].significant ? ranked[0] : null;
    return {
      ranked: ranked, skipped: skipped, worst: worst,
      minSample: minN, alpha: alpha,
      fleet: { k: totalK, n: totalN, rate: totalN ? totalK / totalN : 0 },
    };
  };

  /* ══ 相关性 ════════════════════════════════ */

  /**
   * Pearson 相关系数 + 置信区间 + p 值。
   *
   * 区间与 p 值用 Fisher z 变换（atanh）后的正态近似。
   * 适用范围：n ≳ 10 且二元分布近似正态时可靠；本项目样本量通常在百级，满足。
   * 小样本请直接看 n 与区间宽度，不要只看 p。
   *
   * @param pairs [[x,y], ...]
   * @returns {{r, n, ci95, pValue, significant}} 样本不足返回 null
   */
  S.pearson = function (pairs, opt) {
    opt = opt || {};
    var n = pairs.length;
    if (n < 4) return null;                       // n<4 时 Fisher z 的 se 无意义
    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += pairs[i][0]; sy += pairs[i][1]; }
    var mx = sx / n, my = sy / n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var a = pairs[j][0] - mx, b = pairs[j][1] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    var den = Math.sqrt(dx * dy);
    var r = den < 1e-12 ? 0 : num / den;
    r = Math.max(-0.9999999, Math.min(0.9999999, r));

    var df = opt.df == null ? n - 3 : opt.df;     // 偏相关时调用方传入扣除控制变量后的 df
    var ci95 = null, pValue = 1;
    if (df > 0) {
      var z = Math.atanh(r);
      var se = 1 / Math.sqrt(df);
      ci95 = [Math.tanh(z - 1.959963984540054 * se), Math.tanh(z + 1.959963984540054 * se)];
      pValue = 2 * (1 - S.normalCdf(Math.abs(z) / se));
    }
    return {
      r: r, n: n, ci95: ci95, pValue: pValue,
      significant: ci95 != null && pValue < (opt.alpha == null ? S.ALPHA : opt.alpha),
      method: "pearson + fisher-z 正态近似",
    };
  };

  /**
   * 控制分类混杂变量后的偏相关（组内中心化，等价于 ANCOVA 口径）。
   *
   * 解决的问题：直接算「层高 vs 打印时长」的相关，会把材料差异混进去——
   * TPU 又慢又常用大层高，PLA 又快又常用小层高，于是算出来的 r 反映的是
   * 「材料」而不是「层高」。控制材料与模型后，比较的才是同类活里层高的影响。
   *
   * 做法：按控制变量分组，组内减去各自的均值，再对残差求相关。
   * 自由度扣除组数：df = n - g - 2（g 为有效组数）。
   *
   * @param rows  数据行
   * @param xKey / yKey  数值字段
   * @param controlKeys  分类字段（可多个，取笛卡尔组合）
   * @returns {{r, n, ci95, pValue, significant, groups, dropped}} 有效样本不足返回 null
   */
  S.partialCorrelation = function (rows, xKey, yKey, controlKeys) {
    controlKeys = controlKeys || [];
    var buckets = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var x = Number(row[xKey]), y = Number(row[yKey]);
      if (!isFinite(x) || !isFinite(y)) continue;
      var key = "";
      for (var c = 0; c < controlKeys.length; c++) key += "" + String(row[controlKeys[c]]);
      (buckets[key] = buckets[key] || []).push([x, y]);
    }

    var resid = [], groups = 0, dropped = 0;
    for (var k in buckets) {
      var g = buckets[k];
      // 组内只有 1 个样本时中心化后恒为 0，不携带任何信息，直接丢弃
      if (g.length < 2) { dropped += g.length; continue; }
      groups++;
      var sx = 0, sy = 0;
      for (var a = 0; a < g.length; a++) { sx += g[a][0]; sy += g[a][1]; }
      var mx = sx / g.length, my = sy / g.length;
      for (var b = 0; b < g.length; b++) resid.push([g[b][0] - mx, g[b][1] - my]);
    }
    if (resid.length < 4 || groups < 1) return null;

    var df = resid.length - groups - 2;
    if (df <= 0) return null;
    var out = S.pearson(resid, { df: df });
    if (!out) return null;
    out.groups = groups;
    out.dropped = dropped;
    out.controls = controlKeys.slice();
    out.method = "组内中心化偏相关（控制：" + (controlKeys.join("、") || "无") + "）+ fisher-z 近似";
    return out;
  };

  /* ══ 趋势 ══════════════════════════════════ */

  /**
   * Mann-Kendall 趋势检验（含并列值修正）。
   *
   * 为什么不用线性回归斜率：回归假设线性且对异常值敏感，
   * 而「本月成本是不是在涨」这个问题不需要假设涨得是不是直线。
   * MK 是非参数的，只看两两先后的大小关系，稳健得多。
   *
   * @param series 按时间升序的数值数组
   * @returns {{n, S, tau, z, pValue, direction, significant}} n<4 返回 null
   */
  S.mannKendall = function (series, opt) {
    opt = opt || {};
    var n = series.length;
    if (n < 4) return null;

    var Sstat = 0;
    for (var i = 0; i < n - 1; i++) {
      for (var j = i + 1; j < n; j++) {
        var d = series[j] - series[i];
        Sstat += d > 0 ? 1 : d < 0 ? -1 : 0;
      }
    }

    // 并列值修正：同值的组会降低方差
    var counts = {};
    for (var t = 0; t < n; t++) counts[series[t]] = (counts[series[t]] || 0) + 1;
    var tieTerm = 0;
    for (var v in counts) {
      var c = counts[v];
      if (c > 1) tieTerm += c * (c - 1) * (2 * c + 5);
    }
    var varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
    if (varS <= 0) {
      return { n: n, S: Sstat, tau: 0, z: 0, pValue: 1, direction: "flat", significant: false };
    }

    // 连续性修正
    var z = Sstat > 0 ? (Sstat - 1) / Math.sqrt(varS) : Sstat < 0 ? (Sstat + 1) / Math.sqrt(varS) : 0;
    var pValue = 2 * (1 - S.normalCdf(Math.abs(z)));
    var tau = (2 * Sstat) / (n * (n - 1));
    var alpha = opt.alpha == null ? S.ALPHA : opt.alpha;
    var sig = pValue < alpha;
    return {
      n: n, S: Sstat, tau: tau, z: z, pValue: pValue,
      direction: !sig ? "flat" : Sstat > 0 ? "up" : "down",
      significant: sig,
      method: "Mann-Kendall 非参数趋势检验（正态近似 + 并列修正）",
    };
  };

  /* ══ 表述辅助 ══════════════════════════════ */

  /** p 值 → 人类可读（不四舍五入成 0，避免造成「p=0」这种不存在的说法） */
  S.fmtP = function (p) {
    if (p == null || !isFinite(p)) return "—";
    if (p < 0.0001) return "p<0.0001";
    if (p < 0.001) return "p<0.001";
    return "p=" + p.toFixed(p < 0.01 ? 4 : 3);
  };

  /** 比例区间 → "24.0%（95%CI 15.6–34.9%）" */
  S.fmtRateCi = function (ci) {
    var pc = function (x) { return (x * 100).toFixed(1); };
    return pc(ci.p) + "%（95%CI " + pc(ci.lo) + "–" + pc(ci.hi) + "%）";
  };

  /**
   * 相关强度的定性说法。只描述强度，**不暗示因果**——
   * 「负相关」是对数据的描述，「层高越大越快」是因果主张，两者不能混用。
   */
  S.describeR = function (r) {
    var a = Math.abs(r);
    var strength = a >= 0.7 ? "强" : a >= 0.4 ? "中等" : a >= 0.2 ? "弱" : "几乎无";
    if (a < 0.2) return "几乎无线性相关";
    return strength + (r < 0 ? "负" : "正") + "相关";
  };

  /**
   * 证据条目：报告里每条结论都应当能附上一条，说明「这个数是怎么来的」。
   * 契约见 doc/优化文档.md §4.3 ②。
   */
  S.evidence = function (claim, method, stat) {
    return {
      claim: claim,
      method: method,
      n: stat && stat.n != null ? stat.n : null,
      statistic: stat && stat.statistic != null ? stat.statistic : null,
      ci95: stat && stat.ci95 ? stat.ci95 : null,
      pValue: stat && stat.pValue != null ? stat.pValue : null,
    };
  };

  root.FXStats = S;
})(typeof window !== "undefined" ? window : globalThis);
