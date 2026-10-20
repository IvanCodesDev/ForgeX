import { afterEach, describe, expect, it, vi } from "vitest";
import type { GCodeCostEstimate, GCodeCostInputs } from "../generated/forgex-api";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import { COST_LIMITS, normalizeCostInputs, requestCostEstimate, validateCostEstimate } from "./gcode-cost";

const id = "a".repeat(32);
const source = {
  input: { sha256: "b".repeat(64) },
  profile: { fingerprint: "c".repeat(64) },
  engine: { version: "1.4.0" },
  summary: { estimatedTimeSeconds: 3600, filamentMassG: 100 },
} as unknown as AuthorityAnalysisResponse;
const inputs: GCodeCostInputs = {
  averagePowerWatts: 200,
  electricityCnyPerKwh: 1,
  machineCnyPerHour: 5,
  materialCnyPerKg: 100,
  evidence: "测量与费率记录",
};
const env: ImportMetaEnv = {
  BASE_URL: "/",
  MODE: "test",
  DEV: true,
  PROD: false,
  SSR: false,
  VITE_API_BASE: "",
  VITE_NODE_API_KEY: "cost-key",
};
const fixture = (): GCodeCostEstimate => ({
  schemaVersion: "1.0",
  modelVersion: "forgex-gcode-cost/2",
  currency: "CNY",
  fingerprint: "f".repeat(64),
  basis: {
    jobId: id,
    inputSha256: source.input.sha256,
    profileFingerprint: source.profile.fingerprint,
    analysisEngineVersion: "1.4.0",
    durationSeconds: 3600,
    filamentMassG: 100,
  },
  inputs: { ...inputs },
  totals: {
    isComplete: true,
    energyKwh: 0.2,
    materialCostCny: 10,
    electricityCostCny: 0.2,
    machineTimeCostCny: 5,
    totalCostCny: 15.2,
  },
  missingInputs: [],
  warnings: ["不是电表实测"],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("G-code declared cost boundary", () => {
  it("validates bound time/mass, all inputs and itemized arithmetic", () => {
    expect(validateCostEstimate(fixture(), id, source, inputs).totals.totalCostCny).toBe(15.2);
  });
  it("accepts unknown values only with null results and no total", () => {
    const empty: GCodeCostInputs = {
      averagePowerWatts: null,
      electricityCnyPerKwh: null,
      machineCnyPerHour: null,
      materialCnyPerKg: null,
      evidence: "",
    };
    const response = {
      ...fixture(),
      inputs: empty,
      missingInputs: Object.keys(COST_LIMITS),
      totals: {
        isComplete: false,
        energyKwh: null,
        materialCostCny: null,
        electricityCostCny: null,
        machineTimeCostCny: null,
        totalCostCny: null,
      },
    };
    expect(validateCostEstimate(response, id, source, empty).totals.totalCostCny).toBeNull();
    expect(() =>
      validateCostEstimate({ ...response, totals: { ...response.totals, totalCostCny: 0 } }, id, source, empty)
    ).toThrow();
  });
  it("accepts explicit zero as a complete declared scenario", () => {
    const zero = {
      averagePowerWatts: 0,
      electricityCnyPerKwh: 0,
      machineCnyPerHour: 0,
      materialCnyPerKg: 0,
      evidence: "明确不计费",
    };
    const response = {
      ...fixture(),
      inputs: zero,
      totals: {
        isComplete: true,
        energyKwh: 0,
        materialCostCny: 0,
        electricityCostCny: 0,
        machineTimeCostCny: 0,
        totalCostCny: 0,
      },
    };
    expect(validateCostEstimate(response, id, source, zero).totals.isComplete).toBe(true);
  });
  it.each<readonly [string, object]>([
    ["old model", { modelVersion: "forgex-gcode-cost/1" }],
    ["currency", { currency: "USD" }],
    ["hash", { fingerprint: "bad" }],
    ...(
      [
        "jobId",
        "inputSha256",
        "profileFingerprint",
        "analysisEngineVersion",
        "durationSeconds",
        "filamentMassG",
      ] as const
    ).map(
      (key) =>
        [key, { basis: { ...fixture().basis, [key]: typeof fixture().basis[key] === "number" ? 1 : "wrong" } }] as const
    ),
    ...(["energyKwh", "materialCostCny", "electricityCostCny", "machineTimeCostCny", "totalCostCny"] as const).map(
      (key) => [key, { totals: { ...fixture().totals, [key]: 1 } }] as const
    ),
    ["input", { inputs: { ...inputs, averagePowerWatts: 201 } }],
    ["evidence", { inputs: { ...inputs, evidence: "其他来源" } }],
    ["missing", { missingInputs: ["averagePowerWatts"] }],
    ["complete", { totals: { ...fixture().totals, isComplete: false } }],
    ["warnings", { warnings: [1] }],
  ])("rejects response drift: %s", (_name, patch) => {
    expect(() => validateCostEstimate({ ...fixture(), ...(patch as object) }, id, source, inputs)).toThrow();
  });
  it("normalizes evidence and rejects invalid/range/nonfinite values", () => {
    expect(normalizeCostInputs({ ...inputs, evidence: " a\r\nb " }).evidence).toBe("a\nb");
    for (const [key, maximum] of Object.entries(COST_LIMITS)) {
      for (const value of [-1, maximum + 1, NaN, Infinity])
        expect(() => normalizeCostInputs({ ...inputs, [key]: value })).toThrow();
    }
    for (const evidence of ["", " ", "x\0", "x".repeat(501)])
      expect(() => normalizeCostInputs({ ...inputs, evidence })).toThrow();
  });
  it("rejects nonfinite or out-of-range source values even when the source binding matches", () => {
    for (const duration of [Infinity, NaN, -1, 31536001]) {
      const changedSource = { ...source, summary: { ...source.summary, estimatedTimeSeconds: duration } };
      expect(() =>
        validateCostEstimate(
          { ...fixture(), basis: { ...fixture().basis, durationSeconds: duration } },
          id,
          changedSource,
          inputs
        )
      ).toThrow(/来源/);
    }
  });
  it("posts only declared fields with public credentials to the generated owned-job path", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(fixture()));
    vi.stubGlobal("fetch", fetcher);
    await requestCostEstimate(id, source, inputs, env, new AbortController().signal);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/gcode/analyses/${id}/cost-estimates`);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual(inputs);
    expect(new Headers(init.headers).get("X-API-Key")).toBe("cost-key");
    expect(new Headers(init.headers).has("X-ForgeX-Internal-Token")).toBe(false);
  });
  it("stays offline and rejects invalid/pre-aborted requests before sending", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestCostEstimate(id, source, inputs, { ...env, VITE_API_BASE: "offline" }, new AbortController().signal)
    ).rejects.toThrow(/离线/);
    await expect(requestCostEstimate("bad", source, inputs, env, new AbortController().signal)).rejects.toThrow(/作业/);
    const controller = new AbortController();
    controller.abort();
    await expect(requestCostEstimate(id, source, inputs, env, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps structured backend errors visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ title: "仅已成功完成的作业可估算" }, { status: 409 }))
    );
    await expect(requestCostEstimate(id, source, inputs, env, new AbortController().signal)).rejects.toThrow(
      /409.*成功完成/
    );
  });
  it("honors cancellation and bounds a stalled request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
          )
      )
    );
    const controller = new AbortController();
    const request = requestCostEstimate(id, source, inputs, env, controller.signal);
    const rejected = expect(request).rejects.toThrow(/changed/);
    controller.abort(new Error("inputs changed"));
    await rejected;
    const timeout = requestCostEstimate(id, source, inputs, env, new AbortController().signal);
    const timedOut = expect(timeout).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(15000);
    await timedOut;
  });
});
