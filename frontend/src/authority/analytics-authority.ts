/* C# Analytics 权威接线（阶段 4 收尾）。
   与 gcode-authority 同构的三态模式：
     - browser：本地 TS 规则引擎，零请求（file:// 与默认行为，永远可回滚）；
     - shadow：展示本地结果，同一份数据后台送 C# 对照，差异进控制台（双跑标准）；
     - dotnet：C# 结果通过完整校验后原子成为展示结果，失败回退本地并明示。
   请求/响应契约以 OpenAPI 生成物为准（forgex-api.ts），本模块只做运行时收窄。 */

import { createNodeRequestInit, detectRuntimeMode, resolveNodeApiBase } from "./runtime";
import {
  forgeXApiOperations,
  type AnalyticsAuthorityResponse,
  type AnalyticsChart,
  type AnalyticsChartItem,
  type AnalyticsEvidence,
  type AnalyticsProvenance,
  type AnalyticsReport,
  type AnalyticsReportRequest,
  type AnalyticsRow,
} from "../generated/forgex-api";
import type { DatasetProvenance, InsightReport } from "../legacy/engine";

export type AnalyticsAuthorityMode = "browser" | "shadow" | "dotnet";

/** 与 C# 端 AnalyticsReportRequest 的 schema 上限一致（超限由本地规则引擎兜底）。 */
export const ANALYTICS_AUTHORITY_MAX_ROWS = 5000;
export const ANALYTICS_AUTHORITY_MAX_QUESTION_CHARS = 500;

/** 展示层的引擎标识：算法族仍是 local-rules 的镜像，但计算发生在 C# 权威侧。 */
export const ANALYTICS_AUTHORITY_ENGINE_ID = "dotnet-authority";

/** 数据集或问题超出权威契约（行数/字段/长度）——不是故障，安静留在本地引擎即可。 */
export class AnalyticsAuthorityUnsupportedError extends Error {}

export function resolveAnalyticsAuthorityMode(
  env: ImportMetaEnv,
  location: Pick<Location, "protocol"> = typeof window === "undefined" ? { protocol: "http:" } : window.location
): AnalyticsAuthorityMode {
  if (detectRuntimeMode(location, env).kind === "offline") return "browser";
  const value = env.VITE_ANALYTICS_AUTHORITY?.trim().toLowerCase();
  return value === "shadow" || value === "dotnet" ? value : "browser";
}

const ROW_STRING_KEYS = ["job_id", "date", "machine_id", "model_name", "material", "fail_reason"] as const;
const ROW_NUMBER_KEYS = ["layer_height_mm", "duration_min", "filament_g", "cost_fen", "energy_kwh"] as const;

/**
 * 把浏览器侧数据行收窄成 C# 契约行（additionalProperties: false）。
 * 类型不符的可空字段按 null 送出——与本地统计核忽略无效值的口径一致；
 * status 缺失或非法说明整个数据集不在契约内，抛 Unsupported 留在本地。
 */
export function sanitizeAnalyticsRows(rows: readonly unknown[]): AnalyticsRow[] {
  if (rows.length < 1 || rows.length > ANALYTICS_AUTHORITY_MAX_ROWS) {
    throw new AnalyticsAuthorityUnsupportedError(
      `数据集共 ${rows.length} 行，超出 C# 权威契约（1..${ANALYTICS_AUTHORITY_MAX_ROWS}）`
    );
  }
  return rows.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AnalyticsAuthorityUnsupportedError(`第 ${index + 1} 行不是对象，无法进入 C# 权威契约`);
    }
    const row = value as Record<string, unknown>;
    const status = row.status;
    if (status !== "success" && status !== "fail") {
      throw new AnalyticsAuthorityUnsupportedError(`第 ${index + 1} 行 status=${String(status)} 不在契约枚举内`);
    }
    const out: Record<string, unknown> = { status };
    for (const key of ROW_STRING_KEYS) {
      out[key] = typeof row[key] === "string" ? row[key] : null;
    }
    for (const key of ROW_NUMBER_KEYS) {
      out[key] = typeof row[key] === "number" && Number.isFinite(row[key] as number) ? row[key] : null;
    }
    return out as unknown as AnalyticsRow;
  });
}

