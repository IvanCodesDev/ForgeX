/* 仿真核心行为回归（Stage 7.4 前置：自 tests/sim-calib.test.js 迁入 vitest，改测 TS 引擎）
   用 stub 打印机驱动完整状态机：预热 → 调平 → 逐层打印 → 完成。
   覆盖：床面误差场确定性 / 探测→拟合→补偿数据链自洽 / 运行遥测 / 成品实测质量报告 /
   热失控监测链 / 实测质量纯函数边界 / 回抽参数进入估时。
   与 sim-invariants.test.ts 的分工：那边锁定精确数值，这里断言物理链路的**性质**。 */
import { describe, expect, it } from "vitest";
import { FXSim, type QualityReport, type SimModel, type SimSettings, type SimTelemetry } from "./sim.ts";

/* ── stub 打印机（只保留 sim 消费的契约面） ── */
function makePrinter(id: string) {
  return {
    ID: id,
    MODEL_NAME: "STUB-" + id,
    MODEL_TAG: "STUB-" + id,
    KIN_TAG: "stub",
    NOZZLE_Y: 200,
    bedTopY: 0,
    nozzleHotFrac: 0,
    bedHotFrac: 0,
    fanFrac: 0,
    extrudeRate: 0,
    setBedTopY(y: number) {
      this.bedTopY = y;
    },
    setHeadXY() {},
    setStateLED() {},
    setSpoolFrac() {},
    setFilamentColor() {},
    attachPart() {},
    attachToolpath() {},
    updatePartTf() {},
    showGhost() {},
    showPart() {},
    beginLayer() {},
    endLayer() {},
    setLayerProgress() {},
    setGrownHeight() {},
    clearPart() {},
    hideSlicePreview() {},
    showSlicePreview() {},
  };
}

function makeSim() {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {};
  const bus = {
    on(ev: string, fn: (payload: unknown) => void) {
      (listeners[ev] ||= []).push(fn);
    },
    emit(ev: string, payload?: unknown) {
      for (const fn of listeners[ev] || []) fn(payload);
    },
  };
  // 桩 ID 与经典测试保持一致（机台 ID 派生误差场种子，阈值按该种子标定）
  const fx = {
    printer: makePrinter("fx256"),
    swapPrinter(id: string) {
      fx.printer = makePrinter(id);
      return fx.printer;
    },
  };
  const sim = new FXSim(fx as never, bus);
  return { sim, bus };
}

/* 3 层迷你圆片模型（快速跑全状态机） */
function tinyModel(): SimModel {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 10, y: Math.sin(a) * 10 });
  }
  const zones = [{ z0: 0, z1: 0.6, loops: [{ pts }] }];
  return {
    id: "tiny",
    kind: "outline",
    name: "迷你圆片",
    dims: "Ø20 × 0.6 mm",
    height: 0.6,
    zones,
    outlinesAt() {
      return { loops: zones[0]!.loops };
    },
    needSupport: false,
    footprintR: 10,
  };
}

function runWhile(sim: FXSim, pred: () => boolean, maxTicks: number): number {
  let guard = maxTicks;
  while (pred() && guard-- > 0) sim.tick(0.25, 0);
  return guard;
}

const zCompAt = (sim: FXSim, x: number, y: number, z: number) =>
  (sim as unknown as { _zCompAt(x: number, y: number, z: number): number })._zCompAt(x, y, z);

describe("床面误差场（机台固有 · 确定性）", () => {
  it("同点重复采样一致、量级合理、同机型跨实例一致、不同机型不同", () => {
    const { sim } = makeSim();
    const a = sim.bedErrorAt(30, -40);
    expect(sim.bedErrorAt(30, -40)).toBe(a);
    expect(Math.abs(a)).toBeLessThan(0.3);
    const { sim: sim2 } = makeSim();
    expect(sim2.bedErrorAt(30, -40)).toBe(a);
    expect(sim2.setPrinterModel("delta260")).toBe(true);
    expect(sim2.bedErrorAt(30, -40)).not.toBe(a);
  });
});

