import { createNodeRequestInit, resolveNodeApiBase } from "../../app/api/api-adapter";
import {
  forgeXApiOperations,
  forgeXApiPath,
  type GCodeJobAcceptedResponse,
  type GCodeJobSnapshotResponse,
} from "../../generated/forgex-api";
import {
  assertAuthorityContract,
  buildGcodeAuthorityQuery,
  parseAuthorityResponse,
  type AuthorityAnalysisResponse,
} from "./gcode-authority";
import type { GcodeParseOptions } from "./gcode-types";

export type AuthorityJobStatus = GCodeJobAcceptedResponse["status"];
export type AuthorityJobTransport = "sse" | "poll";

export interface AuthorityJobProgress {
  readonly jobId: string;
  readonly status: AuthorityJobStatus;
  readonly progress: number;
  readonly phase: string;
  readonly sequence: number;
  readonly transport: AuthorityJobTransport;
}

export interface AuthorityJobCallbacks {
  readonly onAccepted?: (jobId: string) => void;
  readonly onProgress?: (progress: AuthorityJobProgress) => void;
}

export interface AuthorityJobClientOptions {
  readonly reconnectAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly creationRetryDelayMs?: number;
}

type AcceptedJob = GCodeJobAcceptedResponse;

type JobSnapshot = Pick<GCodeJobSnapshotResponse, "id" | "status" | "progress" | "phase" | "sequence" | "error"> & {
  readonly result: unknown;
};

const TERMINAL = new Set<AuthorityJobStatus>(["succeeded", "degraded", "failed", "cancelled"]);
const STATUS = new Set<AuthorityJobStatus>(["queued", "running", "succeeded", "degraded", "failed", "cancelled"]);
let fallbackKeySequence = 0;

class AuthorityHttpError extends Error {}

export function resolveAuthorityJobApi(mode: "browser" | "shadow" | "dotnet", env: ImportMetaEnv): boolean {
  return mode === "dotnet" && env.VITE_GCODE_JOB_API !== "0";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`C# 异步作业字段 ${label} 结构无效`);
  }
  return value as Record<string, unknown>;
}

function string(recordValue: Record<string, unknown>, key: string): string {
  const value = recordValue[key];
  if (typeof value !== "string") throw new Error(`C# 异步作业字段 ${key} 类型无效`);
  return value;
}

function finite(recordValue: Record<string, unknown>, key: string): number {
  const value = recordValue[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`C# 异步作业字段 ${key} 类型无效`);
  return value;
}

function status(recordValue: Record<string, unknown>): AuthorityJobStatus {
  const value = string(recordValue, "status") as AuthorityJobStatus;
  if (!STATUS.has(value)) throw new Error(`C# 异步作业状态无效：${value}`);
  return value;
}

function path(recordValue: Record<string, unknown>, key: string): string {
  const value = string(recordValue, key);
  if (!value.startsWith("/api/v1/") || value.includes("\\") || value.includes("//")) {
    throw new Error(`C# 异步作业链接 ${key} 无效`);
  }
  return value;
}

function parseAccepted(value: unknown): AcceptedJob {
  const root = record(value, "accepted");
  const jobId = string(root, "jobId");
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("C# 异步作业 jobId 无效");
  const schemaVersion = string(root, "schemaVersion");
  if (schemaVersion !== "1.0") throw new Error("C# 异步作业 schemaVersion 不受支持");
  const input = record(root.input, "input");
  const links = record(root.links, "links");
  const accepted: AcceptedJob = {
    schemaVersion,
    jobId,
    status: status(root),
    input: {
      sha256: string(input, "sha256"),
      bytesRead: finite(input, "bytesRead"),
      linesRead: finite(input, "linesRead"),
    },
    links: {
      status: path(links, "status"),
      events: path(links, "events"),
      cancel: path(links, "cancel"),
    },
  };
  const expectedBase = forgeXApiPath("getGCodeAnalysisJob", { id: jobId });
  if (
    accepted.links.status !== expectedBase ||
    accepted.links.events !== forgeXApiPath("streamGCodeAnalysisJobEvents", { id: jobId }) ||
    accepted.links.cancel !== forgeXApiPath("cancelGCodeAnalysisJob", { id: jobId })
  ) {
    throw new Error("C# 异步作业链接与 jobId 不一致");
  }
  return accepted;
}

