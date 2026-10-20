/* 智造洞察（Stage 7.4 前置：自 tests/insight.test.js 迁入 vitest，改测 TS 引擎）
   覆盖：合成数据生成 / CSV 解析与回环 / 成本口径 / 聚合统计 / 相关系数 / 意图识别 /
        报告结构 / 统计守卫（最小样本量）/ 来源标记（provenance）

   ⚠ 测试原则：断言引擎的**性质**，不断言「生成器埋了什么就挖出什么」——
   自己构造带已知效应的数据集，检验引擎能否正确识别出该效应。 */
import { afterEach, describe, expect, it } from "vitest";
import * as D from "./insight-data.ts";
import * as E from "./insight-engine.ts";
import type { JobRow } from "./insight-data.ts";

/** 构造一批记录：machine 台机器，共 n 单，其中 failN 单失败。用于注入已知效应。 */
function makeRows(
  machine: string,
  n: number,
  failN: number,
  opts: { date?: string; model?: string; material?: string; lh?: number; dur?: number; reason?: string } = {}
): JobRow[] {
  const out: JobRow[] = [];
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
      fail_reason: failed ? opts.reason || "堵料" : "",
      energy_kwh: 0.4,
    });
  }
  return out;
}

const rows = D.generateSample();
const DEFAULT_COST = { id: "cn-retail-2026q3", material: { PLA: 6900, PETG: 8900, ABS: 7900, TPU: 15900 } };

describe("合成数据生成（结构与确定性，不断言其内容含义）", () => {
  it("默认 96 条、12 列齐全、确定性、失败样本与故障原因自洽、成本为正整数分", () => {
    expect(rows).toHaveLength(96);
    for (const f of D.FIELDS) expect(rows[0]).toHaveProperty(f);
    expect(D.generateSample()[10]!.job_id).toBe(rows[10]!.job_id);
    expect(D.generateSample()[10]!.cost_fen).toBe(rows[10]!.cost_fen);
    const fails = rows.filter((r) => r.status === "fail");
    expect(fails.length).toBeGreaterThanOrEqual(8);
    expect(fails.every((r) => r.fail_reason !== "")).toBe(true);
    expect(rows.filter((r) => r.status === "success").every((r) => r.fail_reason === "")).toBe(true);
    expect(rows.every((r) => r.cost_fen! > 0 && r.cost_fen === Math.round(r.cost_fen!))).toBe(true);
    const reasons: readonly string[] = D.FAIL_REASONS;
    expect(fails.every((r) => reasons.includes(r.fail_reason!))).toBe(true);
  });

  it("自我声明为合成数据并带可复现的生成器与种子", () => {
    expect(D.PROVENANCE.sample!.synthetic).toBe(true);
    expect(D.PROVENANCE.sample!.generator?.seed).toBeTruthy();
  });
});

describe("成本口径", () => {
  it("1kg PLA + 1kWh + 1h = 69 + 0.6 + 0.12 元", () => {
    expect(D.costFen("PLA", 1000, 1, 60)).toBe(6900 + 60 + 12);
  });
});

describe("CSV 解析", () => {
  it("中文表头、元→分、带引号逗号字段、中文状态归一、数字字段为 number", () => {
    const out = D.parseCsv(
      [
        "任务编号,日期,机台,模型,材料,层高,耗时,耗材克重,成本元,状态,故障类型,能耗",
        "J1,2026-07-01,FX-256-01,行星齿轮,PLA,0.2,95,34.2,3.51,success,,0.38",
        'J2,2026-07-02,"FX-256,02",传感器支架,ABS,0.2,40,12.0,1.20,失败,翘边,0.22',
      ].join("\n")
    );
    expect(out.rows, out.errors.join("|")).toHaveLength(2);
    expect(out.rows[0]!.cost_fen).toBe(351);
    expect(out.rows[1]!.machine_id).toBe("FX-256,02");
    expect(out.rows[1]!.status).toBe("fail");
    expect(out.rows[0]!.duration_min).toBe(95);
  });

  it("缺少 status 列报错；未知状态行与非法数值行不会静默归类", () => {
    const bad = D.parseCsv("a,b\n1,2");
    expect(bad.rows).toHaveLength(0);
    expect(bad.errors.length).toBeGreaterThan(0);
    const dirty = D.parseCsv(
      [
        "machine_id,status,duration_min,cost_fen",
        "M-1,running,20,100",
        "M-2,success,12oops,80",
        "M-3,success,21,90",
      ].join("\n")
    );
    expect(dirty.rows).toHaveLength(1);
    expect(dirty.rows[0]!.machine_id).toBe("M-3");
    expect(dirty.errors.some((e) => /第 3 行.*duration_min/.test(e))).toBe(true);
  });

  it("导出 → 再解析回环无损", () => {
    const back = D.parseCsv(D.toCsv(rows.slice(0, 5)));
    expect(back.rows).toHaveLength(5);
    expect(back.rows[0]).toMatchObject({
      job_id: rows[0]!.job_id,
      cost_fen: rows[0]!.cost_fen,
      status: rows[0]!.status,
    });
  });
});

