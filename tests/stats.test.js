/* FORGE·X 统计核测试（node tests/stats.test.js）

   这套测试的关键在于：**对照公认参考值**，而不是拿实现验证实现。
   下面用到的 Fisher / Wilson 参考值都可以在 R 里一行复现（注释中给出命令），
   任何人都能独立核对——这是统计代码唯一站得住的验证方式。 */
"use strict";
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("stats-kernel.js"));
const S = globalThis.FXStats;

let passed = 0,
  failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

console.log("\n[1] 数值基础（对照解析解）");
{
  check("Φ(0) = 0.5", near(S.normalCdf(0), 0.5, 1e-7), String(S.normalCdf(0)));
  check("Φ(1.96) ≈ 0.975", near(S.normalCdf(1.959963984540054), 0.975, 1e-6), String(S.normalCdf(1.96)));
  check("Φ(-1.96) ≈ 0.025", near(S.normalCdf(-1.959963984540054), 0.025, 1e-6));
  check("Φ 对称性 Φ(x)+Φ(-x)=1", near(S.normalCdf(1.3) + S.normalCdf(-1.3), 1, 1e-9));

  check("lnΓ(1) = 0", near(S.lnGamma(1), 0, 1e-10), String(S.lnGamma(1)));
  check("lnΓ(5) = ln(24)", near(S.lnGamma(5), Math.log(24), 1e-10), String(S.lnGamma(5)));
  check("lnΓ(0.5) = ln(√π)", near(S.lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10));
  check("lnΓ(101) = ln(100!)", near(S.lnGamma(101), 363.7393755555635, 1e-8), String(S.lnGamma(101)));

  check("lnC(10,3) = ln(120)", near(S.lnChoose(10, 3), Math.log(120), 1e-9));
  check("lnC(52,5) = ln(2598960)", near(S.lnChoose(52, 5), Math.log(2598960), 1e-8));
  check("大数不溢出：lnC(5000,2500) 有限", isFinite(S.lnChoose(5000, 2500)));
  check("越界组合数返回 -Inf", S.lnChoose(5, 9) === -Infinity);
}

console.log("\n[2] Wilson 置信区间（对照 R: binom::binom.confint(k, n, methods='wilson')）");
{
  // R: binom.confint(6, 20, methods="wilson") → 0.1455, 0.5190
  const a = S.wilson(6, 20);
  check("Wilson(6,20) 点估计 0.30", near(a.p, 0.3, 1e-12));
  check("Wilson(6,20) 下界 ≈ 0.1455", near(a.lo, 0.1455, 5e-4), a.lo.toFixed(4));
  check("Wilson(6,20) 上界 ≈ 0.5190", near(a.hi, 0.519, 5e-4), a.hi.toFixed(4));

  // 零失败：正态近似会给出宽度为 0 的荒谬区间，Wilson 不会
  const z = S.wilson(0, 10);
  check("Wilson(0,10) 下界为 0", near(z.lo, 0, 1e-12));
  check("Wilson(0,10) 上界 > 0（不宣称「绝不会坏」）", z.hi > 0.25, z.hi.toFixed(4));
  // R: binom.confint(0, 10, methods="wilson") → upper 0.2775
  check("Wilson(0,10) 上界 ≈ 0.2775", near(z.hi, 0.2775, 5e-4), z.hi.toFixed(4));

  const full = S.wilson(10, 10);
  check("Wilson(10,10) 上界为 1", near(full.hi, 1, 1e-12));
  check("Wilson(10,10) 下界 < 1（不宣称「必然坏」）", full.lo < 0.85, full.lo.toFixed(4));

  // 样本量越大区间越窄——这正是「只看点估计会被噪声骗」的量化体现
  const small = S.wilson(3, 10),
    big = S.wilson(300, 1000);
  check("同样 30% 的失败率，n=1000 的区间远窄于 n=10", big.width < small.width / 5, `${big.width.toFixed(4)} vs ${small.width.toFixed(4)}`);
  check("区间始终落在 [0,1]", small.lo >= 0 && small.hi <= 1 && big.lo >= 0 && big.hi <= 1);
  check("n=0 时返回最宽区间而非 NaN", S.wilson(0, 0).hi === 1 && S.wilson(0, 0).lo === 0);
}

