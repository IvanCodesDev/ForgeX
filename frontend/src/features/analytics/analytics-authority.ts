import { useCallback, useEffect, useRef, useState } from "react";
import { createNodeRequestInit } from "../../app/api/api-adapter";
import { forgeXApiOperations, type AnalyticsReportRequest } from "../../generated/forgex-api";
import type { AnalyticsDataset, AnalyticsReport, AnalyticsRow } from "./analytics-types";

export type AnalyticsAuthorityMode = "browser" | "shadow" | "dotnet";

export interface AnalyticsAuthorityDifference {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export type AnalyticsAuthorityState =
  | { readonly status: "browser"; readonly detail: string }
  | { readonly status: "offline"; readonly detail: string }
  | { readonly status: "running"; readonly detail: string }
  | {
      readonly status: "matched" | "mismatch";
      readonly detail: string;
      readonly engineVersion: string;
      readonly comparedFields: number;
      readonly differences: readonly AnalyticsAuthorityDifference[];
      readonly report?: AnalyticsReport;
    }
  | { readonly status: "error"; readonly detail: string };

interface AuthorityEnvelope {
  readonly engineVersion: string;
  readonly report: unknown;
}

const DEFAULT_ANALYTICS_ENV = import.meta.env;
const AUTHORITY_TIMEOUT_MS = 30_000;
const MAX_DIFFERENCES = 20;
const ABS_TOLERANCE = 1e-9;
const REL_TOLERANCE = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (value === undefined) return "<missing>";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizedRow(row: AnalyticsRow): AnalyticsReportRequest["rows"][number] {
  return {
    ...(row.job_id === undefined ? {} : { job_id: row.job_id }),
    ...(row.date === undefined ? {} : { date: row.date }),
    ...(row.machine_id === undefined ? {} : { machine_id: row.machine_id }),
    ...(row.model_name === undefined ? {} : { model_name: row.model_name }),
    ...(row.material === undefined ? {} : { material: row.material }),
    ...(row.layer_height_mm === undefined ? {} : { layer_height_mm: row.layer_height_mm }),
    ...(row.duration_min === undefined ? {} : { duration_min: row.duration_min }),
    ...(row.filament_g === undefined ? {} : { filament_g: row.filament_g }),
    ...(row.cost_fen === undefined ? {} : { cost_fen: row.cost_fen }),
    status: row.status,
    ...(row.fail_reason === undefined ? {} : { fail_reason: row.fail_reason }),
    ...(row.energy_kwh === undefined ? {} : { energy_kwh: row.energy_kwh }),
  };
}

export function buildAnalyticsAuthorityRequest(question: string, dataset: AnalyticsDataset): AnalyticsReportRequest {
  return {
    schemaVersion: "1.0",
    question: question.trim(),
    rows: dataset.rows.map(normalizedRow),
    provenance: dataset.provenance,
  };
}

function parseAuthorityEnvelope(value: unknown): AuthorityEnvelope {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || !isRecord(value.engine)) {
    throw new Error("C# Analytics 返回了无效响应结构");
  }
  if (value.engine.name !== "forgex-analytics-csharp" || typeof value.engine.version !== "string") {
    throw new Error("C# Analytics 引擎标识无效");
  }
  if (!isRecord(value.report)) throw new Error("C# Analytics 报告缺失");
  return { engineVersion: value.engine.version, report: value.report };
}

function addDifference(
  differences: AnalyticsAuthorityDifference[],
  field: string,
  expected: unknown,
  actual: unknown
): void {
  if (differences.length >= MAX_DIFFERENCES) return;
  differences.push({ field, expected: text(expected), actual: text(actual) });
}

function compareValue(
  expected: unknown,
  actual: unknown,
  field: string,
  differences: AnalyticsAuthorityDifference[],
  counter: { value: number }
): void {
  if (Array.isArray(expected)) {
    counter.value += 1;
    if (!Array.isArray(actual)) {
      addDifference(differences, field, expected, actual);
      return;
    }
    if (expected.length !== actual.length)
      addDifference(differences, `${field}.length`, expected.length, actual.length);
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      compareValue(expected[index], actual[index], `${field}[${index}]`, differences, counter);
    }
    return;
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      counter.value += 1;
      addDifference(differences, field, expected, actual);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      compareValue(value, actual[key], `${field}.${key}`, differences, counter);
    }
    return;
  }

  counter.value += 1;
  if (typeof expected === "number" && typeof actual === "number") {
    const delta = Math.abs(expected - actual);
    const limit = Math.max(ABS_TOLERANCE, Math.abs(expected) * REL_TOLERANCE);
    if (!Number.isFinite(actual) || delta > limit) addDifference(differences, field, expected, actual);
    return;
  }
  if (!Object.is(expected, actual)) addDifference(differences, field, expected, actual);
}

export function compareAnalyticsReports(
  browserReport: AnalyticsReport,
  authorityReport: unknown
): { readonly comparedFields: number; readonly differences: readonly AnalyticsAuthorityDifference[] } {
  const differences: AnalyticsAuthorityDifference[] = [];
  const counter = { value: 0 };
  compareValue(browserReport, authorityReport, "$", differences, counter);
  return { comparedFields: counter.value, differences };
}

