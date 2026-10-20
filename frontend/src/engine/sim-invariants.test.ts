/* Stage 10.4 引擎数值锁定：FXSim 状态机 / 温控 / 调平 / 运动 / 耗材 / 质量推导。
   与 engine-invariants.test.ts 同一口径：期望值是当前实现在固定输入（固定 dt=1/60、
   固定 simMult、确定性机台画像与噪声相位）下的实测输出。仿真链没有任何 Math.random，
   同一台机器跑同样的活必须得到逐位相同的结果——这既是数据集可复现的前提，
   也是这里能做精确锁定的原因。

   打印机侧用最小桩替代 THREE 几何（sim 只依赖 printer3d.ts 文件头列出的契约方法），
   使断言只覆盖 sim 自身的数值，与 printer-kinematics.test.ts 分工。 */
import { describe, expect, it } from "vitest";
import { FXSim, type SimSettings } from "./sim.ts";
import { createBuiltins } from "./models.ts";
import { parse } from "./gcode-parser.ts";
import * as FXMachineProfile from "./machine-profile.ts";

/* ── 打印机契约桩 ─────────────────────────── */

interface StubSpec {
  id: string;
  tag: string;
  name: string;
  kin: string;
  nozzleY: number;
  bedSize: number;
}
const STUBS: Record<string, StubSpec> = {
  corexy: { id: "corexy", tag: "FX-256", name: "FX-256 睿造", kin: "CoreXY", nozzleY: 334.5, bedSize: 256 },
  i3: { id: "i3", tag: "FX-220", name: "FX-220 轻锋", kin: "i3 Gantry", nozzleY: 300, bedSize: 220 },
};

function makeStubPrinter(spec: StubSpec) {
  const calls: Record<string, number> = {};
  const hit = (k: string) => (calls[k] = (calls[k] || 0) + 1);
  let z = 0;
  const p = {
    ID: spec.id,
    MODEL_TAG: spec.tag,
    MODEL_NAME: spec.name,
    KIN_TAG: spec.kin,
    NOZZLE_Y: spec.nozzleY,
    BED_SIZE: spec.bedSize,
    PROFILE: undefined,
    nozzleHotFrac: 0,
    bedHotFrac: 0,
    fanFrac: 0,
    extrudeRate: 0,
    headMX: 0,
    headMY: 0,
    grown: 0,
    spoolFrac: 1,
    calls,
    get bedTopY() {
      return spec.nozzleY - z;
    },
    setBedTopY(y: number) {
      z = spec.nozzleY - y;
    },
    setHeadXY(mx: number, my: number) {
      p.headMX = mx;
      p.headMY = my;
    },
    setStateLED: () => hit("setStateLED"),
    attachPart: () => hit("attachPart"),
    attachToolpath: () => hit("attachToolpath"),
    showGhost: () => hit("showGhost"),
    showPart: () => hit("showPart"),
    updatePartTf: () => hit("updatePartTf"),
    setFilamentColor: () => hit("setFilamentColor"),
    setSpoolFrac(f: number) {
      p.spoolFrac = f;
    },
    setGrownHeight(h: number) {
      p.grown = h;
      hit("setGrownHeight");
    },
    beginLayer: () => hit("beginLayer"),
    endLayer: () => hit("endLayer"),
    setLayerProgress: () => {},
  };
  return p;
}

function makeSim(id = "corexy") {
  const events: Array<[string, unknown]> = [];
  const logs: string[] = [];
  const fx = {
    printer: makeStubPrinter(STUBS[id]!),
    swapPrinter(nextId: string) {
      fx.printer = makeStubPrinter(STUBS[nextId]!);
      return fx.printer;
    },
  };
  const bus = {
    emit(ev: string, payload?: unknown) {
      if (ev === "log") {
        const p = payload as { lv: string; msg: string };
        logs.push(`${p.lv}:${p.msg}`);
      } else events.push([ev, payload]);
    },
  };
  const sim = new FXSim(fx as never, bus);
  return { sim, fx, events, logs };
}