export function buildAnalyticsAuthorityRequest(question: string, rows: readonly unknown[]): AnalyticsReportRequest {
  const q = question.trim();
  if (q.length < 1 || q.length > ANALYTICS_AUTHORITY_MAX_QUESTION_CHARS) {
    throw new AnalyticsAuthorityUnsupportedError(
      `问题长度 ${q.length} 超出 C# 权威契约（1..${ANALYTICS_AUTHORITY_MAX_QUESTION_CHARS}）`
    );
  }
  return {
    schemaVersion: "1.0",
    question: q,
    rows: sanitizeAnalyticsRows(rows),
    // 数据集来源标记是浏览器侧的展示语义，权威端不回显；展示时由本地回填（toInsightReport）。
    provenance: null,
  };
}

/* —— 响应的运行时收窄：只信任验证过的字段，任何结构漂移都拒绝整份结果 —— */

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`C# Analytics 结果字段 ${label} 结构无效`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`C# Analytics 结果字段 ${label} 类型无效`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, label = key): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`C# Analytics 结果字段 ${label} 类型无效`);
  return value;
}

function requireSafeCount(record: Record<string, unknown>, key: string, label = key): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`C# Analytics 结果字段 ${label} 类型无效`);
  }
  return value;
}

function requireNullableFinite(record: Record<string, unknown>, key: string, label = key): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`C# Analytics 结果字段 ${label} 类型无效`);
  }
  return value;
}

function optionalFinite(record: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`C# Analytics 结果字段 ${label} 类型无效`);
  }
  return value;
}

const CHART_KINDS = new Set(["bar-rate", "bar", "line"]);
const MAX_SECTIONS = 64;
const MAX_SECTION_LINES = 256;
const MAX_EVIDENCE = 64;
const MAX_CHART_ITEMS = 512;

function parseChart(value: unknown): AnalyticsChart | null {
  if (value === null || value === undefined) return null;
  const chart = requireRecord(value, "report.chart");
  const kind = requireString(chart, "kind", "report.chart.kind");
  if (!CHART_KINDS.has(kind)) {
    throw new Error(`C# Analytics 结果契约不一致：chart.kind=${kind}`);
  }
  const title = requireString(chart, "title", "report.chart.title");
  if (!Array.isArray(chart.items) || chart.items.length > MAX_CHART_ITEMS) {
    throw new Error("C# Analytics 结果字段 report.chart.items 结构无效");
  }
  const items: AnalyticsChartItem[] = chart.items.map((entry, index) => {
    const item = requireRecord(entry, `report.chart.items[${index}]`);
    const weak = item.weak;
    if (weak !== undefined && typeof weak !== "boolean") {
      throw new Error(`C# Analytics 结果字段 report.chart.items[${index}].weak 类型无效`);
    }
    const hint = item.hint;
    if (hint !== undefined && typeof hint !== "string") {
      throw new Error(`C# Analytics 结果字段 report.chart.items[${index}].hint 类型无效`);
    }
    const value = item.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`C# Analytics 结果字段 report.chart.items[${index}].value 类型无效`);
    }
    const ciLo = optionalFinite(item, "ciLo", `report.chart.items[${index}].ciLo`);
    const ciHi = optionalFinite(item, "ciHi", `report.chart.items[${index}].ciHi`);
    return {
      label: requireString(item, "label", `report.chart.items[${index}].label`),
      value,
      ...(hint !== undefined ? { hint } : {}),
      ...(weak !== undefined ? { weak } : {}),
      ...(ciLo !== undefined ? { ciLo } : {}),
      ...(ciHi !== undefined ? { ciHi } : {}),
    } as AnalyticsChartItem;
  });
  return { kind, title, items };
}

function parseEvidence(value: unknown): AnalyticsEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) {
    throw new Error("C# Analytics 结果字段 report.evidence 结构无效");
  }
  return value.map((entry, index) => {
    const item = requireRecord(entry, `report.evidence[${index}]`);
    const ci95 = item.ci95;
    let ci: readonly [number, number] | null = null;
    if (ci95 !== null && ci95 !== undefined) {
      if (
        !Array.isArray(ci95) ||
        ci95.length !== 2 ||
        typeof ci95[0] !== "number" ||
        !Number.isFinite(ci95[0]) ||
        typeof ci95[1] !== "number" ||
        !Number.isFinite(ci95[1])
      ) {
        throw new Error(`C# Analytics 结果字段 report.evidence[${index}].ci95 类型无效`);
      }
      ci = [ci95[0], ci95[1]];
    }
    return {
      claim: requireString(item, "claim", `report.evidence[${index}].claim`),
      method: requireString(item, "method", `report.evidence[${index}].method`),
      n: requireSafeCount(item, "n", `report.evidence[${index}].n`),
      statistic: requireNullableFinite(item, "statistic", `report.evidence[${index}].statistic`),
      ci95: ci,
      pValue: requireNullableFinite(item, "pValue", `report.evidence[${index}].pValue`),
    };
  });
}