describe("聚合与统计", () => {
  it("total = ok + fail、良率 + 失败率 = 1、groupBy 行数守恒", () => {
    const s = E.stats(rows);
    expect(s.total).toBe(s.ok + s.fail);
    expect(Math.abs(s.yield + s.failRate - 1)).toBeLessThan(1e-9);
    const g = E.groupBy(rows, "material");
    expect(Object.values(g).reduce((sum, list) => sum + list.length, 0)).toBe(rows.length);
  });

  it("KPI 重点机台样本量达标、确为失败率最高者、时间跨度按数据实算", () => {
    const k = E.kpis(rows);
    if (k.worstMachine) {
      expect(k.worstMachine.n).toBeGreaterThanOrEqual(E.MIN_SAMPLE);
      const ok = Object.entries(E.groupBy(rows, "machine_id"))
        .filter(([, g2]) => g2.length >= E.MIN_SAMPLE)
        .every(([, g2]) => E.stats(g2).failRate <= k.worstMachine!.failRate + 1e-9);
      expect(ok).toBe(true);
    }
    expect(k.dateRange?.from).toBeTruthy();
    expect(k.dateRange?.to).toBeTruthy();
    expect(k.dateRange!.days).toBeGreaterThan(0);
  });

  it("相关系数：完全正/负相关与样本不足", () => {
    expect(
      Math.abs(
        E.pearson([
          [1, 2],
          [2, 4],
          [3, 6],
        ])! - 1
      )
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(
        E.pearson([
          [1, 6],
          [2, 4],
          [3, 2],
        ])! + 1
      )
    ).toBeLessThan(1e-9);
    expect(
      E.pearson([
        [1, 1],
        [2, 2],
      ])
    ).toBeNull();
  });
});

describe("意图识别", () => {
  it.each([
    ["上周哪台机故障率最高", "machine_fault"],
    ["PLA 和 PETG 在悬垂件上的失败率差多少", "material_cmp"],
    ["层高与表面质量的相关性", "corr_layer"],
    ["本月单件成本与耗材成本趋势", "cost_trend"],
    ["失败批次有没有共性", "fail_root"],
    ["随便看看", "overview"],
  ])("%s → %s", (q, intent) => {
    expect(E.detectIntent(q)).toBe(intent);
  });
});

describe("报告结构（与后端产物同构）", () => {
  it("六类问题均产出完整报告、图表结构合法、引擎如实标注 local-rules", () => {
    const qs = [
      "哪台机故障率最高，主要故障是什么",
      "PLA 和 PETG 失败率对比",
      "层高与打印时长的相关性",
      "本月成本趋势",
      "失败批次共性归因",
      "总体概览",
    ];
    for (const q of qs) {
      const r = E.analyze(q, rows);
      expect(r.title).toBeTruthy();
      expect(r.verdict).toBeTruthy();
      expect(Array.isArray(r.sections)).toBe(true);
      expect(r.engine).toBe("local-rules");
      if (r.chart) {
        expect(r.chart.kind).toBeTruthy();
        expect(Array.isArray(r.chart.items)).toBe(true);
      }
    }
  });

  it("空数据集安全返回，可信度为 insufficient-data", () => {
    const empty = E.analyze("任何问题", []);
    expect(empty.title).toBe("无数据");
    expect(empty.chart).toBeNull();
    expect(empty.confidence).toBe("insufficient-data");
    expect(Array.isArray(E.analyze("x", []).evidence)).toBe(true);
  });
});

