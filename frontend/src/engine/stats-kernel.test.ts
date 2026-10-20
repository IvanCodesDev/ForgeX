/* 统计核（Stage 7.4 前置：自 tests/stats.test.js 迁入 vitest，改测 TS 引擎）

   关键在于：**对照公认参考值**，而不是拿实现验证实现。
   Fisher / Wilson 参考值都可以在 R 里一行复现（注释中给出命令），任何人都能独立核对。 */
import { describe, expect, it } from "vitest";
import {
  compareRates,
  describeR,
  evidence,
  fisherExact,
  fmtP,
  fmtRateCi,
  lnChoose,
  lnGamma,
  mannKendall,
  normalCdf,
  partialCorrelation,
  pearson,
  rankByRate,
  wilson,
} from "./stats-kernel.ts";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe("数值基础（对照解析解）", () => {
  it("标准正态 CDF", () => {
    expect(near(normalCdf(0), 0.5, 1e-7)).toBe(true);
    expect(near(normalCdf(1.959963984540054), 0.975, 1e-6)).toBe(true);
    expect(near(normalCdf(-1.959963984540054), 0.025, 1e-6)).toBe(true);
    expect(near(normalCdf(1.3) + normalCdf(-1.3), 1, 1e-9)).toBe(true);
  });

  it("lnΓ 与 lnC", () => {
    expect(near(lnGamma(1), 0, 1e-10)).toBe(true);
    expect(near(lnGamma(5), Math.log(24), 1e-10)).toBe(true);
    expect(near(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10)).toBe(true);
    expect(near(lnGamma(101), 363.7393755555635, 1e-8)).toBe(true);
    expect(near(lnChoose(10, 3), Math.log(120), 1e-9)).toBe(true);
    expect(near(lnChoose(52, 5), Math.log(2598960), 1e-8)).toBe(true);
    expect(Number.isFinite(lnChoose(5000, 2500))).toBe(true);
    expect(lnChoose(5, 9)).toBe(-Infinity);
  });
});

describe("Wilson 置信区间（对照 R: binom::binom.confint(k, n, methods='wilson')）", () => {
  it("Wilson(6,20) → 0.30 [0.1455, 0.5190]", () => {
    const a = wilson(6, 20);
    expect(near(a.p, 0.3, 1e-12)).toBe(true);
    expect(near(a.lo, 0.1455, 5e-4)).toBe(true);
    expect(near(a.hi, 0.519, 5e-4)).toBe(true);
  });

  it("零失败 / 全失败 的边界不宣称「绝不会坏」或「必然坏」", () => {
    const z = wilson(0, 10);
    expect(near(z.lo, 0, 1e-12)).toBe(true);
    expect(z.hi).toBeGreaterThan(0.25);
    expect(near(z.hi, 0.2775, 5e-4)).toBe(true); // R: binom.confint(0, 10, methods="wilson") → upper 0.2775
    const full = wilson(10, 10);
    expect(near(full.hi, 1, 1e-12)).toBe(true);
    expect(full.lo).toBeLessThan(0.85);
  });

  it("样本量越大区间越窄；区间落在 [0,1]；n=0 返回最宽区间而非 NaN", () => {
    const small = wilson(3, 10);
    const big = wilson(300, 1000);
    expect(big.width).toBeLessThan(small.width / 5);
    expect(small.lo).toBeGreaterThanOrEqual(0);
    expect(small.hi).toBeLessThanOrEqual(1);
    expect(big.lo).toBeGreaterThanOrEqual(0);
    expect(big.hi).toBeLessThanOrEqual(1);
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
  });
});