function selectComparedShape(expected: unknown, actual: unknown): unknown {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.map((item, index) => selectComparedShape(item, actual[index]));
  }
  if (isRecord(expected) && isRecord(actual)) {
    return Object.fromEntries(
      Object.entries(expected).map(([key, value]) => [key, selectComparedShape(value, actual[key])])
    );
  }
  return actual;
}

function verifiedAuthorityReport(browserReport: AnalyticsReport, authorityReport: unknown): AnalyticsReport {
  // compareAnalyticsReports has already verified every browser-owned field and type.
  // Rebuilding that exact shape prevents authority-only fields from reaching exports.
  return selectComparedShape(browserReport, authorityReport) as AnalyticsReport;
}

export async function requestAnalyticsAuthority(
  apiBase: string,
  question: string,
  dataset: AnalyticsDataset,
  signal: AbortSignal,
  env: ImportMetaEnv = DEFAULT_ANALYTICS_ENV
): Promise<AuthorityEnvelope> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timeout = globalThis.setTimeout(
    () => controller.abort(new Error("C# Analytics 请求超时")),
    AUTHORITY_TIMEOUT_MS
  );
  try {
    const response = await fetch(
      apiBase.replace(/\/+$/, "") + forgeXApiOperations.analyzeAnalyticsReport.path,
      createNodeRequestInit(env, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(buildAnalyticsAuthorityRequest(question, dataset)),
        signal: controller.signal,
      })
    );
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const problem: unknown = await response.json();
        if (isRecord(problem) && typeof problem.code === "string") detail += ` · ${problem.code}`;
      } catch {
        // Preserve the HTTP status when a gateway returns non-JSON text.
      }
      throw new Error(`C# Analytics 请求失败（${detail}）`);
    }
    return parseAuthorityEnvelope(await response.json());
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new Error("C# Analytics 请求超时", { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

export function useAnalyticsAuthority(
  mode: AnalyticsAuthorityMode,
  apiBase: string | null,
  env: ImportMetaEnv = DEFAULT_ANALYTICS_ENV
) {
  const [state, setState] = useState<AnalyticsAuthorityState>(() =>
    mode === "browser"
      ? { status: "browser", detail: "仅运行浏览器 JS 报告；未发送影子请求。" }
      : apiBase === null
        ? { status: "offline", detail: "离线模式保持浏览器报告，不发送网络请求。" }
        : {
            status: "browser",
            detail: mode === "dotnet" ? "等待规则分析后运行 C# 权威结果门禁。" : "等待规则分析后启动 C# 影子比对。",
          }
  );
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    requestId.current += 1;
    controller.current?.abort();
    controller.current = null;
    setState(
      mode === "browser"
        ? { status: "browser", detail: "仅运行浏览器 JS 报告；未发送影子请求。" }
        : apiBase === null
          ? { status: "offline", detail: "离线模式保持浏览器报告，不发送网络请求。" }
          : {
              status: "browser",
              detail: mode === "dotnet" ? "等待规则分析后运行 C# 权威结果门禁。" : "等待规则分析后启动 C# 影子比对。",
            }
    );
  }, [apiBase, mode]);

  const run = useCallback(
    async (question: string, dataset: AnalyticsDataset, browserReport: AnalyticsReport) => {
      if (mode === "browser" || apiBase === null) {
        reset();
        return;
      }
      requestId.current += 1;
      const currentId = requestId.current;
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setState({
        status: "running",
        detail:
          mode === "dotnet"
            ? "浏览器回退结果已就绪；正在校验 C# 权威报告…"
            : "浏览器结果已显示；正在与 C# 权威核心逐字段比对…",
      });
      try {
        const authority = await requestAnalyticsAuthority(apiBase, question, dataset, active.signal, env);
        if (currentId !== requestId.current) return;
        const comparison = compareAnalyticsReports(browserReport, authority.report);
        setState(
          comparison.differences.length === 0
            ? {
                status: "matched",
                detail:
                  mode === "dotnet"
                    ? `C# 权威报告已启用：${comparison.comparedFields} 个字段通过一致性门禁。`
                    : `字段级比对一致：${comparison.comparedFields} 个字段通过。`,
                engineVersion: authority.engineVersion,
                comparedFields: comparison.comparedFields,
                differences: [],
                report: verifiedAuthorityReport(browserReport, authority.report),
              }
            : {
                status: "mismatch",
                detail: `发现 ${comparison.differences.length} 项差异；页面保留浏览器 JS 回退结果。`,
                engineVersion: authority.engineVersion,
                comparedFields: comparison.comparedFields,
                differences: comparison.differences,
              }
        );
      } catch (error) {
        if (currentId !== requestId.current || active.signal.aborted) return;
        setState({ status: "error", detail: error instanceof Error ? error.message : "C# Analytics 请求失败" });
      } finally {
        if (currentId === requestId.current) controller.current = null;
      }
    },
    [apiBase, env, mode, reset]
  );

  useEffect(() => {
    reset();
    return () => {
      requestId.current += 1;
      controller.current?.abort();
      controller.current = null;
    };
  }, [reset]);

  return { state, run, reset } as const;
}
