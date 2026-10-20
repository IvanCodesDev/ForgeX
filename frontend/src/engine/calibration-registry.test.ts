/* 校准包注册、作用域匹配与漂移生命周期（Stage 7.4 前置：自 tests/calibration-registry.test.js
   迁入 vitest，改测 TS 引擎）。localStorage 以内存桩替代，覆盖 reload 的持久化恢复。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clear,
  estimate,
  importBundle,
  list,
  match,
  recordObservation,
  reload,
  validateBundle,
  type CalibrationBundle,
  type RegisteredModel,
} from "./calibration-registry.ts";
import type { DriftReport } from "./time-calibration.ts";
import exampleBundleRaw from "../../../contracts/calibration/example-bundle.json?raw";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

type LooseBundle = CalibrationBundle & Record<string, unknown>;

function activeBundle(overrides?: Record<string, unknown>): LooseBundle {
  const bundle = {
    format: "forgex-calibration-bundle",
    version: 1,
    id: "factory-calibration",
    revision: 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized paired production observations collected with authorization.",
    },
    models: [
      {
        id: "fx01-klipper-pla",
        status: "active",
        scope: { machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-27T00:00:00Z",
        coefficients: { motionScale: 1.2, fixedOverheadSec: 90, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.18,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "a".repeat(64),
      },
    ],
  };
  return Object.assign(bundle, overrides || {}) as unknown as LooseBundle;
}
const firstModel = (bundle: LooseBundle) => bundle.models[0] as unknown as Record<string, Record<string, unknown>>;

// setup.ts 在每个用例后 unstubAllGlobals，因此每个用例前重新挂同一个内存桩（内容跨用例保留）
const storage = memoryStorage();
beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
});
beforeAll(() => {
  vi.stubGlobal("localStorage", storage);
  clear();
});
afterAll(() => {
  vi.stubGlobal("localStorage", storage);
  clear();
});

describe("示例与安全边界", () => {
  it("仓库示例通过运行时白名单；demonstration 模型可登记但默认不参与自动匹配", () => {
    const example = JSON.parse(exampleBundleRaw) as CalibrationBundle;
    const exampleCheck = validateBundle(example);
    expect(exampleCheck.ok, exampleCheck.errors.join("|")).toBe(true);
    importBundle(example);
    expect(list()).toHaveLength(1);
    const ctx = { machineId: "FX-VALIDATION-01", firmware: "mixed compatibility fixture" };
    expect(match(ctx)).toBeNull();
    expect(match(ctx, { includeDemonstration: true })?.status).toBe("demonstration-only");
  });
});

describe("active 准入门槛", () => {
  it("合成数据 / holdout 不足 / MAPE 超阈值 / 未知字段 都不能启用 active", () => {
    expect(validateBundle(activeBundle({ provenance: "synthetic-conformance" })).ok).toBe(false);

    let invalid = activeBundle();
    firstModel(invalid).validation!.holdoutSamples = 4;
    expect(validateBundle(invalid).ok).toBe(false);

    invalid = activeBundle();
    firstModel(invalid).validation!.mape = 0.25;
    expect(validateBundle(invalid).ok).toBe(false);

    invalid = activeBundle();
    (firstModel(invalid) as Record<string, unknown>).onload = "alert(1)";
    expect(validateBundle(invalid).ok).toBe(false);
  });
});

describe("作用域、版本和持久化", () => {
  it("真实 active bundle 导入成功；机型/固件/材料大小写无关地完全匹配，其它不误用", () => {
    clear();
    const imported = importBundle(activeBundle());
    expect(imported.models[0]).toBe("fx01-klipper-pla");
    expect(match({ machineId: "fx-01", firmware: "klipper 0.12", material: "pla" })?.id).toBe("fx01-klipper-pla");
    expect(match({ machineId: "FX-01", firmware: "Marlin 2.1", material: "PLA" })).toBeNull();
    expect(match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PETG" })).toBeNull();
  });

  it("同 revision 不允许覆盖；更高 revision 原子替换；刷新后从 localStorage 恢复", () => {
    expect(() => importBundle(activeBundle())).toThrow(/revision/);
    const revision2 = activeBundle({ revision: 2 });
    firstModel(revision2).coefficients!.motionScale = 1.3;
    importBundle(revision2);
    expect(list()).toHaveLength(1);
    expect(list()[0]!.coefficients.motionScale).toBe(1.3);
    reload();
    expect(list()).toHaveLength(1);
    expect(list()[0]!.bundleRevision).toBe(2);
  });
});

describe("区间估算与漂移", () => {
  let model: RegisteredModel;
  it("校准估算应用固定开销与倍率并携带 holdout 不确定区间", () => {
    model = match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" })!;
    const est = estimate(model, 100);
    expect(est.predictedTimeSec).toBe(220);
    expect(est.lowerTimeSec).toBeLessThan(220);
    expect(est.upperTimeSec).toBeGreaterThan(220);
  });

  it("少量观测 insufficient → 五个吻合观测 stable → 重复任务不重复计数", () => {
    let drift: DriftReport | null = null;
    for (let i = 0; i < 4; i++) {
      drift = recordObservation(model, {
        id: `stable-${i}`,
        plannedTimeSec: 100 + i * 10,
        actualTimeSec: 90 + 1.3 * (100 + i * 10),
      });
    }
    expect(drift).toMatchObject({ status: "insufficient", sampleCount: 4 });
    const fifth = { id: "stable-5", plannedTimeSec: 150, actualTimeSec: 90 + 1.3 * 150 };
    expect(recordObservation(model, fifth).status).toBe("stable");
    expect(recordObservation(model, fifth).sampleCount).toBe(5);
  });

  it("持续偏差触发 drift（含中位偏差与 P90），已漂移的 active 模型停止自动匹配", () => {
    let drift: DriftReport | null = null;
    for (let i = 0; i < 8; i++) {
      drift = recordObservation(model, {
        id: `drift-${i}`,
        plannedTimeSec: 200 + i * 10,
        actualTimeSec: (90 + 1.3 * (200 + i * 10)) * 1.5,
      });
    }
    expect(drift!.status).toBe("drift");
    expect(drift!.medianBias).not.toBeNull();
    expect(drift!.p90Ape).not.toBeNull();
    expect(match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" })).toBeNull();
  });
});