describe("Fisher 精确检验（对照 R: fisher.test）", () => {
  it("p 值对照手算：[[3,1],[1,3]] = 34/70，[[0,5],[5,0]] = 2/252，对称表 p=1 且 OR=1", () => {
    expect(near(fisherExact(3, 1, 1, 3).pValue, 34 / 70, 1e-9)).toBe(true);
    expect(near(fisherExact(0, 5, 5, 0).pValue, 2 / 252, 1e-9)).toBe(true);
    const same = fisherExact(5, 5, 5, 5);
    expect(near(same.pValue, 1, 1e-9)).toBe(true);
    expect(near(same.oddsRatio!, 1, 1e-9)).toBe(true);
  });

  it("p ∈ [0,1]；空表 p=1；含零格 OR 有限（Haldane-Anscombe）；大样本可算且显著", () => {
    for (const f of [fisherExact(1, 19, 10, 10), fisherExact(7, 3, 2, 8), fisherExact(0, 1, 1, 0)]) {
      expect(f.pValue).toBeGreaterThanOrEqual(0);
      expect(f.pValue).toBeLessThanOrEqual(1);
    }
    expect(fisherExact(0, 0, 0, 0).pValue).toBe(1);
    const zeroCell = fisherExact(0, 10, 6, 4);
    expect(Number.isFinite(zeroCell.oddsRatio)).toBe(true);
    expect(zeroCell.oddsRatio).toBeGreaterThan(0);
    const big = fisherExact(120, 880, 60, 940);
    expect(Number.isFinite(big.pValue)).toBe(true);
    expect(big.pValue).toBeLessThan(0.001);
  });
});

describe("两组比率比较：样本量守卫优先于 p 值", () => {
  it("样本不足不给结论但给区间；真实差异显著；相同比率与小样本不显著", () => {
    const tiny = compareRates(1, 2, 40, 80);
    expect(tiny.significant).toBe(false);
    expect(tiny.enough).toBe(false);
    expect(tiny.a.width).toBeGreaterThan(0.5);
    const real = compareRates(30, 100, 5, 100);
    expect(real.significant).toBe(true);
    expect(real.diff).toBeGreaterThan(0.2);
    expect(compareRates(20, 100, 20, 100).significant).toBe(false);
    expect(compareRates(3, 10, 0, 10).significant).toBe(false);
  });
});

describe("分组排名：最差必须同时「排第一」且「统计显著」", () => {
  it("识别显著最差组，对照组为其余各组合并", () => {
    const r = rankByRate([
      { key: "BAD", k: 20, n: 50 },
      { key: "OK1", k: 3, n: 50 },
      { key: "OK2", k: 4, n: 50 },
    ]);
    expect(r.worst?.key).toBe("BAD");
    expect(r.worst!.ci.lo).toBeGreaterThan(0.25);
    expect(r.worst!.pValue).toBeLessThan(0.001);
    expect(r.worst!.vsRest.n).toBe(100);
  });

  it("差异不显著时拒绝给出「最差」但仍返回排序", () => {
    const flat = rankByRate([
      { key: "A", k: 11, n: 50 },
      { key: "B", k: 10, n: 50 },
      { key: "C", k: 9, n: 50 },
    ]);
    expect(flat.worst).toBeNull();
    expect(flat.ranked).toHaveLength(3);
    expect(flat.ranked[0]!.key).toBe("A");
  });

  it("样本量不足的组只展示不排名", () => {
    const mixed = rankByRate([
      { key: "TINY", k: 1, n: 1 },
      { key: "BIG", k: 15, n: 60 },
      { key: "OK", k: 2, n: 60 },
    ]);
    expect(mixed.ranked.every((g) => g.key !== "TINY")).toBe(true);
    expect(mixed.skipped).toHaveLength(1);
    expect(mixed.skipped[0]!.key).toBe("TINY");
    expect(mixed.worst?.key).toBe("BIG");
    expect(mixed.skipped[0]!.ci.hi).toBe(1);
  });
});

describe("相关性：区间与显著性", () => {
  it("完全正/负相关、样本不足 null、弱相关不判显著、区间在 [-1,1]、强度描述不暗示因果", () => {
    expect(
      near(
        pearson([
          [1, 2],
          [2, 4],
          [3, 6],
          [4, 8],
          [5, 10],
        ])!.r,
        1
      )
    ).toBe(true);
    expect(
      near(
        pearson([
          [1, 10],
          [2, 8],
          [3, 6],
          [4, 4],
          [5, 2],
        ])!.r,
        -1
      )
    ).toBe(true);
    expect(
      pearson([
        [1, 1],
        [2, 2],
        [3, 3],
      ])
    ).toBeNull();
    const noise: Array<[number, number]> = [];
    for (let i = 0; i < 40; i++) noise.push([i, (i * 7919) % 13]);
    const nr = pearson(noise)!;
    expect(nr.significant === false || Math.abs(nr.r) < 0.3).toBe(true);
    expect(nr.ci95![0]).toBeLessThan(nr.ci95![1]);
    expect(nr.ci95![0]).toBeGreaterThanOrEqual(-1);
    expect(nr.ci95![1]).toBeLessThanOrEqual(1);
    expect(describeR(-0.8)).toBe("强负相关");
    expect(describeR(0.05)).toBe("几乎无线性相关");
  });
});