function parseSnapshot(value: unknown, expectedJobId: string): JobSnapshot {
  const root = record(value, "snapshot");
  const id = string(root, "id");
  if (id !== expectedJobId) throw new Error(`C# 异步作业 ID 不一致：${id}`);
  if (string(root, "schemaVersion") !== "1.0") throw new Error("C# 异步作业 schemaVersion 不受支持");
  const errorValue = root.error;
  const errorRecord = errorValue === null || errorValue === undefined ? null : record(errorValue, "error");
  const progress = finite(root, "progress");
  const sequence = finite(root, "sequence");
  if (progress < 0 || progress > 1) throw new Error("C# 异步作业 progress 越界");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("C# 异步作业 sequence 无效");
  return {
    id,
    status: status(root),
    progress,
    phase: string(root, "phase"),
    sequence,
    result: root.result,
    error: errorRecord ? { code: string(errorRecord, "code"), message: string(errorRecord, "message") } : null,
  };
}

async function problem(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    detail?: unknown;
    title?: unknown;
  } | null;
  const code = typeof body?.code === "string" ? body.code : `HTTP_${response.status}`;
  const detail =
    typeof body?.detail === "string" ? body.detail : typeof body?.title === "string" ? body.title : fallback;
  return new AuthorityHttpError(`${code}: ${detail}`);
}

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return `gcode-${crypto.randomUUID()}`;
  fallbackKeySequence += 1;
  return `gcode-${Date.now().toString(36)}-${fallbackKeySequence.toString(36)}`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function createJob(
  file: File,
  options: GcodeParseOptions,
  env: ImportMetaEnv,
  signal: AbortSignal,
  retryDelay: number
): Promise<AcceptedJob> {
  const base = resolveNodeApiBase(env);
  const query = buildGcodeAuthorityQuery(options);
  const key = idempotencyKey();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        `${base}${forgeXApiOperations.createGCodeAnalysisJob.path}?${query}`,
        createNodeRequestInit(env, {
          method: "POST",
          headers: { "Content-Type": "application/x-gcode", "Idempotency-Key": key },
          body: file,
          signal,
        })
      );
      if (!response.ok) throw await problem(response, "C# 异步分析创建失败");
      return parseAccepted(await response.json());
    } catch (error) {
      if (signal.aborted || error instanceof AuthorityHttpError || !(error instanceof TypeError)) throw error;
      lastError = error;
      if (attempt === 0) await delay(retryDelay, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("C# 异步分析创建失败");
}

async function getSnapshot(
  base: string,
  accepted: AcceptedJob,
  env: ImportMetaEnv,
  signal: AbortSignal
): Promise<JobSnapshot> {
  const response = await fetch(
    base + accepted.links.status,
    createNodeRequestInit(env, { headers: { Accept: "application/json" }, signal })
  );
  if (!response.ok) throw await problem(response, "C# 异步作业查询失败");
  return parseSnapshot(await response.json(), accepted.jobId);
}

function parseEventFrame(frame: string): { sequence: number; data: Record<string, unknown> } | null {
  if (!frame.trim() || frame.trimStart().startsWith(":")) return null;
  let sequence = -1;
  const data: string[] = [];
  for (const line of frame.replaceAll("\r", "").split("\n")) {
    if (line.startsWith("id:")) sequence = Number(line.slice(3).trim());
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0 || data.length === 0) {
    throw new Error("C# SSE 事件缺少有效 id 或 data");
  }
  return { sequence, data: record(JSON.parse(data.join("\n")) as unknown, "event") };
}

async function consumeEvents(
  base: string,
  accepted: AcceptedJob,
  env: ImportMetaEnv,
  signal: AbortSignal,
  lastSequence: number,
  callbacks: AuthorityJobCallbacks
): Promise<{ readonly terminal: boolean; readonly lastSequence: number }> {
  const headers = new Headers({ Accept: "text/event-stream" });
  if (lastSequence > 0) headers.set("Last-Event-ID", String(lastSequence));
  const response = await fetch(base + accepted.links.events, createNodeRequestInit(env, { headers, signal }));
  if (!response.ok) throw await problem(response, "C# SSE 订阅失败");
  if (!response.body) throw new Error("C# SSE 响应不支持流式读取");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sequence = lastSequence;
  while (true) {
    const item = await reader.read();
    buffer += decoder.decode(item.value, { stream: !item.done });
    const normalized = buffer.replaceAll("\r\n", "\n");
    const frames = normalized.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = parseEventFrame(frame);
      if (!event || event.sequence <= sequence) continue;
      sequence = event.sequence;
      const eventStatus = status(event.data);
      const eventProgress = finite(event.data, "progress");
      if (eventProgress < 0 || eventProgress > 1) throw new Error("C# SSE progress 越界");
      const progress: AuthorityJobProgress = {
        jobId: accepted.jobId,
        status: eventStatus,
        progress: eventProgress,
        phase: string(event.data, "phase"),
        sequence,
        transport: "sse",
      };
      callbacks.onProgress?.(progress);
      if (TERMINAL.has(eventStatus)) return { terminal: true, lastSequence: sequence };
    }
    if (item.done) return { terminal: false, lastSequence: sequence };
  }
}

