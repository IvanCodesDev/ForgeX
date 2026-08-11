import { describe, expect, it } from "vitest";
import { parseMachineLog, reconcileMachineLog } from "./machine-log-model";
import type { GcodeReconciliationPlan } from "./machine-log-types";

const SHA = "a".repeat(64);

function plan(gcodeSha256 = SHA): GcodeReconciliationPlan {
  return {
    gcodeSha256,
    provenance: "browser-preview",
    engineVersion: "legacy-browser-preview",
    totalLayers: 2,
    estimatedTimeSec: 120,
    filamentMm: 300,
    filamentG: 0.9,
  };
}

function jsonLog(gcodeSha256: string | null = SHA): string {
  return JSON.stringify({
    format: "forgex-machine-log",
    version: 1,
    job: {
      jobId: "JOB-1",
      machineId: "FX-01",
      firmware: "Klipper 0.12",
      ...(gcodeSha256 === null ? {} : { gcodeSha256 }),
      durationSec: 120,
      filamentMm: 300,
      filamentG: 0.9,
      completedLayers: 2,
      status: "success",
    },
    telemetry: [{ timeSec: 0, nozzleC: 25, bedC: 25 }],
  });
}

describe("machine-log legacy adapter and strong binding", () => {
  it("parses the standard v1 JSON contract and preserves responsibility-chain fields", () => {
    const log = parseMachineLog(jsonLog(), "fixture.machine-log.json");

    expect(log).toMatchObject({
      name: "fixture.machine-log.json",
      jobId: "JOB-1",
      machineId: "FX-01",
      firmware: "Klipper 0.12",
      gcodeSha256: SHA,
      actualTimeSec: 120,
      filamentMm: 300,
      filamentG: 0.9,
      completedLayers: 2,
      status: "success",
    });
    expect(log.samples).toEqual([{ timeSec: 0, nozzleC: 25, bedC: 25 }]);
  });

  it("parses standard CSV and establishes strong binding when every row declares the same digest", () => {
    const csv = [
      "time_s,nozzle_c,bed_c,filament_mm,filament_g,completed_layers,status,gcode_sha256",
      `0,25,25,,,,running,${SHA}`,
      `120,210,60,300,0.9,2,success,${SHA}`,
    ].join("\n");
    const log = parseMachineLog(csv, "fixture.csv");

    expect(log).toMatchObject({
      name: "fixture.csv",
      format: "generic-machine-log-csv",
      actualTimeSec: 120,
      filamentMm: 300,
      filamentG: 0.9,
      completedLayers: 2,
      status: "success",
      gcodeSha256: SHA,
    });
    expect(log.samples).toHaveLength(2);
    expect(reconcileMachineLog(log, plan())).toMatchObject({
      binding: { status: "verified", verified: true },
    });
    expect(reconcileMachineLog(log, plan()).comparisons).toHaveLength(4);
  });

  it("keeps CSV without a digest visible but blocks reconciliation", () => {
    const log = parseMachineLog("time_s,status\n0,running\n120,success", "unbound.csv");

    expect(reconcileMachineLog(log, plan())).toMatchObject({
      binding: { status: "missing", verified: false },
      comparisons: [],
    });
  });

  it("rejects CSV whose rows declare conflicting G-code digests", () => {
    const csv = ["time_s,status,gcode_sha256", `0,running,${SHA}`, `1,success,${"b".repeat(64)}`].join("\n");

    expect(() => parseMachineLog(csv, "conflict.csv")).toThrow(/不一致/);
  });

  it.each([
    ["verified", SHA, SHA],
    ["missing", null, SHA],
    ["invalid", "not-a-sha", SHA],
    ["unavailable", SHA, ""],
    ["mismatch", "b".repeat(64), SHA],
  ] as const)("returns the %s binding state", (expectedStatus, declaredSha, actualSha) => {
    const log = parseMachineLog(jsonLog(declaredSha), "binding.json");
    const result = reconcileMachineLog(log, plan(actualSha));

    expect(result.binding.status).toBe(expectedStatus);
    expect(result.binding.verified).toBe(expectedStatus === "verified");
  });

  it("uses stable metric codes while retaining all legacy comparison values", () => {
    const log = parseMachineLog(jsonLog(), "verified.json");
    const result = reconcileMachineLog(log, plan());

    expect(result.binding.status).toBe("verified");
    expect(result.comparisons.map((entry) => entry.metric)).toEqual([
      "durationSec",
      "filamentMm",
      "filamentG",
      "completedLayers",
    ]);
    expect(result.comparisons.every((entry) => entry.agrees)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["mismatch", "b".repeat(64)],
  ] as const)("emits no comparisons for %s binding", (_status, declaredSha) => {
    const log = parseMachineLog(jsonLog(declaredSha), "unbound.json");

    expect(reconcileMachineLog(log, plan()).comparisons).toEqual([]);
  });
});