function parseProvenance(value: unknown): AnalyticsProvenance | null {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, "report.provenance");
  let generator: AnalyticsProvenance["generator"] = null;
  if (record.generator !== null && record.generator !== undefined) {
    const raw = requireRecord(record.generator, "report.provenance.generator");
    const seed = raw.seed;
    if (seed !== null && (typeof seed !== "number" || !Number.isSafeInteger(seed))) {
      throw new Error("C# Analytics 结果字段 report.provenance.generator.seed 类型无效");
    }
    generator = {
      name: requireString(raw, "name", "report.provenance.generator.name"),
      version: requireSafeCount(raw, "version", "report.provenance.generator.version"),
      seed: (seed ?? null) as number | null,
    };
  }
  return {
    source: requireString(record, "source", "report.provenance.source"),
    synthetic: requireBoolean(record, "synthetic", "report.provenance.synthetic"),
    badge: requireString(record, "badge", "report.provenance.badge"),
    note: requireString(record, "note", "report.provenance.note"),
    generator,
    datasetKey: requireString(record, "datasetKey", "report.provenance.datasetKey"),
    rowCount: requireSafeCount(record, "rowCount", "report.provenance.rowCount"),
  };
}

export function parseAnalyticsAuthorityResponse(value: unknown): AnalyticsAuthorityResponse {
  const root = requireRecord(value, "root");
  const schemaVersion = requireString(root, "schemaVersion");
  if (schemaVersion !== "1.0") {
    throw new Error(`C# Analytics 结果契约不一致：schemaVersion=${schemaVersion}`);
  }
  const engine = requireRecord(root.engine, "engine");
  const engineName = requireString(engine, "name", "engine.name");
  if (engineName !== "forgex-analytics-csharp") {
    throw new Error(`C# Analytics 结果契约不一致：engine.name=${engineName}`);
  }
  const engineVersion = requireString(engine, "version", "engine.version");
  if (!engineVersion.trim()) throw new Error("C# Analytics 结果契约不一致：engine.version 为空");

  const report = requireRecord(root.report, "report");
  const reportSchemaVersion = report.schemaVersion;
  if (reportSchemaVersion !== 1) {
    throw new Error(`C# Analytics 结果契约不一致：report.schemaVersion=${String(reportSchemaVersion)}`);
  }
  const reportEngine = requireString(report, "engine", "report.engine");
  if (reportEngine !== "local-rules") {
    throw new Error(`C# Analytics 结果契约不一致：report.engine=${reportEngine}`);
  }
  if (!Array.isArray(report.sections) || report.sections.length > MAX_SECTIONS) {
    throw new Error("C# Analytics 结果字段 report.sections 结构无效");
  }
  const sections = report.sections.map((entry, index) => {
    const section = requireRecord(entry, `report.sections[${index}]`);
    if (!Array.isArray(section.lines) || section.lines.length > MAX_SECTION_LINES) {
      throw new Error(`C# Analytics 结果字段 report.sections[${index}].lines 结构无效`);
    }
    return {
      h: requireString(section, "h", `report.sections[${index}].h`),
      lines: section.lines.map((line, lineIndex) => {
        if (typeof line !== "string") {
          throw new Error(`C# Analytics 结果字段 report.sections[${index}].lines[${lineIndex}] 类型无效`);
        }
        return line;
      }),
    };
  });
  let highlight: AnalyticsReport["highlight"] = null;
  if (report.highlight !== null && report.highlight !== undefined) {
    const raw = requireRecord(report.highlight, "report.highlight");
    highlight = {
      type: requireString(raw, "type", "report.highlight.type"),
      id: requireString(raw, "id", "report.highlight.id"),
    };
  }
  return {
    schemaVersion,
    engine: { name: engineName, version: engineVersion },
    report: {
      schemaVersion: reportSchemaVersion,
      title: requireString(report, "title", "report.title"),
      verdict: requireString(report, "verdict", "report.verdict"),
      confidence: requireString(report, "confidence", "report.confidence"),
      sections,
      chart: parseChart(report.chart),
      evidence: parseEvidence(report.evidence),
      intent: requireString(report, "intent", "report.intent"),
      intentMatched: requireBoolean(report, "intentMatched", "report.intentMatched"),
      rowCount: requireSafeCount(report, "rowCount", "report.rowCount"),
      engine: reportEngine,
      provenance: parseProvenance(report.provenance),
      highlight,
    },
  };
}

