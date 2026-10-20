/* 打印时间校准模型（Stage 7.4 前置：自 tests/time-calibration.test.js 迁入 vitest，改测 TS 引擎）。 */
import { describe, expect, it } from "vitest";
import type { ParsedGcodeResult } from "./gcode-parser.ts";
import type { MachineLogResult } from "./machine-log.ts";
import { fit, fromPair, observation, predict } from "./time-calibration.ts";

const exact = [100, 200, 400, 800].map((planned, i) => ({
  id: `job-${i + 1}`,
  plannedTimeSec: planned,
  actualTimeSec: 90 + 1.25 * planned,
  machineId: "FX-TEST",
  firmware: "Marlin",
}));

describe("稳健拟合", () => {
  const model = fit(exact, { machineId: "FX-TEST", firmware: "Marlin" });

  it("Theil-Sen 精确恢复倍率与固定开销，保留作用域，训练误差为零", () => {
    expect(model.format).toBe("forgex-time-calibration");
    expect(model.method).toBe("theil-sen");
    expect(model.motionScale).toBeCloseTo(1.25, 9);
    expect(model.fixedOverheadSec).toBeCloseTo(90, 9);
    expect(model.scope).toMatchObject({ machineId: "FX-TEST", firmware: "Marlin" });
    expect(model.trainingMetrics!.maeSec).toBeLessThan(1e-9);
  });

  it("四样本生成留一交叉验证；预测使用固定开销与倍率", () => {
    expect(model.crossValidation?.sampleCount).toBe(4);
    expect(predict(model, 300)).toBeCloseTo(465, 9);
  });

  it("重复计划时长的交叉验证不串用别的样本预测", () => {
    const duplicateDuration = fit(
      exact.concat({ id: "same-duration", plannedTimeSec: 200, actualTimeSec: 340 } as never)
    );
    expect(duplicateDuration.crossValidation?.sampleCount).toBe(5);
    expect(duplicateDuration.crossValidation?.maeSec).toBeLessThan(1e-9);
  });
});

describe("抗单点异常", () => {
  it("单个暂停异常不摧毁主斜率，但暴露为最大相对误差", () => {
    const robust = fit(exact.concat({ id: "paused-job", plannedTimeSec: 600, actualTimeSec: 3000 } as never));
    expect(Math.abs(robust.motionScale - 1.25)).toBeLessThanOrEqual(0.05);
    expect(robust.trainingMetrics!.maxApe).toBeGreaterThan(0.5);
  });
});

describe("G-code / 日志配对观测", () => {
  const gcode = { stats: { timeSec: 120 } } as unknown as ParsedGcodeResult;
  const log = {
    name: "machine.json",
    actualTimeSec: 180,
    machineId: "FX-01",
    firmware: "Klipper",
  } as unknown as MachineLogResult;

  it("从现有结构建立样本并沿用日志机型与固件", () => {
    const pair = fromPair(gcode, log);
    expect(pair.plannedTimeSec).toBe(120);
    expect(pair.actualTimeSec).toBe(180);
    expect(pair.machineId).toBe("FX-01");
    expect(pair.firmware).toBe("Klipper");
  });

  it("单任务展示原始倍率，且不冒充完整校准", () => {
    const obs = observation(gcode, log);
    expect(obs.rawRatio).toBeCloseTo(1.5, 9);
    expect(obs.note).toMatch(/至少三个/);
  });
});

describe("防御性边界", () => {
  it("少于三组 / 计划时长无变化 / 无效配对 均明确拒绝", () => {
    expect(() => fit(exact.slice(0, 2))).toThrow(/至少需要 3/);
    expect(() =>
      fit([
        { plannedTimeSec: 100, actualTimeSec: 150 },
        { plannedTimeSec: 100, actualTimeSec: 160 },
        { plannedTimeSec: 100, actualTimeSec: 170 },
      ])
    ).toThrow(/不同的计划时长/);
    expect(() =>
      fromPair(
        { stats: { timeSec: 0 } } as unknown as ParsedGcodeResult,
        { actualTimeSec: 10 } as unknown as MachineLogResult
      )
    ).toThrow(/缺少有效/);
  });
});