console.log("\n[3] Fisher 精确检验（对照 R: fisher.test）");
{
  // R: fisher.test(matrix(c(3,1,1,3),2,2)) → p = 0.4857（可手算核验：34/70）
  const tea = S.fisherExact(3, 1, 1, 3);
  check("Fisher[[3,1],[1,3]] p = 34/70 = 0.4857", near(tea.pValue, 34 / 70, 1e-9), tea.pValue.toFixed(6));

  // R: fisher.test(matrix(c(0,5,5,0),2,2)) → p = 0.007937（手算 2/252）
  const sep = S.fisherExact(0, 5, 5, 0);
  check("Fisher[[0,5],[5,0]] p = 2/252 = 0.007937", near(sep.pValue, 2 / 252, 1e-9), sep.pValue.toFixed(6));

  // 完全无差异的表，p 必须为 1
  const same = S.fisherExact(5, 5, 5, 5);
  check("完全对称的表 p = 1", near(same.pValue, 1, 1e-9), same.pValue.toFixed(6));
  check("完全对称的表 OR = 1", near(same.oddsRatio, 1, 1e-9));

  check("p 值恒在 [0,1]", [S.fisherExact(1, 19, 10, 10), S.fisherExact(7, 3, 2, 8), S.fisherExact(0, 1, 1, 0)].every((f) => f.pValue >= 0 && f.pValue <= 1));
  check("空表安全返回 p=1", S.fisherExact(0, 0, 0, 0).pValue === 1);

  // 零格的 OR 必须有限（Haldane-Anscombe 修正），否则报告里会出现 Infinity
  const zeroCell = S.fisherExact(0, 10, 6, 4);
  check("含零格时 OR 仍为有限值", isFinite(zeroCell.oddsRatio) && zeroCell.oddsRatio > 0, String(zeroCell.oddsRatio));

  // 大样本也要能跑（不溢出、不超时）
  const big = S.fisherExact(120, 880, 60, 940);
  check("大样本 2×2 可计算且显著", big.pValue < 0.001 && isFinite(big.pValue), S.fmtP(big.pValue));
}

console.log("\n[4] 两组比率比较：样本量守卫优先于 p 值");
{
  // 1/2 vs 40/80 —— 点估计都是 50%，但前者根本说明不了任何事
  const tiny = S.compareRates(1, 2, 40, 80);
  check("样本量不足时不给显著性结论", tiny.significant === false && tiny.enough === false);
  check("样本量不足时仍给出区间（供判断证据强度）", tiny.a.width > 0.5, tiny.a.width.toFixed(3));

  // 真实差异：30/100 vs 5/100
  const real = S.compareRates(30, 100, 5, 100);
  check("真实差异被判为显著", real.significant === true, S.fmtP(real.pValue));
  check("差值方向正确", real.diff > 0.2, real.diff.toFixed(3));

  // 相同比率不应显著
  const eq = S.compareRates(20, 100, 20, 100);
  check("相同比率不显著", eq.significant === false, S.fmtP(eq.pValue));

  // 同样 30% vs 5%，但样本量只有 1/10 —— 证据不足以判定
  const weak = S.compareRates(3, 10, 0, 10);
  check("同样的比率差，小样本下不判显著", weak.significant === false, S.fmtP(weak.pValue));
}

console.log("\n[5] 分组排名：最差必须同时「排第一」且「统计显著」");
{
  // BAD 明显更差，样本量都充足
  const r = S.rankByRate([
    { key: "BAD", k: 20, n: 50 },
    { key: "OK1", k: 3, n: 50 },
    { key: "OK2", k: 4, n: 50 },
  ]);
  check("识别出最差组", r.worst && r.worst.key === "BAD", r.worst && r.worst.key);
  check("最差组带置信区间", r.worst && r.worst.ci && r.worst.ci.lo > 0.25, r.worst && r.worst.ci.lo.toFixed(3));
  check("最差组带 p 值且显著", r.worst && r.worst.pValue < 0.001, r.worst && S.fmtP(r.worst.pValue));
  check("对照组是「其余各组合并」而非总体", r.worst && r.worst.vsRest.n === 100, r.worst && String(r.worst.vsRest.n));

  // 三组失败率接近 —— 排第一但不显著，必须拒绝下「最差」的结论
  const flat = S.rankByRate([
    { key: "A", k: 11, n: 50 },
    { key: "B", k: 10, n: 50 },
    { key: "C", k: 9, n: 50 },
  ]);
  check("差异不显著时拒绝给出「最差」", flat.worst === null, flat.worst && flat.worst.key);
  check("但仍返回排序供参考", flat.ranked.length === 3 && flat.ranked[0].key === "A");

  // 样本量不足的组只展示不排名
  const mixed = S.rankByRate([
    { key: "TINY", k: 1, n: 1 },
    { key: "BIG", k: 15, n: 60 },
    { key: "OK", k: 2, n: 60 },
  ]);
  check("100% 失败率的 1 单样本不进排名", mixed.ranked.every((g) => g.key !== "TINY"));
  check("样本不足的组被单列", mixed.skipped.length === 1 && mixed.skipped[0].key === "TINY");
  check("最差是真正有证据的那个", mixed.worst && mixed.worst.key === "BIG", mixed.worst && mixed.worst.key);
  check("样本不足的组仍给出区间", mixed.skipped[0].ci && mixed.skipped[0].ci.hi === 1);
}

