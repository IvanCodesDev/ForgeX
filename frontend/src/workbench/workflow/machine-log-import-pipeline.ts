import { sha256 } from "../../engine/gcode-parser";
import { MAX_BYTES, parse } from "../../engine/machine-log";
import { summarizeMachineLog, type MachineLogSummary } from "../../engine/machine-log-summary";
import { MachineLogImportError, type MachineLogImportPhase } from "./machine-log-import-protocol";

export interface MachineLogImportProgress {
  readonly phase: MachineLogImportPhase;
  readonly progress: number;
}
export function validateMachineLogFile(file: File): void {
  if (file.name.length > 512) throw new MachineLogImportError("UNSUPPORTED_FORMAT", "真机日志文件名过长");
  if (!/\.(json|csv)$/i.test(file.name))
    throw new MachineLogImportError("UNSUPPORTED_FORMAT", "真机日志仅支持 JSON / CSV");
  if (file.size > MAX_BYTES) throw new MachineLogImportError("FILE_TOO_LARGE", "真机日志超过 20 MiB", "read");
}

/** Worker 与兼容路径使用同一条解析管线；摘要始终绑定含 BOM 的原始字节。 */
export async function parseMachineLogFile(
  file: File,
  progress: (value: MachineLogImportProgress) => void,
  signal?: AbortSignal
): Promise<MachineLogSummary> {
  validateMachineLogFile(file);
  let phase: MachineLogImportPhase = "read";
  try {
    const step = (next: MachineLogImportPhase, value: number) => {
      signal?.throwIfAborted();
      phase = next;
      progress({ phase, progress: value });
    };
    step("read", 0);
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw new MachineLogImportError("FILE_TOO_LARGE", "真机日志超过 20 MiB", "read");
    step("read", 1);
    step("hash", 0);
    const digest = await sha256(bytes);
    step("hash", 1);
    step("parse", 0);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MachineLogImportError("INVALID_UTF8", "真机日志必须使用 UTF-8 编码", "parse");
    }
    const log = parse(text, { name: file.name });
    log.sourceSha256 = digest;
    step("parse", 1);
    step("summary", 0);
    const result = summarizeMachineLog(log);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32 * 1024)
      throw new MachineLogImportError("PARSE_FAILED", "日志汇总信息超过 32 KiB，请缩短任务或设备等文字字段", "summary");
    step("summary", 1);
    return result;
  } catch (error) {
    if (error instanceof MachineLogImportError) throw error;
    if (signal?.aborted) throw new MachineLogImportError("CANCELLED", "真机日志导入已取消", phase);
    throw new MachineLogImportError(
      phase === "read" ? "READ_FAILED" : phase === "hash" ? "CRYPTO_UNAVAILABLE" : "PARSE_FAILED",
      error instanceof Error ? error.message.slice(0, 500) : "真机日志解析失败",
      phase
    );
  }
}