describe("统计守卫：最小样本量（防「1 单 1 失败 = 100% 故障率」登顶）", () => {
  it("样本不足的机台不被评为最差，但仍以 weak 标记展示", () => {
    const r = E.analyze("哪台机故障率最高", makeRows("TINY", 1, 1).concat(makeRows("BIG", 20, 4)));
    expect(r.highlight?.id).toBe("BIG");
    expect(r.verdict).not.toContain("TINY");
    expect(r.chart!.items.some((it) => it.label === "TINY" && it.weak === true)).toBe(true);
    expect(JSON.stringify(r.sections)).toContain("TINY");
  });

  it("全员样本不足 → 拒绝排名、insufficient-data、结论明说样本不足", () => {
    const r2 = E.analyze("哪台机故障率最高", makeRows("A", 2, 2).concat(makeRows("B", 1, 0)));
    expect(r2.highlight).toBeNull();
    expect(r2.confidence).toBe("insufficient-data");
    expect(r2.verdict).toContain("样本不足");
  });
});

describe("已知效应识别（构造数据 → 引擎能否找出来）", () => {
  it("识别注入的高故障机台并报出真实失败率与样本量；效应调转后结论随之调转", () => {
    const r = E.analyze("哪台机故障率最高", makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1)));
    expect(r.highlight?.id).toBe("BAD");
    expect(r.verdict).toContain("40.0%");
    expect(r.verdict).toContain("8/20");
    const r2 = E.analyze("哪台机故障率最高", makeRows("BAD", 20, 1).concat(makeRows("OK", 20, 8)));
    expect(r2.highlight?.id).toBe("OK");
  });
});

describe("诚实性：来源标记 / 未识别问题 / 机台 ID / 故障词表", () => {
  it("报告携带 provenance；未匹配维度如实标注并列出支持的维度", () => {
    const r = E.analyze("概览", rows, { provenance: D.PROVENANCE.sample });
    expect((r.provenance as { synthetic: boolean }).synthetic).toBe(true);
    const unknown = E.analyze("今天天气怎么样", rows);
    expect(unknown.intentMatched).toBe(false);
    expect(unknown.title).toContain("未识别");
    expect(JSON.stringify(unknown.sections)).toContain(E.SUPPORTED[0]!);
    expect(E.analyze("哪台机故障率最高", rows).intentMatched).toBe(true);
  });

  it("机台 ID 取自当前机型，无机型信息时不冒充具体机台", () => {
    expect(D.machineIdFromSim({ printer: { MODEL_TAG: "FX-500" } })).toBe("FX-500-01");
    expect(D.machineIdFromSim({ printer: { MODEL_TAG: "FX-Δ260" } })).toBe("FX-Δ260-01");
    expect(D.machineIdFromSim({})).toBe("UNKNOWN-01");
  });

  it("仿真可产故障全在标准词表内；词表覆盖两个阶段；未知故障独立取值且 normalizeFault 不猜", () => {
    const reasons: readonly string[] = D.FAIL_REASONS;
    expect(D.SIM_FAULTS.every((f) => reasons.includes(f))).toBe(true);
    expect(D.FAULT_TAXONOMY.some((f) => f.stage === "runtime")).toBe(true);
    expect(D.FAULT_TAXONOMY.some((f) => f.stage === "scrap")).toBe(true);
    expect(D.FAIL_REASONS).not.toContain(D.FAULT_UNKNOWN);
    expect(D.normalizeFault("某种没见过的错误")).toBe(D.FAULT_UNKNOWN);
  });
});

