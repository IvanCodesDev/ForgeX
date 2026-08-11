/// <reference lib="webworker" />

import { assertQuickSimulationInput, QuickSimulationInputError } from "../features/simulator/simulator-schema";
import type { SimulatorWorkerRequest, SimulatorWorkerResponse } from "../features/simulator/simulator-types";
import { legacyQuickSimulator } from "../legacy/simulator-adapter.js";

const cancelled = new Set<string>();

function send(message: SimulatorWorkerResponse): void {
  self.postMessage(message);
}

function progress(jobId: string, phase: "validate" | "simulate" | "pack", value: number, stage: string): void {
  send({ type: "progress", jobId, phase, progress: value, stage });
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason || "快速仿真失败");
}

function simulate(request: Extract<SimulatorWorkerRequest, { readonly type: "simulate" }>): void {
  try {
    progress(request.jobId, "validate", 0.08, "校验模型、Profile 与工艺参数");
    const input = assertQuickSimulationInput(request.input);
    if (cancelled.delete(request.jobId)) {
      send({ type: "cancelled", jobId: request.jobId });
      return;
    }

    progress(request.jobId, "simulate", 0.34, "生成逐层路径并计算工艺摘要");
    const result = legacyQuickSimulator.simulate(input);
    if (cancelled.delete(request.jobId)) {
      send({ type: "cancelled", jobId: request.jobId });
      return;
    }

    progress(request.jobId, "pack", 0.94, "封装轻量审计结果");
    send({ type: "result", jobId: request.jobId, result });
  } catch (reason) {
    send({
      type: "error",
      jobId: request.jobId,
      code: reason instanceof QuickSimulationInputError ? "INVALID_INPUT" : "SIMULATION_FAILED",
      message: messageOf(reason),
    });
  }
}

self.onmessage = (event: MessageEvent<SimulatorWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.jobId);
    return;
  }
  simulate(request);
};