const DT = 1 / 60;
/** 固定步长推进到谓词成立，返回消耗的帧数（帧数本身也是被锁定的数值） */
function runUntil(sim: FXSim, pred: () => boolean, maxTicks: number): number {
  let n = 0;
  while (!pred() && n < maxTicks) {
    sim.tick(DT, n * DT);
    n++;
  }
  return n;
}

const TINY_GCODE = [
  ";TIME:120",
  ";Filament used: 0.5m",
  "M104 S210",
  "M140 S60",
  "G28",
  "G1 Z0.2 F600",
  "G1 X10 Y0 E1 F1200",
  "G1 X10 Y10 E2",
  "G0 X0 Y0",
  "G1 Z0.4",
  "G1 X10 Y0 E3 F1800",
  "G1 X10 Y10 E3.5",
].join("\n");

/* ── 机台画像与故障机理（纯函数） ─────────── */

describe("机台画像：machineId 唯一决定物理特征", () => {
  it("FX-256-01 / FX-256-02 / FX-220-01 的出厂特征", () => {
    FXMachineProfile.resetCache();
    expect(FXMachineProfile.of("FX-256-01")).toEqual({
      id: "FX-256-01",
      modelTag: "FX-256",
      seed: 355385697,
      enclosed: true,
      buildMm: 256,
      hotendFouling: 0.089,
      feederGrip: 0.741,
      spoolDrag: 0.667,
      heaterHealth: 0.935,
      beltWear: 0.565,
      ambientC: 35.1,
      draft: 0.018,
      heaterTauMul: 1.143,
    });
    const p2 = FXMachineProfile.of("FX-256-02");
    expect([p2.seed, p2.hotendFouling, p2.feederGrip, p2.heaterHealth, p2.ambientC]).toEqual([
      305052840, 0.015, 0.824, 0.968, 37.5,
    ]);
    const p3 = FXMachineProfile.of("FX-220-01");
    expect([p3.seed, p3.enclosed, p3.buildMm, p3.hotendFouling, p3.ambientC, p3.draft]).toEqual([
      2832730638,
      false,
      220,
      0.854,
      24,
      0.642,
    ]);
    expect(FXMachineProfile.of("FX-256-01")).toBe(FXMachineProfile.of("FX-256-01")); // 缓存同引用
    expect(FXMachineProfile.of("FX-256-01", { heaterHealth: 0.5 })).not.toBe(FXMachineProfile.of("FX-256-01"));
  });

  it("加热器稳态上限 / 堵料负载 / 打滑风险 / 翘边 / 悬垂", () => {
    const prof = FXMachineProfile.of("FX-256-01");
    expect(FXMachineProfile.heaterCeilingC(prof, prof.ambientC)).toBeCloseTo(282.7815, 9);
    expect(FXMachineProfile.heaterCeilingC(prof, null)).toBeCloseTo(282.19, 9);
    expect(
      FXMachineProfile.hotendLoad(prof, {
        nozzleTarget: 210,
        nozzleNow: 196,
        materialNominalC: 210,
        flowMm3s: 12.5,
        materialFlowMm3s: 11,
        extrudedMm3: 50000,
      })
    ).toBeCloseTo(0.6380465241070683, 12);
    expect(
      FXMachineProfile.feedSlipRisk(prof, { flowMm3s: 8, materialFlowMm3s: 11, spoolRemainFrac: 0.05 })
    ).toBeCloseTo(1.1414626363636364, 12);
    expect(
      FXMachineProfile.warpRisk(prof, {
        bedMinC: 95,
        bedNow: 60,
        shrinkage: 1.0,
        firstLayerAreaMm2: 3000,
        firstLayerUnevenMm: 0.12,
        fanFrac: 1,
      })
    ).toBe(5); // 封顶
    expect(
      FXMachineProfile.warpRisk(FXMachineProfile.of("FX-220-01"), {
        bedMinC: 55,
        bedNow: 60,
        shrinkage: 0.25,
        firstLayerAreaMm2: 3000,
        firstLayerUnevenMm: 0.03,
        fanFrac: 1,
      })
    ).toBeCloseTo(0.346169825214632, 12);
    const oh = (s: FXMachineProfile.OverhangState) => FXMachineProfile.overhangRisk(prof, s);
    expect(oh({ needSupport: true, supportEnabled: false, fanFrac: 1, layerHeightMm: 0.2, speedMmS: 60 })).toBe(2);
    expect(
      oh({ needSupport: true, supportEnabled: true, fanFrac: 0.3, layerHeightMm: 0.32, speedMmS: 180 })
    ).toBeCloseTo(1.224, 12);
    expect(oh({ needSupport: false, supportEnabled: false, fanFrac: 0, layerHeightMm: 0.32, speedMmS: 180 })).toBe(0);
  });
});

