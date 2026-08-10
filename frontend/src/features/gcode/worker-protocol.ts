import type { GcodeWorkerResponse } from "./gcode-types";

export function isResponseForRequest(response: GcodeWorkerResponse, requestId: string): boolean {
  return response.requestId === requestId;
}

export function clampWorkerProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

export function toWorkerErrorMessage(error: unknown, fallback = "G-code 解析失败"): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
