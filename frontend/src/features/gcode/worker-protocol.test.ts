import { describe, expect, it } from "vitest";
import type { GcodeWorkerResponse } from "./gcode-types";
import { clampWorkerProgress, isResponseForRequest, toWorkerErrorMessage } from "./worker-protocol";

describe("worker protocol helpers", () => {
  it("filters stale responses by request id", () => {
    const response: GcodeWorkerResponse = {
      type: "progress",
      requestId: "active",
      phase: "parse",
      progress: 0.5,
      stage: "parse",
    };
    expect(isResponseForRequest(response, "active")).toBe(true);
    expect(isResponseForRequest(response, "stale")).toBe(false);
  });

  it.each([
    [-1, 0],
    [0.25, 0.25],
    [2, 1],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("clamps progress %s to %s", (input, expected) => {
    expect(clampWorkerProgress(input)).toBe(expected);
  });

  it("maps Error values and hides unknown thrown values behind a stable fallback", () => {
    expect(toWorkerErrorMessage(new Error("bad command"))).toBe("bad command");
    expect(toWorkerErrorMessage({ message: "untrusted shape" })).toBe("G-code 解析失败");
    expect(toWorkerErrorMessage("raw failure", "解析异常")).toBe("解析异常");
    expect(toWorkerErrorMessage(new Error("   "))).toBe("G-code 解析失败");
  });
});