/* ── 质量推导（静态纯函数） ────────────────── */

describe("质量推导：工艺预估与成品实测评分", () => {
  const defaults = (): SimSettings => makeSim().sim.settings;
  const bracket = { id: "bracket", name: "b", dims: "", height: 30, footprintR: 28, needSupport: true };
  const rows = (list: Array<{ name: string; score: number; level: string }>) =>
    list.map((q) => [q.name, q.score, q.level]);

  it("computeQuality：默认 PLA / 高温 ABS 全风扇 / TPU 大回抽", () => {
    expect(rows(FXSim.computeQuality(defaults(), null))).toEqual([
      ["层间结合强度", 99, "good"],
      ["首层附着可靠性", 99, "good"],
      ["表面质量预估", 84, "good"],
      ["回抽与拉丝控制", 99, "good"],
      ["尺寸精度预估", 95, "good"],
      ["悬垂结构成形", 95, "good"],
    ]);
    expect(
      rows(
        FXSim.computeQuality(
          {
            ...defaults(),
            material: "ABS",
            nozzleTemp: 275,
            bedTemp: 80,
            fanSpeed: 100,
            speed: 220,
            layerHeight: 0.3,
            retraction: 3,
            skirtLoops: 0,
          },
          bracket
        )
      )
    ).toEqual([
      ["层间结合强度", 40, "bad"],
      ["首层附着可靠性", 37, "bad"],
      ["表面质量预估", 49, "bad"],
      ["回抽与拉丝控制", 41, "bad"],
      ["尺寸精度预估", 68, "mid"],
      ["悬垂结构成形", 92, "good"],
    ]);
    expect(
      rows(
        FXSim.computeQuality(
          {
            ...defaults(),
            material: "TPU",
            nozzleTemp: 225,
            bedTemp: 50,
            fanSpeed: 50,
            speed: 40,
            layerHeight: 0.1,
            retraction: 2.5,
          },
          bracket
        )
      )
    ).toEqual([
      ["层间结合强度", 99, "good"],
      ["首层附着可靠性", 99, "good"],
      ["表面质量预估", 97, "good"],
      ["回抽与拉丝控制", 45, "bad"],
      ["尺寸精度预估", 98, "good"],
      ["悬垂结构成形", 92, "good"],
    ]);
  });

  it("computeActualQuality：扰动多的过程评 C，平稳但未调平的过程评 B", () => {
    const st = defaults();
    const prof = FXMachineProfile.of("FX-256-01");
    const tel = {
      printTime: 1000,
      tempTime: 1000,
      tempDevSum: 1800,
      tempDevMax: 14,
      offSpeedTime: 50,
      faults: ["喷嘴堵塞预警"],
      pauses: 1,
      tunes: 2,
      leveled: true,
      levelMax: 0.21,
      firstLayerUneven: 0.12,
      firstLayerAreaMm2: 2500,
      usedG0: 0,
      settings0: st,
      clogLoadMax: 0,
      slipRiskMax: 0,
      travelMoves: 300,
      travelMm: 4000,
      retractions: 200,
      retractedMm: 600,
      stringingRiskWeighted: 1500,
      stringingTravelMm: 3500,
      retractionStress: 80,
      machineId: "FX-256-01",
      machineProfile: prof,
    };
    const q1 = FXSim.computeActualQuality(tel, st, null, { elapsed: 1234, usedG: 5.5 });
    expect([q1.score, q1.grade]).toEqual([75, "C"]);
    expect(rows(q1.checks)).toEqual([
      ["温度过程稳定性", 65, "mid"],
      ["首层成形与调平", 93, "good"],
      ["过程扰动与恢复", 57, "mid"],
      ["回抽与跨路径拉丝", 66, "mid"],
      ["速度一致性", 96, "good"],
    ]);
    const q2 = FXSim.computeActualQuality(
      {
        ...tel,
        leveled: false,
        levelMax: null,
        faults: [],
        pauses: 0,
        tunes: 0,
        tempDevSum: 300,
        tempDevMax: 4,
        offSpeedTime: 0,
        stringingRiskWeighted: 400,
        retractionStress: 0,
      },
      st,
      null,
      null
    );
    expect([q2.score, q2.grade]).toEqual([88, "B"]);
    expect(rows(q2.checks)).toEqual([
      ["温度过程稳定性", 96, "good"],
      ["首层成形与调平", 54, "bad"],
      ["过程扰动与恢复", 98, "good"],
      ["回抽与跨路径拉丝", 92, "good"],
      ["速度一致性", 98, "good"],
    ]);
  });
});

