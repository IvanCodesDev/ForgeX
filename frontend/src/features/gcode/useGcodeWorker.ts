import { useCallback, useEffect, useRef, useState } from "react";
import GcodeWorker from "../../workers/gcode.worker?worker&inline";
import type { GcodeParseOptions, GcodePreviewResult, GcodeWorkerRequest, GcodeWorkerResponse } from "./gcode-types";
import { clampWorkerProgress, isResponseForRequest } from "./worker-protocol";

const MAX_BYTES = 64 * 1024 * 1024;
const WORKER_LIMITS = {
  chunkBytes: 1024 * 1024,
  maxPreviewSegments: 400_000,
  maxPointsPerPath: 256,
} as const;

export type WorkerStatus = "idle" | "reading" | "parsing" | "done" | "error" | "cancelled";

export interface GcodeWorkerState {
  readonly status: WorkerStatus;
  readonly progress: number;
  readonly stage: string;
  readonly result: GcodePreviewResult | null;
  readonly error: string;
  readonly errorCode: string;
}

const INITIAL_STATE: GcodeWorkerState = {
  status: "idle",
  progress: 0,
  stage: "等待文件",
  result: null,
  error: "",
  errorCode: "",
};

export function useGcodeWorker() {
  const workerRef = useRef<Worker | null>(null);
  const requestRef = useRef("");
  const [state, setState] = useState<GcodeWorkerState>(INITIAL_STATE);

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
            stage: "解析已取消",
            result: null,
            error: "",
            errorCode: "",
          }
    );
  }, []);

  const parseFile = useCallback(
    async (file: File, options: GcodeParseOptions) => {
      cancel();
      if (!/\.(gcode|gco|gc)$/i.test(file.name)) {
        setState({
          status: "error",
          progress: 0,
          stage: "文件校验失败",
          result: null,
          error: "请选择 .gcode / .gco / .gc 文件",
          errorCode: "INVALID_EXTENSION",
        });
        return;
      }
      if (file.size > MAX_BYTES) {
        setState({
          status: "error",
          progress: 0,
          stage: "文件校验失败",
          result: null,
          error: "G-code 超过 64 MB 上限",
          errorCode: "FILE_TOO_LARGE",
        });
        return;
      }

      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `gcode-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      requestRef.current = requestId;
      setState({
        status: "reading",
        progress: 0.04,
        stage: "读取文件字节",
        result: null,
        error: "",
        errorCode: "",
      });
      try {
        const worker = new GcodeWorker();
        workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<GcodeWorkerResponse>) => {
          const message = event.data;
          if (!isResponseForRequest(message, requestRef.current)) return;
          if (message.type === "progress") {
            setState({
              status: "parsing",
              progress: clampWorkerProgress(message.progress),
              stage: message.stage,
              result: null,
              error: "",
              errorCode: "",
            });
          } else if (message.type === "result") {
            worker.terminate();
            workerRef.current = null;
            requestRef.current = "";
            setState({
              status: "done",
              progress: 1,
              stage: "解析完成",
              result: message.result,
              error: "",
              errorCode: "",
            });
          } else {
            worker.terminate();
            workerRef.current = null;
            requestRef.current = "";
            setState({
              status: "error",
              progress: 0,
              stage: "解析失败",
              result: null,
              error: message.message,
              errorCode: message.code,
            });
          }
        };
        worker.onerror = (event) => {
          worker.terminate();
          workerRef.current = null;
          requestRef.current = "";
          setState({
            status: "error",
            progress: 0,
            stage: "Worker 异常",
            result: null,
            error: event.message || "G-code Worker 异常",
            errorCode: "WORKER_CRASH",
          });
        };
        const request: GcodeWorkerRequest = { type: "parse", requestId, file, options, limits: WORKER_LIMITS };
        worker.postMessage(request);
      } catch (error) {
        setState({
          status: "error",
          progress: 0,
          stage: "文件读取失败",
          result: null,
          error: error instanceof Error ? error.message : "文件读取失败",
          errorCode: "WORKER_START_FAILED",
        });
      }
    },
    [cancel]
  );

  const reset = useCallback(() => {
    cancel();
    setState(INITIAL_STATE);
  }, [cancel]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  return { state, parseFile, cancel, reset } as const;
}
