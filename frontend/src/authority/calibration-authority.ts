/* C# 校准训练权威接线：浏览器/离线保留本地预览，正式训练通过 sidecar。 */

import { createNodeRequestInit, detectRuntimeMode, resolveNodeApiBase } from "./runtime";
import { forgeXApiOperations, type CalibrationSample, type CalibrationTrainingRequest } from "../generated/forgex-api";

export type CalibrationAuthorityMode = "browser" | "shadow" | "dotnet";

export interface CalibrationTrainingAuthorityResponse {
  readonly schemaVersion: "1.0";
  readonly engine: { readonly name: "forgex-calibration-csharp"; readonly version: string };
  readonly training: Record<string, unknown>;
}

export class CalibrationAuthorityUnsupportedError extends Error {}

export function resolveCalibrationAuthorityMode(
  env: ImportMetaEnv,
  location: Pick<Location, "protocol"> = typeof window === "undefined" ? { protocol: "http:" } : window.location
): CalibrationAuthorityMode {
  if (detectRuntimeMode(location, env).kind === "offline") return "browser";
  const value = env.VITE_CALIBRATION_AUTHORITY?.trim().toLowerCase();
  return value === "shadow" || value === "dotnet" ? value : "browser";
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`C# calibration ${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`C# calibration ${label} is invalid`);
  return value as Record<string, unknown>;
}

export function buildCalibrationAuthorityRequest(
  samples: readonly CalibrationSample[],
  options: {
    readonly machineId: string;
    readonly firmware: string;
    readonly holdoutSamples?: readonly CalibrationSample[];
  }
): CalibrationTrainingRequest {
  if (samples.length < 3 || samples.length > 500) {
    throw new CalibrationAuthorityUnsupportedError("校准训练样本必须在 3 到 500 条之间");
  }
  if (!options.machineId.trim() || !options.firmware.trim()) {
    throw new CalibrationAuthorityUnsupportedError("校准训练必须指定 machineId 与 firmware");
  }
  return {
    schemaVersion: "1.0",
    scope: { machine_id: options.machineId.trim(), firmware: options.firmware.trim() },
    samples,
    ...(options.holdoutSamples?.length ? { holdout_samples: options.holdoutSamples } : {}),
  };
}

export function parseCalibrationAuthorityResponse(value: unknown): CalibrationTrainingAuthorityResponse {
  const root = record(value, "root");
  if (root.schemaVersion !== "1.0") throw new Error("C# calibration schemaVersion is invalid");
  const engine = record(root.engine, "engine");
  if (engine.name !== "forgex-calibration-csharp") throw new Error("C# calibration engine is invalid");
  if (typeof engine.version !== "string" || !engine.version.trim())
    throw new Error("C# calibration engine version is invalid");
  const training = record(root.training, "training");
  if (training.format !== "forgex-time-calibration" || training.method !== "theil-sen") {
    throw new Error("C# calibration training contract is invalid");
  }
  const coefficients = record(training.coefficients, "training.coefficients");
  finite(coefficients.motionScale, "training.coefficients.motionScale");
  finite(coefficients.fixedOverheadSec, "training.coefficients.fixedOverheadSec");
  return {
    schemaVersion: "1.0",
    engine: { name: "forgex-calibration-csharp", version: engine.version },
    training,
  };
}

export async function requestCalibrationAuthorityTraining(
  request: CalibrationTrainingRequest,
  env: ImportMetaEnv,
  signal?: AbortSignal
): Promise<CalibrationTrainingAuthorityResponse> {
  const base = resolveNodeApiBase(env);
  const response = await fetch(
    `${base}${forgeXApiOperations.trainCalibrationModel.path}`,
    createNodeRequestInit(env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    })
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`C# calibration authority HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  return parseCalibrationAuthorityResponse(await response.json());
}