describe("偏相关：辛普森悖论必须被识破", () => {
  // 组内 x 与 y 严格负相关，但两组的整体位置造成正的总相关——「层高 vs 时长」被材料混淆的结构
  const rows = [
    { g: "A", x: 1, y: 10 },
    { g: "A", x: 2, y: 9 },
    { g: "A", x: 3, y: 8 },
    { g: "B", x: 4, y: 20 },
    { g: "B", x: 5, y: 19 },
    { g: "B", x: 6, y: 18 },
  ];

  it("不控制混杂是强正相关（假象），控制后翻转为负相关（真实）", () => {
    expect(pearson(rows.map((r) => [r.x, r.y] as const))!.r).toBeGreaterThan(0.7);
    const partial = partialCorrelation(rows, "x", "y", ["g"])!;
    expect(partial.r).toBeLessThan(-0.9);
    expect(partial.controls!.join(",")).toBe("g");
    expect(partial.groups).toBe(2);
    expect(partial.method).toMatch(/近似/);
  });

  it("单样本组被丢弃；有效样本不足返回 null；非数值行被跳过", () => {
    const p2 = partialCorrelation(rows.concat([{ g: "C", x: 99, y: 99 }]), "x", "y", ["g"])!;
    expect(p2.groups).toBe(2);
    expect(p2.dropped).toBe(1);
    expect(partialCorrelation([{ g: "A", x: 1, y: 1 }], "x", "y", ["g"])).toBeNull();
    const dirty = rows.concat([{ g: "A", x: "abc", y: null } as unknown as (typeof rows)[number]]);
    expect(partialCorrelation(dirty, "x", "y", ["g"])!.n).toBe(6);
  });
});

describe("Mann-Kendall 趋势", () => {
  it("单调序列 tau=±1 且判向；全等值与噪声横盘不报趋势；样本不足 null；并列修正生效", () => {
    const up = mannKendall([1, 2, 3, 4, 5, 6, 7, 8])!;
    expect(near(up.tau, 1, 1e-12)).toBe(true);
    expect(up.direction).toBe("up");
    expect(up.significant).toBe(true);
    const down = mannKendall([8, 7, 6, 5, 4, 3, 2, 1])!;
    expect(near(down.tau, -1, 1e-12)).toBe(true);
    expect(down.direction).toBe("down");
    const flat = mannKendall([5, 5, 5, 5, 5, 5])!;
    expect(flat.direction).toBe("flat");
    expect(flat.pValue).toBe(1);
    expect(mannKendall([10, 12, 9, 11, 10, 12, 9, 11, 10, 12])!.direction).toBe("flat");
    expect(mannKendall([1, 2, 3])).toBeNull();
    expect(mannKendall([1, 1, 2, 2, 3, 3, 4, 4])!.significant).toBe(true);
  });
});

describe("表述辅助：不制造不存在的精度", () => {
  it("p 值格式、区间格式、证据条目", () => {
    expect(fmtP(1e-12)).toBe("p<0.0001");
    expect(fmtP(0.0321)).toBe("p=0.032");
    expect(fmtP(null)).toBe("—");
    expect(fmtP(NaN)).toBe("—");
    expect(fmtRateCi(wilson(6, 20))).toBe("30.0%（95%CI 14.5–51.9%）");
    const ev = evidence("FX-01 故障率高于其余机台", "Fisher 精确检验", { n: 50, pValue: 0.003, ci95: [0.2, 0.5] });
    expect(ev).toMatchObject({ claim: "FX-01 故障率高于其余机台", method: "Fisher 精确检验", n: 50, pValue: 0.003 });
    expect(ev.ci95).toEqual([0.2, 0.5]);
  });
});
