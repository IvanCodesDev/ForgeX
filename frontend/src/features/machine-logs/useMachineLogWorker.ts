import { useCallback, useEffect, useRef, useState } from "react";
import MachineLogWorker from "../../workers/machine-log.worker?worker&inline";
import { MACHINE_LOG_MAX_BYTES } from "./machine-log-limits";
import type {
  GcodeReconciliationPlan,
  MachineLogImportResult,
  MachineLogWorkerRequest,
  MachineLogWorkerResponse,
} from "./machine-log-types";

export type MachineLogWorkerStatus = "idle" | "reading" | "parsing" | "done" | "error" | "cancelled";

export interface MachineLogWorkerState {
  readonly status: MachineLogWorkerStatus;
  readonly progress: number;
  readonly stage: string;
  readonly result: MachineLogImportResult | null;
  readonly error: string;
  readonly errorCode: string;
}

const INITIAL_STATE: MachineLogWorkerState = {
  status: "idle",
  progress: 0,
  stage: "等待真机日志",
  result: null,
  error: "",
  errorCode: "",
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function useMachineLogWorker(gcodeRevision: number | string) {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef("");
  const previousRevisionRef = useRef(gcodeRevision);
  const [state, setState] = useState<MachineLogWorkerState>(INITIAL_STATE);

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    requestRef.current = "";
    setState((current) =>
      current.status === "idle"
        ? current
        : {
            status: "cancelled",
            progress: 0,
            stage: "日志解析已取消",
            result: null,
            error: "",
            errorCode: "",
          }
    );
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    requestRef.current = "";
    setState(INITIAL_STATE);
  }, []);

  const parseFile = useCallback((file: File, plan: GcodeReconciliationPlan) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    requestRef.current = "";

    if (!/\.(json|csv)$/i.test(file.name)) {
      setState({
        status: "error",
        progress: 0,
        stage: "文件校验失败",
        result: null,
        error: "真机日志仅支持 JSON / CSV",
        errorCode: "INVALID_EXTENSION",
      });
      return;
    }
    if (file.size > MACHINE_LOG_MAX_BYTES) {
      setState({
        status: "error",
        progress: 0,
        stage: "文件校验失败",
        result: null,
        error: `真机日志超过 ${Math.round(MACHINE_LOG_MAX_BYTES / 1024 / 1024)}MB 上限`,
        errorCode: "FILE_TOO_LARGE",
      });
      return;
    }

    const requestId =
      globalThis.crypto?.randomUUID?.() ?? `machine-log-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestRef.current = requestId;
    setState({
      status: "reading",
      progress: 0.04,
      stage: "读取真机日志",
      result: null,
      error: "",
      errorCode: "",
    });

    try {
      const worker = new MachineLogWorker();
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<MachineLogWorkerResponse>) => {
        const message = event.data;
        if (message.requestId !== requestRef.current) return;
        if (message.type === "progress") {
          setState({
            status: message.phase === "read" ? "reading" : "parsing",
            progress: clampProgress(message.progress),
            stage: message.stage,
            result: null,
            error: "",
            errorCode: "",
          });
          return;
        }

        worker.terminate();
        workerRef.current = null;
        requestRef.current = "";
        if (message.type === "result") {
          setState({
            status: "done",
            progress: 1,
            stage: "日志解析完成",
            result: message.result,
            error: "",
            errorCode: "",
          });
        } else {
          setState({
            status: "error",
            progress: 0,
            stage: "日志解析失败",
            result: null,
            error: message.message,
            errorCode: message.code,
          });
        }
      };
      worker.onerror = (event) => {
        if (worker !== workerRef.current) return;
        worker.terminate();
        workerRef.current = null;
        requestRef.current = "";
        setState({
          status: "error",
          progress: 0,
          stage: "Worker 异常",
          result: null,
          error: event.message || "真机日志 Worker 异常",
          errorCode: "WORKER_CRASH",
        });
      };
      const request: MachineLogWorkerRequest = { type: "parse", requestId, file, plan };
      worker.postMessage(request);
    } catch (error) {
      workerRef.current = null;
      requestRef.current = "";
      setState({
        status: "error",
        progress: 0,
        stage: "Worker 启动失败",
        result: null,
        error: error instanceof Error ? error.message : "真机日志 Worker 启动失败",
        errorCode: "WORKER_START_FAILED",
      });
    }
  }, []);

  useEffect(() => {
    if (previousRevisionRef.current === gcodeRevision) return;
    previousRevisionRef.current = gcodeRevision;
    reset();
  }, [gcodeRevision, reset]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  return { state, parseFile, cancel, reset } as const;
}
