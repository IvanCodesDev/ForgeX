import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GcodeParseOptions, GcodePreviewResult } from "./gcode-types";
import {
  compareAuthority,
  requestAuthorityAnalysis,
  resolveAuthorityMode,
  type AuthorityAnalysisResponse,
  type AuthorityDiff,
  type GcodeAuthorityMode,
  type GcodeAuthorityStatus,
} from "./gcode-authority";

interface AuthorityState {
  readonly mode: GcodeAuthorityMode;
  readonly status: GcodeAuthorityStatus;
  readonly result: AuthorityAnalysisResponse | null;
  readonly error: string;
}

export const AUTHORITY_TIMEOUT_MS = 120_000;

export function useGcodeAuthority(
  file: File | null,
  options: GcodeParseOptions,
  preview: GcodePreviewResult | null,
  timeoutMs = AUTHORITY_TIMEOUT_MS
) {
  const mode = useMemo(() => resolveAuthorityMode(import.meta.env), []);
  const [state, setState] = useState<AuthorityState>({ mode, status: "idle", result: null, error: "" });
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    requestIdRef.current += 1;
    controller.abort();
    controllerRef.current = null;
    clearTimer();
    setState({ mode, status: "error", result: null, error: "C# 权威分析已取消，权威结果未完成" });
  }, [clearTimer, mode]);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    clearTimer();

    if (mode === "browser" || !file) {
      setState({ mode, status: "idle", result: null, error: "" });
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ mode, status: "running", result: null, error: "" });
    timerRef.current = setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      requestIdRef.current += 1;
      controller.abort();
      controllerRef.current = null;
      timerRef.current = null;
      setState({
        mode,
        status: "error",
        result: null,
        error: `C# 权威分析超过 ${Math.ceil(timeoutMs / 1000)} 秒，权威结果未完成`,
      });
    }, timeoutMs);

    void requestAuthorityAnalysis(file, options, import.meta.env, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        controllerRef.current = null;
        clearTimer();
        setState({ mode, status: "done", result, error: "" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        controllerRef.current = null;
        clearTimer();
        setState({
          mode,
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : "C# 权威分析失败",
        });
      });

    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      clearTimer();
    };
  }, [clearTimer, file, mode, options, timeoutMs]);

  const diff: AuthorityDiff | null = preview && state.result ? compareAuthority(preview, state.result, options) : null;
  return { ...state, diff, cancel };
}
