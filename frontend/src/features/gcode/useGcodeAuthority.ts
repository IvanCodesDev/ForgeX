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
import {
  cancelAuthorityJob,
  requestAuthorityJobAnalysis,
  resolveAuthorityJobApi,
  type AuthorityJobTransport,
} from "./gcode-job-client";

interface AuthorityState {
  readonly mode: GcodeAuthorityMode;
  readonly status: GcodeAuthorityStatus;
  readonly result: AuthorityAnalysisResponse | null;
  readonly error: string;
  readonly jobId: string | null;
  readonly progress: number;
  readonly phase: string;
  readonly transport: AuthorityJobTransport | "sync";
}

export const AUTHORITY_TIMEOUT_MS = 120_000;

export function useGcodeAuthority(
  file: File | null,
  options: GcodeParseOptions,
  preview: GcodePreviewResult | null,
  timeoutMs = AUTHORITY_TIMEOUT_MS
) {
  const mode = useMemo(() => resolveAuthorityMode(import.meta.env), []);
  const initialState = useMemo<AuthorityState>(
    () => ({
      mode,
      status: "idle",
      result: null,
      error: "",
      jobId: null,
      progress: 0,
      phase: "idle",
      transport: "sync",
    }),
    [mode]
  );
  const [state, setState] = useState<AuthorityState>(initialState);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const jobIdRef = useRef<string | null>(null);

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
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    controller.abort();
    controllerRef.current = null;
    clearTimer();
    if (jobId) void cancelAuthorityJob(jobId, import.meta.env).catch(() => undefined);
    setState({
      ...initialState,
      status: "error",
      error: "C# 权威分析已取消，权威结果未完成",
      jobId,
      phase: "cancelled",
    });
  }, [clearTimer, initialState]);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    jobIdRef.current = null;
    clearTimer();

    if (mode === "browser" || !file) {
      setState(initialState);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const useAsyncJob = resolveAuthorityJobApi(mode, import.meta.env);
    let acceptedJobId: string | null = null;
    let completed = false;
    setState({ ...initialState, status: "running", phase: useAsyncJob ? "create" : "analyze" });
    timerRef.current = setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      requestIdRef.current += 1;
      controller.abort();
      const jobId = jobIdRef.current;
      jobIdRef.current = null;
      if (jobId) void cancelAuthorityJob(jobId, import.meta.env).catch(() => undefined);
      controllerRef.current = null;
      timerRef.current = null;
      setState({
        ...initialState,
        status: "error",
        error: `C# 权威分析超过 ${Math.ceil(timeoutMs / 1000)} 秒，权威结果未完成`,
        jobId,
        phase: "timeout",
      });
    }, timeoutMs);

    const request = useAsyncJob
      ? requestAuthorityJobAnalysis(file, options, import.meta.env, controller.signal, {
          onAccepted(jobId) {
            if (controller.signal.aborted || requestIdRef.current !== requestId) return;
            acceptedJobId = jobId;
            jobIdRef.current = jobId;
            setState((current) => ({ ...current, jobId, phase: "queued", progress: 0, transport: "sse" }));
          },
          onProgress(update) {
            if (controller.signal.aborted || requestIdRef.current !== requestId) return;
            setState((current) => ({
              ...current,
              jobId: update.jobId,
              progress: update.progress,
              phase: update.phase,
              transport: update.transport,
            }));
          },
        })
      : requestAuthorityAnalysis(file, options, import.meta.env, controller.signal);

    void request
      .then((result) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        completed = true;
        controllerRef.current = null;
        jobIdRef.current = null;
        clearTimer();
        setState((current) => ({ ...current, status: "done", result, error: "", progress: 1, phase: "succeeded" }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        controllerRef.current = null;
        jobIdRef.current = null;
        clearTimer();
        setState((current) => ({
          ...current,
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : "C# 权威分析失败",
          phase: "failed",
        }));
      });

    return () => {
      controller.abort();
      if (!completed && acceptedJobId) void cancelAuthorityJob(acceptedJobId, import.meta.env).catch(() => undefined);
      if (controllerRef.current === controller) controllerRef.current = null;
      if (jobIdRef.current === acceptedJobId) jobIdRef.current = null;
      clearTimer();
    };
  }, [clearTimer, file, initialState, mode, options, timeoutMs]);

  const diff: AuthorityDiff | null = preview && state.result ? compareAuthority(preview, state.result, options) : null;
  return { ...state, diff, cancel };
}