export async function requestAnalyticsAuthorityReport(
  question: string,
  rows: readonly unknown[],
  env: ImportMetaEnv,
  signal?: AbortSignal
): Promise<AnalyticsAuthorityResponse> {
  const request = buildAnalyticsAuthorityRequest(question, rows);
  const base = resolveNodeApiBase(env);
  const response = await fetch(
    `${base}${forgeXApiOperations.analyzeAnalyticsReport.path}`,
    createNodeRequestInit(env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    })
  );
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown; detail?: unknown } | null;
    const code = typeof problem?.code === "string" ? problem.code : `HTTP_${response.status}`;
    const detail = typeof problem?.detail === "string" ? problem.detail : "C# Analytics 权威分析失败";
    throw new Error(`${code}: ${detail}`);
  }
  const parsed = parseAnalyticsAuthorityResponse(await response.json());
  // 回声核对：权威端统计的行数必须等于送出的行数，否则说明请求被截断或改写。
  if (parsed.report.rowCount !== request.rows.length) {
    throw new Error(`C# Analytics 结果契约不一致：rowCount=${parsed.report.rowCount}, expected=${request.rows.length}`);
  }
  return parsed;
}

/* —— shadow 双跑对比：与 stage4 金样本同款容差（abs/rel 1e-9） —— */

export interface AnalyticsAuthorityDiff {
  readonly pass: boolean;
  readonly mismatches: readonly string[];
}

function numbersClose(local: number | null, authority: number | null): boolean {
  if (local === null || authority === null) return local === authority;
  const delta = Math.abs(local - authority);
  return delta <= Math.max(1e-9, Math.abs(local) * 1e-9);
}

export function compareAnalyticsReports(local: InsightReport, authority: AnalyticsReport): AnalyticsAuthorityDiff {
  const mismatches: string[] = [];
  const localRecord = local as unknown as Record<string, unknown>;
  const push = (field: string, localValue: unknown, authorityValue: unknown) =>
    mismatches.push(`${field}: local=${JSON.stringify(localValue)}, authority=${JSON.stringify(authorityValue)}`);

  const textFields: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["title", local.title ?? "", authority.title],
    ["verdict", local.verdict ?? "", authority.verdict],
    ["confidence", local.confidence ?? "", authority.confidence],
    ["intent", localRecord.intent ?? "", authority.intent],
    ["intentMatched", localRecord.intentMatched ?? false, authority.intentMatched],
    ["rowCount", local.rowCount ?? 0, authority.rowCount],
  ];
  for (const [field, localValue, authorityValue] of textFields) {
    if (localValue !== authorityValue) push(field, localValue, authorityValue);
  }

  const localSections = local.sections ?? [];
  if (localSections.length !== authority.sections.length) {
    push("sections.length", localSections.length, authority.sections.length);
  } else {
    localSections.forEach((section, index) => {
      const other = authority.sections[index];
      if (!other) return;
      if (section.h !== other.h) push(`sections[${index}].h`, section.h, other.h);
      const localLines = (section.lines ?? []).join("\n");
      const authorityLines = other.lines.join("\n");
      if (localLines !== authorityLines) push(`sections[${index}].lines`, localLines, authorityLines);
    });
  }

  const localEvidence = local.evidence ?? [];
  if (localEvidence.length !== authority.evidence.length) {
    push("evidence.length", localEvidence.length, authority.evidence.length);
  } else {
    localEvidence.forEach((item, index) => {
      const other = authority.evidence[index];
      if (!other) return;
      if (item.claim !== other.claim) push(`evidence[${index}].claim`, item.claim, other.claim);
      if ((item.method ?? "") !== other.method) push(`evidence[${index}].method`, item.method, other.method);
      if ((item.n ?? 0) !== other.n) push(`evidence[${index}].n`, item.n, other.n);
      if (!numbersClose(item.statistic ?? null, other.statistic)) {
        push(`evidence[${index}].statistic`, item.statistic, other.statistic);
      }
      if (!numbersClose(item.pValue ?? null, other.pValue))
        push(`evidence[${index}].pValue`, item.pValue, other.pValue);
      const localCi = item.ci95 ?? null;
      const authorityCi = other.ci95;
      if ((localCi === null) !== (authorityCi === null)) {
        push(`evidence[${index}].ci95`, localCi, authorityCi);
      } else if (localCi && authorityCi) {
        if (
          !numbersClose(localCi[0] ?? null, authorityCi[0] ?? null) ||
          !numbersClose(localCi[1] ?? null, authorityCi[1] ?? null)
        ) {
          push(`evidence[${index}].ci95`, localCi, authorityCi);
        }
      }
    });
  }

  const localChart = local.chart ?? null;
  const authorityChart = authority.chart;
  if ((localChart === null) !== (authorityChart === null)) {
    push("chart", localChart ? localChart.kind : null, authorityChart ? authorityChart.kind : null);
  } else if (localChart && authorityChart) {
    if (localChart.kind !== authorityChart.kind) push("chart.kind", localChart.kind, authorityChart.kind);
    if ((localChart.title ?? "") !== authorityChart.title) {
      push("chart.title", localChart.title, authorityChart.title);
    }
    if (localChart.items.length !== authorityChart.items.length) {
      push("chart.items.length", localChart.items.length, authorityChart.items.length);
    } else {
      localChart.items.forEach((item, index) => {
        const other = authorityChart.items[index];
        if (!other) return;
        if (item.label !== other.label) push(`chart.items[${index}].label`, item.label, other.label);
        if (!numbersClose(item.value, other.value)) push(`chart.items[${index}].value`, item.value, other.value);
        if (!numbersClose(item.ciLo ?? null, other.ciLo ?? null)) {
          push(`chart.items[${index}].ciLo`, item.ciLo, other.ciLo);
        }
        if (!numbersClose(item.ciHi ?? null, other.ciHi ?? null)) {
          push(`chart.items[${index}].ciHi`, item.ciHi, other.ciHi);
        }
        if ((item.weak ?? false) !== (other.weak ?? false)) push(`chart.items[${index}].weak`, item.weak, other.weak);
      });
    }
  }

  const localHighlight = local.highlight ?? null;
  const authorityHighlight = authority.highlight;
  if ((localHighlight === null) !== (authorityHighlight === null)) {
    push("highlight", localHighlight, authorityHighlight);
  } else if (localHighlight && authorityHighlight) {
    if (localHighlight.type !== authorityHighlight.type || localHighlight.id !== authorityHighlight.id) {
      push("highlight", localHighlight, authorityHighlight);
    }
  }

  return { pass: mismatches.length === 0, mismatches };
}