/* ── 床面误差场与自动调平 ─────────────────── */

describe("床面误差场与 3×3 探测调平（Stage 10.4）", () => {
  it("bedErrorAt：由 machineId 播种，换机台编号即换误差场", () => {
    const { sim } = makeSim();
    expect(sim.machineId).toBe("FX-256-01");
    const pts: Array<[number, number]> = [
      [0, 0],
      [100, 0],
      [0, 100],
      [-99.84, -99.84],
      [50, -50],
    ];
    const err = pts.map(([x, y]) => sim.bedErrorAt(x, y));
    expect(err[0]).toBeCloseTo(0.03322454074984611, 12);
    expect(err[1]).toBeCloseTo(0.051159517325727016, 12);
    expect(err[2]).toBeCloseTo(0.02501783839652329, 12);
    expect(err[3]).toBeCloseTo(-0.029298567659783524, 12);
    expect(err[4]).toBeCloseTo(0.049412361200238904, 12);
    sim.setMachineInstance(3);
    expect(sim.machineId).toBe("FX-256-03");
    expect(sim.bedErrorAt(0, 0)).toBeCloseTo(-0.023032153178815858, 12);
    expect(sim.bedErrorAt(100, 0)).toBeCloseTo(-0.020929558588798487, 12);
    // 未调平时补偿为 0
    expect(sim.meshCompAt(0, 0)).toBe(0);
  });

  it("runLeveling：231 帧完成 9 点探测，网格拟合与补偿插值", () => {
    const { sim, events } = makeSim();
    sim.runLeveling();
    expect(sim.state).toBe("level");
    expect(runUntil(sim, () => sim.state === "idle", 100000)).toBe(231);
    expect(sim.machineElapsed).toBeCloseTo(15.333333333333298, 9);
    expect(sim.headPos).toEqual({ x: 99.84, y: -99.84 }); // 最后一个探测点 = probeR(半幅 128 × 0.78)
    const mesh = sim.levelMesh!;
    expect(mesh.half).toBe(128);
    expect(mesh.max).toBeCloseTo(0.07010047301277397, 12);
    const samples = [
      -0.03080935831947463, 0.009226475190311967, -0.0027438861520245996, -0.0386950732725886, 0.07010047301277397,
      0.029600333241779894, -0.02273744016500018, 0.05574799787021449, 0.06180154389700509,
    ];
    expect(mesh.samples.length).toBe(9);
    samples.forEach((v, i) => expect(mesh.samples[i]).toBeCloseTo(v, 12));
    const row0 = [
      -0.03080935831947463, -0.016437520649294827, 0.009226475190311967, 0.0015531666375321164, -0.0027438861520246004,
    ];
    const row2 = [
      -0.0386950732725886, 0.0003597382144646319, 0.07010047301277397, 0.04413884495444444, 0.029600333241779894,
    ];
    row0.forEach((v, i) => expect(mesh.grid[0]![i]).toBeCloseTo(v, 12));
    row2.forEach((v, i) => expect(mesh.grid[2]![i]).toBeCloseTo(v, 12));
    expect(sim.meshCompAt(0, 0)).toBeCloseTo(0.07010047301277397, 12);
    expect(sim.meshCompAt(60, -30)).toBeCloseTo(0.04985534679689179, 12);
    expect(sim.meshCompAt(-99.84, 99.84)).toBeCloseTo(-0.024015884920952656, 12);
    expect(sim.meshCompAt(500, 500)).toBeCloseTo(-0.0027438861520246004, 12); // 越界取边角
    expect(events.map((e) => e[0])).toEqual(["state", "levelmesh", "state"]);
  });
});