describe("计价口径可溯与可替换", () => {
  afterEach(() => {
    D.setCostProfile(DEFAULT_COST); // 还原，避免影响后续用例
  });

  it("带出处说明；替换后金额随之变化，未覆盖字段沿用原值；未知材料落到兜底单价", () => {
    expect(D.getCostProfile().source).toBeTruthy();
    expect(D.getCostProfile().id).toBeTruthy();
    const before = D.costFen("PLA", 1000, 0, 0);
    D.setCostProfile({ id: "test", material: { PLA: 10000 } });
    const after = D.costFen("PLA", 1000, 0, 0);
    expect(before).toBe(6900);
    expect(after).toBe(10000);
    expect(D.getCostProfile().powerFenPerKwh).toBe(60);
    expect(D.costFen("UNOBTAINIUM", 1000, 0, 0)).toBe(D.getCostProfile().materialDefaultFen);
  });
});

describe("统计严谨性：结论必须带证据，不显著必须明说", () => {
  it("显著差异 → 「显著高于」+ p 值 + 置信区间，可信度不为 low，evidence 写明 Fisher", () => {
    const strong = E.analyze("哪台机故障率最高", makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1)));
    expect(strong.verdict).toContain("显著高于");
    expect(strong.verdict).toMatch(/p[<=]/);
    expect(strong.verdict).toContain("95%CI");
    expect(strong.confidence).not.toBe("low");
    expect(strong.evidence!.length).toBeGreaterThan(0);
    const ev = strong.evidence![0]!;
    expect(ev.claim).toBeTruthy();
    expect(ev.method).toMatch(/Fisher/);
    expect(typeof ev.n).toBe("number");
    expect(typeof ev.pValue).toBe("number");
  });

  it("噪声差异 → 明说「未达统计显著」、可信度 low、仍提供 highlight 供排查", () => {
    const weak = E.analyze("哪台机故障率最高", makeRows("A", 20, 5).concat(makeRows("B", 20, 4)));
    expect(weak.verdict).toContain("未达统计显著");
    expect(weak.confidence).toBe("low");
    expect(weak.verdict).not.toContain("显著高于");
    expect(weak.highlight).toBeTruthy();
  });
});

describe("混杂因素：层高分析必须给出两个口径", () => {
  it("同时给出未控制与已控制口径，以偏相关为主并声明相关不等于因果", () => {
    // 辛普森结构：组内层高↑时长↓，但 TPU 组整体又慢又用大层高 → 粗相关为正
    const ds: JobRow[] = [];
    const push = (mat: string, lh: number, dur: number, n: number) => {
      for (let i = 0; i < n; i++) {
        ds.push({
          job_id: `${mat}-${lh}-${i}`,
          date: "2026-07-01",
          machine_id: "M1",
          model_name: "件A",
          material: mat,
          layer_height_mm: lh,
          duration_min: dur + i,
          filament_g: 30,
          cost_fen: 300,
          status: "success",
          fail_reason: "",
          energy_kwh: 0.4,
        });
      }
    };
    push("PLA", 0.12, 60, 6);
    push("PLA", 0.28, 40, 6);
    push("TPU", 0.12, 200, 6);
    push("TPU", 0.28, 180, 6);

    const r = E.analyze("层高与打印时长的相关性", ds);
    const sections = JSON.stringify(r.sections);
    expect(sections).toContain("未控制混杂");
    expect(sections).toContain("控制材料与模型后");
    expect(r.verdict).toContain("控制材料与模型后");
    expect(r.verdict).toMatch(/r=-/);
    expect(sections).toContain("相关不等于因果");
    expect(r.evidence!.length).toBeGreaterThanOrEqual(2);
    expect(r.evidence!.some((e) => /控制材料与模型/.test(e.claim))).toBe(true);
  });
});

describe("KPI 与分析器口径一致（不再各自为政）", () => {
  it("指向同一台机器、带置信区间与显著性标记、样本不足的机台不进 KPI", () => {
    const ds = makeRows("BAD", 20, 8)
      .concat(makeRows("OK", 20, 1))
      .concat(makeRows("TINY", 2, 2));
    const k = E.kpis(ds);
    const r = E.analyze("哪台机故障率最高", ds);
    expect(k.worstMachine!.id).toBe(r.highlight!.id);
    expect(k.worstMachine!.ci.lo).toBeGreaterThanOrEqual(0);
    expect(typeof k.worstMachine!.significant).toBe("boolean");
    expect(k.worstMachine!.id).not.toBe("TINY");
  });
});