console.log("\n[6] 相关性：区间与显著性");
{
  const perfect = S.pearson([[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]]);
  check("完全正相关 r = 1", near(perfect.r, 1, 1e-6), String(perfect.r));
  const negp = S.pearson([[1, 10], [2, 8], [3, 6], [4, 4], [5, 2]]);
  check("完全负相关 r = -1", near(negp.r, -1, 1e-6), String(negp.r));
  check("样本不足返回 null", S.pearson([[1, 1], [2, 2], [3, 3]]) === null);

  // 无关数据不应显著
  const noise = [];
  for (let i = 0; i < 40; i++) noise.push([i, (i * 7919) % 13]);
  const nr = S.pearson(noise);
  check("弱相关数据不判显著", nr.significant === false || Math.abs(nr.r) < 0.3, `r=${nr.r.toFixed(3)} ${S.fmtP(nr.pValue)}`);
  check("相关系数带 95% 区间", Array.isArray(nr.ci95) && nr.ci95[0] < nr.ci95[1]);
  check("区间落在 [-1,1]", nr.ci95[0] >= -1 && nr.ci95[1] <= 1);

  check("强度描述不暗示因果", S.describeR(-0.8) === "强负相关" && S.describeR(0.05) === "几乎无线性相关", S.describeR(-0.8));
}

console.log("\n[7] 偏相关：辛普森悖论必须被识破");
{
  // 构造：组内 x 与 y 严格负相关，但两组的整体位置造成正的总相关。
  // 这正是「层高 vs 时长」被材料混淆的结构。
  const rows = [
    { g: "A", x: 1, y: 10 }, { g: "A", x: 2, y: 9 }, { g: "A", x: 3, y: 8 },
    { g: "B", x: 4, y: 20 }, { g: "B", x: 5, y: 19 }, { g: "B", x: 6, y: 18 },
  ];
  const raw = S.pearson(rows.map((r) => [r.x, r.y]));
  check("不控制混杂时算出的是强正相关（假象）", raw.r > 0.7, raw.r.toFixed(3));

  const partial = S.partialCorrelation(rows, "x", "y", ["g"]);
  check("控制混杂后符号翻转为负相关（真实关系）", partial && partial.r < -0.9, partial && partial.r.toFixed(3));
  check("偏相关记录了控制了哪些变量", partial.controls.join(",") === "g", partial.controls.join(","));
  check("偏相关记录了有效组数", partial.groups === 2, String(partial.groups));
  check("方法说明写明是近似口径", /近似/.test(partial.method), partial.method);

  // 单样本组不携带信息，必须被丢弃而不是当成 0 残差混进来
  const withSingleton = rows.concat([{ g: "C", x: 99, y: 99 }]);
  const p2 = S.partialCorrelation(withSingleton, "x", "y", ["g"]);
  check("单样本组被丢弃（不污染残差）", p2.groups === 2 && p2.dropped === 1, `groups=${p2.groups} dropped=${p2.dropped}`);

  check("有效样本不足返回 null", S.partialCorrelation([{ g: "A", x: 1, y: 1 }], "x", "y", ["g"]) === null);
  check("非数值行被跳过", S.partialCorrelation(rows.concat([{ g: "A", x: "abc", y: null }]), "x", "y", ["g"]).n === 6);
}

console.log("\n[8] Mann-Kendall 趋势");
{
  const up = S.mannKendall([1, 2, 3, 4, 5, 6, 7, 8]);
  check("严格递增 tau = 1", near(up.tau, 1, 1e-12), String(up.tau));
  check("严格递增判为上升且显著", up.direction === "up" && up.significant, `${up.direction} ${S.fmtP(up.pValue)}`);

  const down = S.mannKendall([8, 7, 6, 5, 4, 3, 2, 1]);
  check("严格递减 tau = -1", near(down.tau, -1, 1e-12));
  check("严格递减判为下降", down.direction === "down");

  const flat = S.mannKendall([5, 5, 5, 5, 5, 5]);
  check("全等值：不报趋势且不崩", flat.direction === "flat" && flat.pValue === 1, JSON.stringify(flat));

  // 有噪声的横盘不应被判为趋势
  const wobble = S.mannKendall([10, 12, 9, 11, 10, 12, 9, 11, 10, 12]);
  check("噪声横盘不判趋势", wobble.direction === "flat", `${wobble.direction} ${S.fmtP(wobble.pValue)}`);

  check("样本不足返回 null", S.mannKendall([1, 2, 3]) === null);
  check("并列值修正生效（方差变小 → |z| 变大）", S.mannKendall([1, 1, 2, 2, 3, 3, 4, 4]).significant === true);
}

console.log("\n[9] 表述辅助：不制造不存在的精度");
{
  check("极小 p 值不写成 0", S.fmtP(1e-12) === "p<0.0001", S.fmtP(1e-12));
  check("中等 p 值保留有效位", S.fmtP(0.0321) === "p=0.032", S.fmtP(0.0321));
  check("空值安全", S.fmtP(null) === "—" && S.fmtP(NaN) === "—");
  check("比例区间格式可读", S.fmtRateCi(S.wilson(6, 20)) === "30.0%（95%CI 14.5–51.9%）", S.fmtRateCi(S.wilson(6, 20)));

  const ev = S.evidence("FX-01 故障率高于其余机台", "Fisher 精确检验", { n: 50, pValue: 0.003, ci95: [0.2, 0.5] });
  check("证据条目含 claim / method / n / p / ci", !!(ev.claim && ev.method && ev.n === 50 && ev.pValue === 0.003 && ev.ci95));
}

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
