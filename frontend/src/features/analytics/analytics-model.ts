import { legacyAnalytics } from "../../legacy/analytics-adapter.js";
import type {
  AnalyticsCsvFile,
  AnalyticsDataset,
  AnalyticsKpis,
  AnalyticsProvenance,
  AnalyticsReport,
} from "./analytics-types";

export const MAX_ANALYTICS_CSV_BYTES = 5 * 1024 * 1024;

export const ANALYTICS_QUESTIONS = [
  "哪台机故障率最高，主要故障是什么？",
  "PLA 和 PETG 的失败率有什么差异？",
  "层高与打印时长的相关性如何？",
  "本月单件成本与耗材成本趋势如何？",
  "失败批次有哪些共性原因？",
  "给出当前生产数据总体概览。",
] as const;

export class AnalyticsImportError extends Error {
  public readonly code: "empty-file" | "file-too-large" | "parse-error" | "read-error";

  public constructor(code: "empty-file" | "file-too-large" | "parse-error" | "read-error", message: string) {
    super(message);
    this.name = "AnalyticsImportError";
    this.code = code;
  }
}

export function listBuiltInAnalyticsDatasets(): readonly AnalyticsDataset[] {
  return legacyAnalytics.builtInDatasets();
}

export function analyticsKpis(dataset: AnalyticsDataset): AnalyticsKpis {
  return legacyAnalytics.kpis(dataset.rows);
}

export function runAnalyticsQuestion(question: string, dataset: AnalyticsDataset): AnalyticsReport {
  const normalized = question.trim();
  if (!normalized) throw new Error("请输入要分析的问题");
  return legacyAnalytics.analyze(normalized, dataset.rows, { provenance: dataset.provenance });
}

function uploadProvenance(rowCount: number, datasetKey: string): AnalyticsProvenance {
  return {
    source: "user-upload",
    synthetic: false,
    badge: "用户上传",
    note: "本地导入的 CSV；ForgeX 保留来源标记，但不会自动证明其来自真实产线。",
    generator: null,
    datasetKey,
    rowCount,
  };
}

function safeDatasetId(fileName: string): string {
  const compact = fileName
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .slice(0, 80);
  return `upload-${compact || "dataset"}`;
}

export async function importAnalyticsCsv(file: AnalyticsCsvFile): Promise<AnalyticsDataset> {
  if (file.size <= 0) throw new AnalyticsImportError("empty-file", "CSV 文件为空");
  if (file.size > MAX_ANALYTICS_CSV_BYTES) {
    throw new AnalyticsImportError("file-too-large", `CSV 超过 ${MAX_ANALYTICS_CSV_BYTES / 1024 / 1024} MB 上限`);
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new AnalyticsImportError("read-error", "读取 CSV 失败");
  }

  if (!text.trim()) throw new AnalyticsImportError("empty-file", "CSV 文件为空");
  const parsed = legacyAnalytics.parseCsv(text);
  if (!parsed.rows.length) {
    throw new AnalyticsImportError("parse-error", parsed.errors.join("；") || "CSV 中没有有效数据行");
  }

  const id = safeDatasetId(file.name);
  return {
    id,
    label: file.name || "本地 CSV",
    kind: "user-upload",
    description: "在当前浏览器会话内解析；browser 模式不联网，显式 shadow 模式会发送归一化数据行用于 C# 等价比对。",
    rows: parsed.rows,
    provenance: uploadProvenance(parsed.rows.length, id),
    warnings: parsed.errors,
  };
}