function finishSnapshot(
  snapshot: JobSnapshot,
  file: File,
  options: GcodeParseOptions
): AuthorityAnalysisResponse | null {
  if (snapshot.status === "failed" || snapshot.status === "cancelled") {
    throw new Error(`${snapshot.error?.code ?? snapshot.status}: ${snapshot.error?.message ?? "C# 异步作业未完成"}`);
  }
  if (!TERMINAL.has(snapshot.status)) return null;
  if (snapshot.result === null || snapshot.result === undefined) throw new Error("C# 异步作业终态缺少 result");
  return assertAuthorityContract(parseAuthorityResponse(snapshot.result), file, options);
}

export async function requestAuthorityJobAnalysis(
  file: File,
  options: GcodeParseOptions,
  env: ImportMetaEnv,
  signal: AbortSignal,
  callbacks: AuthorityJobCallbacks = {},
  clientOptions: AuthorityJobClientOptions = {}
): Promise<AuthorityAnalysisResponse> {
  const base = resolveNodeApiBase(env);
  const reconnectAttempts = clientOptions.reconnectAttempts ?? 2;
  const pollIntervalMs = clientOptions.pollIntervalMs ?? 750;
  const retryDelay = clientOptions.creationRetryDelayMs ?? 250;
  const accepted = await createJob(file, options, env, signal, retryDelay);
  callbacks.onAccepted?.(accepted.jobId);
  callbacks.onProgress?.({
    jobId: accepted.jobId,
    status: accepted.status,
    progress: 0,
    phase: "queued",
    sequence: 0,
    transport: "sse",
  });

  let sequence = 0;
  for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
    try {
      const consumed = await consumeEvents(base, accepted, env, signal, sequence, callbacks);
      sequence = consumed.lastSequence;
      if (consumed.terminal) {
        const snapshot = await getSnapshot(base, accepted, env, signal);
        const result = finishSnapshot(snapshot, file, options);
        if (result) return result;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === reconnectAttempts) break;
    }
  }

  while (!signal.aborted) {
    const snapshot = await getSnapshot(base, accepted, env, signal);
    callbacks.onProgress?.({
      jobId: accepted.jobId,
      status: snapshot.status,
      progress: snapshot.progress,
      phase: snapshot.phase,
      sequence: snapshot.sequence,
      transport: "poll",
    });
    const result = finishSnapshot(snapshot, file, options);
    if (result) return result;
    await delay(pollIntervalMs, signal);
  }
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function cancelAuthorityJob(jobId: string, env: ImportMetaEnv): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(jobId)) return;
  const base = resolveNodeApiBase(env);
  const response = await fetch(
    `${base}${forgeXApiPath("cancelGCodeAnalysisJob", { id: jobId })}`,
    createNodeRequestInit(env, { method: "POST", headers: { Accept: "application/json" } })
  );
  if (!response.ok && response.status !== 404) throw await problem(response, "C# 异步作业取消失败");
}