describe("调平数据链：探测 → 9 点拟合 → 网格 → 补偿自洽", () => {
  const { sim } = makeSim();
  sim.setModel(tinyModel(), true);
  sim.runLeveling();

  it("进入 level 状态并完成回到待机，记录 9 个探测样本", () => {
    expect(sim.state).toBe("level");
    runWhile(sim, () => sim.state === "level", 2000);
    expect(sim.state).toBe("idle");
    expect(sim.levelMesh!.samples).toHaveLength(9);
  });

  it("中心探测值 = 误差场实测（±6µm 读数噪声），网格与补偿插值过探测点", () => {
    const err00 = sim.bedErrorAt(0, 0);
    const centerSample = sim.levelMesh!.samples[4]!; // 3×3 中心点 (0,0)
    expect(Math.abs(centerSample - err00)).toBeLessThanOrEqual(0.006);
    expect(Math.abs(sim.levelMesh!.grid[2]![2]! - centerSample)).toBeLessThan(1e-9);
    expect(Math.abs(sim.meshCompAt(0, 0) - centerSample)).toBeLessThan(1e-9);
    const probeNE = sim.levelMesh!.samples[2]!; // 行序 y=+100 行、x=+100 列
    expect(Math.abs(sim.meshCompAt(100, 100) - probeNE)).toBeLessThan(0.02);
  });

  it("补偿随 Z 淡出：Z=0 全量、Z≥6mm 归零", () => {
    expect(Math.abs(zCompAt(sim, 0, 0, 0) - sim.meshCompAt(0, 0))).toBeLessThan(1e-9);
    expect(zCompAt(sim, 0, 0, 6)).toBe(0);
  });

  it("重复调平结果稳定（床不会变，只有读数噪声 < 12µm）", () => {
    const s1 = sim.levelMesh!.samples.slice();
    sim.runLeveling();
    runWhile(sim, () => sim.state === "level", 2000);
    const s2 = sim.levelMesh!.samples;
    const maxDiff = Math.max(...s1.map((v, i) => Math.abs(v - s2[i]!)));
    expect(maxDiff).toBeLessThan(0.012);
  });
});

describe("全流程：预热 → 调平 → 打印 → 完成（遥测与实测报告）", () => {
  const { sim, bus } = makeSim();
  sim.simMult = 8;
  let jobRecord: { status?: string } | null = null;
  let actualEvt: unknown = null;
  bus.on("job-record", (r) => {
    jobRecord = r as { status?: string };
  });
  bus.on("quality-actual", (q) => {
    actualEvt = q;
  });
  sim.setModel(tinyModel(), true);
  sim.start();

  it("进入预热，遥测初始化并实测首层不均匀度", () => {
    expect(sim.state).toBe("heat");
    expect(sim._telemetry).toBeTruthy();
    expect(sim._telemetry!.firstLayerUneven).toBeGreaterThanOrEqual(0);
  });

  it("跑完全流程（done），经过自动调平，job-record 上报 success", () => {
    const guard = runWhile(sim, () => sim.state !== "done", 40000);
    expect(sim.state).toBe("done");
    expect(guard).toBeGreaterThan(0);
    expect(sim.levelMesh).toBeTruthy();
    expect(jobRecord).toMatchObject({ status: "success" });
  });

  it("实测质量报告：五个维度、合法评级、干净打印高分、引用调平网格、耗材与回抽遥测", () => {
    const q = sim.lastQuality!;
    expect(q.kind).toBe("actual");
    expect(q.checks).toHaveLength(5);
    expect(actualEvt).toBe(q);
    expect(q.score).toBeGreaterThanOrEqual(4);
    expect(q.score).toBeLessThanOrEqual(99);
    expect(["A", "B", "C", "D"]).toContain(q.grade);
    expect(q.checks[2]!.score).toBeGreaterThanOrEqual(90);
    expect(q.checks[1]!.tip).toContain("9 点模拟记录网格");
    expect(q.usedG).toBeGreaterThan(0);
    expect(sim._telemetry!.retractions).toBeGreaterThan(0);
    expect(sim._telemetry!.retractedMm).toBeGreaterThan(0);
    expect(q.checks[3]!.name).toContain("回抽");
  });
});

