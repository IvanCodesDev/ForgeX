import { useCallback, useEffect, useRef, useState } from "react";
import SimulatorWorker from "../../workers/simulator.worker?worker&inline";
import { validateQuickSimulationInput } from "./simulator-schema";
import type {
  QuickSimulationController,
  QuickSimulationInput,
  QuickSimulationState,
  SimulatorWorkerRequest,
  SimulatorWorkerResponse,
} from "./simulator-types";

const INITIAL_STATE: QuickSimulationState = {
  status: "idle",
  jobId: "",
  progress: 0,
  stage: "等待参数",
  result: null,
  error: "",
  errorCode: "",
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function nextJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sim-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useQuickSimulation(): QuickSimulationController {
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef("");
  const [state, setState] = useState<QuickSimulationState>(INITIAL_STATE);

  const stopWorker = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    jobRef.current = "";
  }, []);

  const cancel = useCallback(() => {
    const activeJob = jobRef.current;
    if (activeJob)
      workerRef.current?.postMessage({ type: "cancel", jobId: activeJob } satisfies SimulatorWorkerRequest);
    stopWorker();
    setState((current) =>
      current.status === "idle"
        ? current
        : {
            ...current,
            status: "cancelled",
            jobId: "",
            progress: 0,
            stage: "即时预览已取消",
            error: "",
            errorCode: "",
          }
    );
  }, [stopWorker]);

  const run = useCallback(
    (input: QuickSimulationInput) => {
      stopWorker();
      const validation = validateQuickSimulationInput(input);
      if (!validation.ok) {
        setState((current) => ({
          ...current,
          status: "error",
          jobId: "",
          progress: 0,
          stage: "参数校验失败",
          error: validation.errors.join("；"),
          errorCode: "INVALID_INPUT",
        }));
        return;
      }

      const jobId = nextJobId();
      jobRef.current = jobId;
      setState((current) => ({
        status: "running",
        jobId,
        progress: 0.03,
        stage: "启动隔离 Worker",
        result: current.result,
        error: "",
        errorCode: "",
      }));

      try {
        const worker = new SimulatorWorker();
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<SimulatorWorkerResponse>) => {
          const response = event.data;
          if (response.jobId !== jobRef.current || worker !== workerRef.current) return;
          if (response.type === "progress") {
            setState((current) => ({
              ...current,
              status: "running",
              progress: clampProgress(response.progress),
              stage: response.stage,
            }));
            return;
          }

          stopWorker();
          if (response.type === "result") {
            setState({
              status: "success",
              jobId: "",
              progress: 1,
              stage: "即时预览完成",
              result: response.result,
              error: "",
              errorCode: "",
            });
          } else if (response.type === "cancelled") {
            setState((current) => ({
              ...current,
              status: "cancelled",
              jobId: "",
              progress: 0,
              stage: "即时预览已取消",
            }));
          } else if (response.type !== "stale") {
            setState((current) => ({
              ...current,
              status: "error",
              jobId: "",
              progress: 0,
              stage: "即时预览失败",
              error: response.message,
              errorCode: response.code,
            }));
          }
        };
        worker.onerror = (event) => {
          if (worker !== workerRef.current) return;
          stopWorker();
          setState((current) => ({
            ...current,
            status: "error",
            jobId: "",
            progress: 0,
            stage: "Worker 异常",
            error: event.message || "快速仿真 Worker 异常",
            errorCode: "WORKER_CRASH",
          }));
        };
        worker.postMessage({ type: "simulate", jobId, input: validation.value } satisfies SimulatorWorkerRequest);
      } catch (reason) {
        stopWorker();
        setState((current) => ({
          ...current,
          status: "error",
          jobId: "",
          progress: 0,
          stage: "Worker 启动失败",
          error: reason instanceof Error ? reason.message : "快速仿真 Worker 启动失败",
          errorCode: "WORKER_CRASH",
        }));
      }
    },
    [stopWorker]
  );

  const markStale = useCallback(() => {
    setState((current) =>
      current.result ? { ...current, status: "stale", stage: "参数已变化，当前结果为上次预览" } : current
    );
  }, []);

  const reset = useCallback(() => {
    stopWorker();
    setState(INITIAL_STATE);
  }, [stopWorker]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  return { state, run, cancel, markStale, reset };
}