/* ── 整单打印：行星齿轮 ───────────────────── */

describe("整单打印数值锁定：行星齿轮 · FX-256-01 · 默认工艺 · 不自动调平", () => {
  it("切片 → 预热 → 逐层打印 → 完成，机时 / 耗材 / 遥测 / 实测评级逐位一致", () => {
    const { sim, fx, events, logs } = makeSim();
    sim.updateSettings({ autoLevel: false });
    sim.setModel(createBuiltins()[0]!, true);
    expect(sim.slice!.totalLayers).toBe(80);
    expect(sim.slice!.stats.timeSec).toBeCloseTo(1515.6737546794202, 6);
    expect(sim.estimateTotal()).toBeCloseTo(1610.6737546794202, 6); // + 95 s 预热/收尾

    sim.start();
    expect(sim.state).toBe("heat");
    expect(sim.bedTargetY).toBe(274.5); // NOZZLE_Y − 60
    expect(sim.nozzleT.target).toBe(210);
    expect(sim.bedT.target).toBe(60);

    expect(runUntil(sim, () => sim.state !== "heat", 100000)).toBe(1987);
    expect(sim.state).toBe("print");
    expect(sim.nozzleNow).toBeCloseTo(210.33157974273757, 9);
    expect(sim.bedNow).toBeCloseTo(57.01461769996311, 9);
    expect(sim.machineElapsed).toBeCloseTo(132.46666666666428, 9);
    expect(sim.headPos.x).toBeCloseTo(-110, 9); // 起点：床角 (−110, 110)
    expect(sim.headPos.y).toBeCloseTo(110, 9);

    expect(runUntil(sim, () => sim.state !== "print", 200000)).toBe(21656);
    expect(sim.state).toBe("done");
    expect(sim.progress).toBe(1);
    expect(sim.layerIdx).toBe(79);
    expect(sim.faultInfo).toBeNull();
    expect(sim.machineElapsed).toBeCloseTo(1576.1333333332145, 6);
    expect(sim.usedG).toBeCloseTo(10.272498869400252, 6);
    expect(sim.usedLenMm).toBeCloseTo(3444.2006013875275, 6);
    expect(sim.estimateRemaining()).toBe(0);
    expect(fx.printer.grown).toBe(16);
    expect(sim.bedTargetY).toBe(214.5); // 完成后床面下沉：NOZZLE_Y − max(120, 高度 + 40)
    expect(fx.printer.calls).toEqual({
      attachPart: 1,
      showGhost: 2,
      setGrownHeight: 81,
      showPart: 1,
      setStateLED: 3,
      beginLayer: 80,
      endLayer: 80,
    });

    const T = (sim as unknown as { _telemetry: Record<string, number | string | boolean | null | unknown[]> })
      ._telemetry;
    expect(T.printTime).toBeCloseTo(1443.733333333335, 6);
    expect(T.tempDevSum as number).toBeCloseTo(213.3350122421404, 6);
    expect(T.tempDevMax as number).toBeCloseTo(0.64377382480086, 9);
    expect(T.offSpeedTime).toBe(0);
    expect(T.faults).toEqual([]);
    expect([T.pauses, T.tunes, T.leveled, T.levelMax]).toEqual([0, 0, false, null]);
    expect(T.firstLayerUneven as number).toBeCloseTo(0.09108095757191294, 9);
    expect(T.firstLayerAreaMm2 as number).toBeCloseTo(4410.827061745811, 6);
    expect(T.clogLoadMax as number).toBeCloseTo(0.32831537754237583, 9);
    expect(T.slipRiskMax as number).toBeCloseTo(0.9128913636363637, 9);
    expect(T.travelMoves).toBe(2767);
    expect(T.travelMm as number).toBeCloseTo(28068.748330349998, 6);
    expect(T.retractions).toBe(2355);
    expect(T.retractedMm as number).toBeCloseTo(2826, 6);
    expect(T.stringingRiskWeighted as number).toBeCloseTo(2529.8856436265924, 6);
    expect(T.stringingTravelMm as number).toBeCloseTo(27834.65602546531, 6);
    expect(T.retractionStress).toBe(0);
    expect(T.machineId).toBe("FX-256-01");
    expect(T.warpRisk).toBe(0.17);
    expect(T.overhangRisk).toBe(0);

    expect([sim.lastQuality!.score, sim.lastQuality!.grade]).toEqual([90, "A"]);
    expect(sim.lastQuality!.checks.map((c) => c.score)).toEqual([98, 63, 98, 93, 98]);

    expect(events.filter((e) => e[0] === "job-record").map((e) => e[1])).toEqual([{ status: "success", fault: null }]);
    const counts: Record<string, number> = {};
    for (const [ev] of events) counts[ev] = (counts[ev] || 0) + 1;
    expect(counts).toEqual({ sliced: 1, state: 3, layer: 80, "quality-actual": 1, done: 1, "job-record": 1 });
    expect(logs.at(-2)).toBe("ok:打印完成：行星齿轮 · 用时 26 分钟（机时）· 耗材 10.3 g");
    expect(logs.at(-1)).toBe("info:成品实测质量评级 A（综合 90 分）· 详见「质量」面板");
  });
});