/**
 * 权威响应 → 洞察面板展示报告。
 * engine 改用权威标识（展示层区分计算发生地）；数据集来源标记由浏览器侧回填——
 * 权威端不知道浏览器里这份数据从哪来（与 Node 远端分析路径的口径一致）。
 */
export function toInsightReport(
  response: AnalyticsAuthorityResponse,
  options: { readonly provenance?: DatasetProvenance; readonly elapsedMs: number }
): InsightReport {
  const report = response.report;
  const chart = report.chart;
  const provenance = (report.provenance as DatasetProvenance | null) ?? options.provenance;
  const mapped: InsightReport = {
    title: report.title,
    engine: ANALYTICS_AUTHORITY_ENGINE_ID,
    rowCount: report.rowCount,
    elapsedMs: options.elapsedMs,
    ...(provenance !== undefined ? { provenance } : {}),
    verdict: report.verdict,
    confidence: report.confidence,
    ...(chart
      ? { chart: { kind: chart.kind as "bar-rate" | "bar" | "line", title: chart.title, items: chart.items } }
      : {}),
    sections: report.sections,
    evidence: report.evidence.map((item) => ({
      claim: item.claim,
      method: item.method,
      n: item.n,
      ...(item.statistic !== null ? { statistic: item.statistic } : {}),
      // parse 阶段已验证 ci95 恰为两个有限数；生成类型是宽数组，这里收回元组
      ...(item.ci95 !== null ? { ci95: [item.ci95[0]!, item.ci95[1]!] as const } : {}),
      ...(item.pValue !== null ? { pValue: item.pValue } : {}),
    })),
    ...(report.highlight ? { highlight: report.highlight } : {}),
  };
  // intent/intentMatched 与权威引擎版本随报告透传（shadow 对比与调试用），
  // InsightReport 未声明这些镜像字段，经 Object.assign 附着以避开弱类型断言。
  return Object.assign(mapped, {
    intent: report.intent,
    intentMatched: report.intentMatched,
    authorityEngineVersion: response.engine.version,
  });
}