describe("热失控监测链：物理注入 → 温度真实下跌 → 监测器凭偏差发现", () => {
  const { sim, bus } = makeSim();
  sim.simMult = 8;
  let faultEvt: unknown = null;
  bus.on("fault", (f) => {
    faultEvt = f;
  });
  sim.setModel(tinyModel(), true);
  sim.start();
  runWhile(sim, () => sim.state !== "print", 40000);

  it("到达打印态；注入后不立即报警，但加热器已物理失效", () => {
    expect(sim.state).toBe("print");
    sim.injectFault("thermal");
    expect(sim.faultInfo).toBeNull();
    expect(sim.nozzleT.heaterBroken).toBe(true);
  });

  it("监测器凭偏差发现热失控：广播故障、遥测实录、进入 fault 态", () => {
    runWhile(sim, () => !sim.faultInfo, 8000);
    expect(sim.faultInfo?.name).toBe("热失控保护");
    expect(sim.nozzleT.target - sim.nozzleNow > 15 || sim.nozzleT.target <= 26).toBe(true);
    expect(faultEvt).toBeTruthy();
    expect(sim._telemetry!.faults).toContain("热失控保护");
    expect(sim.state).toBe("fault");
  });

  it("排障后加热器修复、目标恢复，可打完，实测报告记录本次故障", () => {
    sim.resume();
    expect(sim.nozzleT.heaterBroken).toBe(false);
    expect(sim.nozzleT.target).toBe(sim.settings.nozzleTemp);
    runWhile(sim, () => sim.state !== "done", 40000);
    expect(sim.state).toBe("done");
    expect(sim.lastQuality!.checks[2]!.tip).toContain("热失控保护");
  });
});

describe("实测质量纯函数（遥测 → 报告边界行为）", () => {
  const base = {
    printTime: 600,
    tempTime: 580,
    tempDevSum: 580 * 0.8,
    tempDevMax: 4,
    offSpeedTime: 0,
    faults: [] as string[],
    pauses: 0,
    tunes: 0,
    leveled: true,
    levelMax: 0.08,
    firstLayerUneven: 0.02,
    usedG0: 0,
    settings0: {},
  };
  const st = { material: "PLA" } as unknown as SimSettings;
  const quality = (patch: Record<string, unknown>, run = { elapsed: 600, usedG: 12 }): QualityReport =>
    FXSim.computeActualQuality({ ...base, ...patch } as unknown as SimTelemetry, st, null, run);
  const clean = quality({});

  it("干净遥测 → A/B 级；故障遥测 → 分数显著下降并列出故障实录", () => {
    expect(clean.score).toBeGreaterThanOrEqual(78);
    const faulty = quality(
      { faults: ["断料检测触发", "热失控保护"], pauses: 2, tempDevMax: 18, tempDevSum: 580 * 3 },
      { elapsed: 900, usedG: 12 }
    );
    expect(faulty.score).toBeLessThan(clean.score - 15);
    expect(faulty.checks[2]!.tip).toContain("断料检测触发");
    expect(faulty.checks[2]!.tip).toContain("热失控保护");
  });

  it("未调平且床面差 → 首层维度亮红并提示运行调平", () => {
    const unleveled = quality({ leveled: false, levelMax: null, firstLayerUneven: 0.18 });
    expect(unleveled.checks[1]!.score).toBeLessThan(55);
    expect(unleveled.checks[1]!.tip).toContain("自动调平");
  });

  it("变速 50% 时间 → 速度一致性降分", () => {
    expect(quality({ offSpeedTime: 300 }).checks[4]!.score).toBeLessThan(clean.checks[4]!.score);
  });

  it("回抽不足 → 拉丝实测维度明显降分", () => {
    const noRetract = quality({
      travelMoves: 20,
      travelMm: 1000,
      retractions: 0,
      retractedMm: 0,
      stringingRiskWeighted: 1000,
      stringingTravelMm: 1000,
      retractionStress: 0,
    });
    const tunedRetract = quality({
      travelMoves: 20,
      travelMm: 1000,
      retractions: 20,
      retractedMm: 24,
      stringingRiskWeighted: 90,
      stringingTravelMm: 1000,
      retractionStress: 0,
    });
    expect(noRetract.checks[3]!.score).toBeLessThan(tunedRetract.checks[3]!.score - 30);
  });
});

describe("回抽参数进入切片估时", () => {
  it("增加回抽会增加真实运动阶段与估时", () => {
    const { sim } = makeSim();
    sim.setModel(tinyModel(), true);
    sim.updateSettings({ retraction: 0 });
    const without = sim.slice!.stats.timeSec;
    sim.updateSettings({ retraction: 2 });
    expect(sim.slice!.stats.timeSec).toBeGreaterThan(without);
  });
});