/* ── 导入 G-code 打印 / 故障链 / 机型切换 ──── */

describe("导入 G-code 整单与故障链（Stage 10.4）", () => {
  it("两层 3.5 mm 挤出：耗材按 Ø1.75 截面 × PLA 1.24 g/cm³ 换算", () => {
    const { sim, events } = makeSim();
    sim.updateSettings({ autoLevel: false });
    const model = sim.loadImportedToolpath(parse(TINY_GCODE, { origin: "corner" }), { name: "tiny.gcode" });
    expect(model).toEqual({
      id: "gcode-import",
      name: "tiny.gcode",
      dims: "10.0 × 10.0 × 0.4 mm",
      height: 0.4,
      footprintR: 128,
      needSupport: false,
      source: "gcode-import",
    });
    expect([sim.settings.layerHeight, sim.settings.nozzleTemp, sim.settings.bedTemp]).toEqual([0.2, 210, 60]);
    sim.start();
    runUntil(sim, () => sim.state !== "heat", 100000);
    expect(runUntil(sim, () => sim.state !== "print", 100000)).toBe(42);
    expect(sim.state).toBe("done");
    expect(sim.usedLenMm).toBeCloseTo(3.5, 9);
    expect(sim.usedG).toBeCloseTo(0.010438923339256336, 12); // 3.5 × π × 0.875² / 1000 × 1.24
    expect(sim.machineElapsed).toBeCloseTo(135.19999999999746, 9);
    expect([sim.lastQuality!.score, sim.lastQuality!.grade]).toEqual([94, "A"]);
    expect(events.filter((e) => e[0] === "job-record").map((e) => e[1])).toEqual([{ status: "success", fault: null }]);
  });

  it("热失控：注入后 71 帧被「偏差>15°C 且 3 s 无回升」监测器发现；恢复 → 堵料 → 停止记为失败单", () => {
    const { sim, events } = makeSim();
    sim.updateSettings({ autoLevel: false });
    sim.setModel(createBuiltins()[0]!, true);
    sim.start();
    runUntil(sim, () => sim.state === "print", 100000);
    runUntil(sim, () => sim.layerIdx >= 2, 100000);
    sim.injectFault("thermal");
    expect(sim.nozzleT.heaterBroken).toBe(true);
    expect(runUntil(sim, () => sim.state === "fault", 100000)).toBe(71);
    expect(sim.nozzleNow).toBeCloseTo(173.41827062535614, 9);
    expect(sim.nozzleT.target).toBe(26); // 加热已切断
    expect(sim.currentAction).toBe("故障暂停");
    expect(sim.faultInfo).toEqual({
      name: "热失控保护",
      msg: "喷嘴实测 173°C，低于目标 210°C 达 37°C 且无回升（持续 3.0s），加热已切断",
    });

    sim.resume();
    expect(sim.state).toBe("print");
    expect(sim.nozzleT.heaterBroken).toBe(false);
    expect(sim.nozzleT.target).toBe(210);
    expect(sim.faultInfo).toBeNull();

    sim.injectFault("jam");
    expect(sim.state).toBe("fault");
    expect(sim.faultInfo).toEqual({ name: "喷嘴堵塞预警", msg: "挤出机负载异常升高（+142%），疑似堵料" });
    expect((sim as unknown as { _telemetry: { faults: string[] } })._telemetry.faults).toEqual([
      "热失控保护",
      "喷嘴堵塞预警",
    ]);

    sim.stop();
    expect(sim.state).toBe("idle");
    expect(sim.progress).toBe(0);
    expect(sim.bedTargetY).toBe(184.5); // 停机回到 NOZZLE_Y − 150
    expect(events.filter((e) => e[0] === "job-record").map((e) => e[1])).toEqual([
      { status: "fail", fault: "喷嘴堵塞预警" },
    ]);
  });

  it("摆放钳制 / 机型切换 / 材料预设", () => {
    const { sim, fx } = makeSim();
    sim.setModel(createBuiltins()[0]!, true);
    sim.updateTf({ offX: 500, offY: -500, scale: 1 });
    expect(sim.tf).toEqual({ scale: 1, rotZ: 0, offX: 98, offY: -98 }); // 半幅 128 − min(120, footprintR 30)
    sim.updateTf({ offX: 0, offY: 0, scale: 2.5 });
    sim.updateTf({ offX: 120, offY: 120 });
    expect(sim.tf).toEqual({ scale: 2.5, rotZ: 0, offX: 53, offY: 53 }); // 128 − 30 × 2.5

    expect(sim.setPrinterModel("i3")).toBe(true);
    expect(fx.printer.ID).toBe("i3");
    expect(sim.machineId).toBe("FX-220-01");
    expect(sim.bedTargetY).toBe(150); // 新机型 NOZZLE_Y 300 − 150
    expect(sim.state).toBe("idle");
    expect(sim.levelMesh).toBeNull();
    expect(sim.bedErrorAt(0, 0)).toBeCloseTo(-0.0023237014866498585, 12);
    expect(sim.bedErrorAt(80, 0)).toBeCloseTo(-0.0482895341356288, 12);
    expect(sim.setPrinterModel("i3")).toBe(false); // 同机型不重建

    sim.applyMaterial("ABS");
    expect([sim.settings.nozzleTemp, sim.settings.bedTemp, sim.settings.fanSpeed, sim.settings.speed]).toEqual([
      255, 100, 15, 120,
    ]);
    sim.applyMaterial("TPU");
    expect([sim.settings.nozzleTemp, sim.settings.bedTemp, sim.settings.fanSpeed, sim.settings.speed]).toEqual([
      225, 50, 50, 60,
    ]);
  });
});
