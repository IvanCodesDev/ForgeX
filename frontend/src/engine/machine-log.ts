/* FORGE·X — 真机任务日志解析与 G-code 计划/实测对比（纯逻辑）。

   支持：
     1. forgex-machine-log v1 JSON（完整契约见 contracts/logs/machine-log.schema.json）；
     2. 常见列名的 CSV 遥测：time_s / nozzle_c / bed_c，并可附带任务汇总字段。
   这里只做数据归一和差异计算，不把运动时间估算包装成真值。 */
import type { ParsedGcodeResult } from "./gcode-parser.ts";

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 1000000;

export interface LogSample {
  timeSec: number | null;
  nozzleC: number | null;
  bedC: number | null;
}

export interface MachineLogResult {
  name: string;
  format: string;
  jobId: string;
  machineId: string;
  firmware: string;
  slicer: string;
  gcodeSha256: string;
  actualTimeSec: number | null;
  filamentMm: number | null;
  filamentG: number | null;
  completedLayers: number | null;
  status: string;
  energyKwh: number | null;
  energyEvidence: string;
  /** 原始日志文件摘要，由导入入口按字节计算；纯文本解析不代填。 */
  sourceSha256: string;
  samples: LogSample[];
  warnings: string[];
  source: string;
  gcodeBinding?: GcodeBindingResult;
}

export interface GcodeBindingResult {
  verified: boolean;
  status: "missing" | "invalid" | "unavailable" | "mismatch" | "verified";
  expected: string;
  actual: string;
  message: string;
}

export interface ComparisonRow {
  name: string;
  planned: number;
  actual: number;
  unit: string;
  relDiff: number | null;
  agrees: boolean;
  note: string;
}

type RawRecord = Record<string, unknown>;

function finite(v: unknown): number | null {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "number" && typeof v !== "string") throw new Error("日志数值必须是有限数字");
  if (typeof v === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v.trim()))
    throw new Error("日志数值必须是十进制数字");
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("日志数值必须是有限数字");
  return n;
}

function firstFinite(...args: unknown[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const n = finite(args[i]);
    if (n != null) return n;
  }
  return null;
}

function firstText(...args: unknown[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] != null && String(args[i]).trim()) return String(args[i]).trim();
  }
  return "";
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const finishRow = () => {
    row.push(field);
    if (row.some((x) => x.trim())) rows.push(row);
    row = [];
    field = "";
    closed = false;
    // 一行表头 + MAX_ROWS 行数据，最后一行同样受限。
    if (rows.length > MAX_ROWS + 1) throw new Error("真机日志行数超过上限");
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      if (field || closed) throw new Error("CSV 引号位置无效");
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      finishRow();
    } else {
      if (closed) {
        if (ch === " " || ch === "\t") continue;
        throw new Error("CSV 引号后存在多余字符");
      }
      field += ch;
    }
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  finishRow();
  return rows;
}

function key(v: unknown): string {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

function at(obj: RawRecord, names: string[]): unknown {
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (Object.hasOwn(obj, name) && obj[name] != null && obj[name] !== "") return obj[name];
  }
  return null;
}

function normalizeSample(raw: RawRecord): LogSample {
  const timeSec = firstFinite(
    at(raw, ["timeSec", "time_s", "elapsed_s", "elapsedSec", "timestamp_sec", "timestamp_s"])
  );
  if (timeSec !== null && timeSec < 0) throw new Error("遥测时间不得为负数");
  return {
    timeSec,
    nozzleC: firstFinite(at(raw, ["nozzleC", "nozzle_c", "hotend_c", "tool0_c", "extruder_c"])),
    bedC: firstFinite(at(raw, ["bedC", "bed_c", "bed_temp_c"])),
  };
}

function durationFromSamples(samples: LogSample[]): number | null {
  let min = Infinity,
    max = -Infinity;
  for (const { timeSec } of samples) {
    if (timeSec !== null) {
      min = Math.min(min, timeSec);
      max = Math.max(max, timeSec);
    }
  }
  return min === Infinity ? null : max - min;
}

function record(value: unknown, label: string): RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as RawRecord;
}

function normalize(data: RawRecord, name?: string): MachineLogResult {
  const job = record(data.job ?? data.summary ?? data, "任务汇总");
  const rawSamples = data.telemetry ?? data.samples ?? [];
  if (!Array.isArray(rawSamples)) throw new Error("遥测样本必须是数组");
  if (rawSamples.length > MAX_ROWS) throw new Error("真机日志行数超过上限");
  const samples = rawSamples.map((s: unknown) => normalizeSample(record(s, "遥测样本")));
  const minutes = (value: unknown) => {
    const number = finite(value);
    return number === null ? null : number * 60;
  };
  let duration = firstFinite(
    job.durationSec,
    job.duration_s,
    job.elapsedSec,
    job.elapsed_s,
    minutes(job.durationMin),
    minutes(job.duration_min)
  );
  const hasSummaryDuration = duration !== null;
  if (duration == null) duration = durationFromSamples(samples);
  const result: MachineLogResult = {
    name: name || firstText(data.id, job.jobId, job.job_id, "machine-log"),
    format: (data.format as string) || "generic-machine-log",
    jobId: firstText(job.jobId, job.job_id),
    machineId: firstText(job.machineId, job.machine_id),
    firmware: firstText(job.firmware, data.firmware),
    slicer: firstText(job.slicer, data.slicer),
    gcodeSha256: firstText(job.gcodeSha256, job.gcode_sha256).toLowerCase(),
    actualTimeSec: duration,
    filamentMm: firstFinite(job.filamentMm, job.filament_mm),
    filamentG: firstFinite(job.filamentG, job.filament_g),
    completedLayers: firstFinite(job.completedLayers, job.completed_layers, job.layers),
    status: firstText(job.status, data.status, "unknown"),
    energyKwh: firstFinite(job.energyKwh, job.energy_kwh),
    energyEvidence: firstText(job.energyEvidence, job.energy_evidence).replace(/\r\n/g, "\n"),
    sourceSha256: "",
    samples,
    warnings: [],
    source: "machine-log",
  };
  const rawEnergyEvidence = job.energyEvidence ?? job.energy_evidence;
  if (rawEnergyEvidence != null && typeof rawEnergyEvidence !== "string") throw new Error("能耗依据必须为文本");
  for (const field of ["actualTimeSec", "filamentMm", "filamentG", "completedLayers", "energyKwh"] as const) {
    const value = result[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} 必须为有限非负数`);
  }
  if (result.completedLayers !== null && !Number.isSafeInteger(result.completedLayers))
    throw new Error("完成层数必须是安全整数");
  if (result.energyKwh !== null && result.energyKwh > 1_000_000) throw new Error("单任务能耗不得超过 1000000 kWh");
  if (
    result.energyEvidence.length > 500 ||
    [...result.energyEvidence].some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && char !== "\n" && char !== "\t") || (code >= 127 && code <= 159);
    })
  )
    throw new Error("能耗依据不得超过 500 字或包含控制字符");
  if (result.energyKwh !== null && !result.energyEvidence)
    result.warnings.push("日志含能耗数值但缺少计量依据，不参与成本对账");
  if (!hasSummaryDuration && duration !== null)
    result.warnings.push("时长取遥测时间范围的跨度，样本可能未覆盖完整任务");
  if (result.actualTimeSec == null) result.warnings.push("日志没有任务时长，无法比较打印时间");
  if (result.filamentMm == null && result.filamentG == null) result.warnings.push("日志没有耗材汇总，无法比较用料");
  if (!samples.length) result.warnings.push("日志没有温度遥测样本");
  return result;
}

function parseCsvLog(text: string, name?: string): MachineLogResult {
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error("CSV 真机日志至少需要表头和一行数据");
  const headers = rows[0]!.map(key);
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new Error("CSV 表头为空或存在重复列");
  const objects = rows.slice(1).map((cells) => {
    if (cells.length !== headers.length) throw new Error("CSV 数据列数与表头不一致");
    const obj: RawRecord = Object.create(null) as RawRecord;
    headers.forEach((h, i) => {
      obj[h] = cells[i] == null ? "" : cells[i]!.trim();
    });
    return obj;
  });
  const samples = objects.map(normalizeSample);
  const last = objects[objects.length - 1]!;
  const consistentText = (names: string[], lowercase = false) => {
    let declared = "";
    for (const obj of objects) {
      const raw = firstText(at(obj, names));
      const value = lowercase ? raw.toLowerCase() : raw;
      if (!value) continue;
      if (declared && declared !== value) throw new Error(`CSV 真机日志中的 ${names[0]} 在不同行之间不一致`);
      declared = value;
    }
    return declared;
  };
  return normalize(
    {
      format: "generic-machine-log-csv",
      job: {
        job_id: consistentText(["job_id", "job"]),
        machine_id: consistentText(["machine_id", "machine", "device_id"]),
        firmware: consistentText(["firmware", "firmware_version"]),
        slicer: consistentText(["slicer", "slicer_version"]),
        gcode_sha256: consistentText(["gcode_sha256", "gcode_sha", "gcode_hash"], true),
        duration_s: at(last, ["duration_s", "duration_sec"]),
        filament_mm: at(last, ["filament_mm", "filament_used_mm"]),
        filament_g: at(last, ["filament_g", "filament_used_g"]),
        completed_layers: at(last, ["completed_layers", "layer", "layers"]),
        status: at(last, ["status", "state", "result"]),
        energy_kwh: at(last, ["energy_kwh"]),
        energy_evidence: at(last, ["energy_evidence"]),
      },
      samples,
    },
    name
  );
}

export function parse(text: string, opt?: { name?: string }): MachineLogResult {
  opt = opt || {};
  const src = String(text || "");
  if (!src.trim()) throw new Error("真机日志为空");
  if (src.length > MAX_BYTES || new TextEncoder().encode(src).byteLength > MAX_BYTES)
    throw new Error("真机日志超过 " + Math.round(MAX_BYTES / 1024 / 1024) + "MB");
  const content = src.replace(/^\uFEFF/, "");
  const name = opt.name || "machine-log";
  const first = src.replace(/^\uFEFF/, "").trim()[0];
  if (first === "{" || first === "[") {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (e) {
      const parseError = new Error("真机日志 JSON 无效：" + (e as Error).message);
      (parseError as Error & { cause?: unknown }).cause = e;
      throw parseError;
    }
    if (Array.isArray(data)) data = { samples: data };
    if (!data || typeof data !== "object") throw new Error("真机日志 JSON 必须是对象");
    const record = data as RawRecord;
    if (record.format && record.format !== "forgex-machine-log")
      throw new Error("不支持的真机日志 format：" + String(record.format));
    if (record.version != null && record.version !== 1) throw new Error("不支持的真机日志 version");
    return normalize(record, name);
  }
  return parseCsvLog(content, name);
}

/** 核对当前导入 G-code 的原始字节摘要与真机日志声明。 */
export function verifyGcodeBinding(
  gcode: Pick<ParsedGcodeResult, "sha256"> | null | undefined,
  log: Pick<MachineLogResult, "gcodeSha256"> | null | undefined
): GcodeBindingResult {
  const expected = String((log && log.gcodeSha256) || "")
    .trim()
    .toLowerCase();
  const actual = String((gcode && gcode.sha256) || "")
    .trim()
    .toLowerCase();
  if (!expected) {
    return {
      verified: false,
      status: "missing",
      expected: "",
      actual,
      message: "真机日志未声明 gcodeSha256，本次对账未建立文件级绑定",
    };
  }
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    return { verified: false, status: "invalid", expected, actual, message: "真机日志中的 gcodeSha256 格式无效" };
  }
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    return { verified: false, status: "unavailable", expected, actual, message: "当前 G-code 尚未完成 SHA-256 计算" };
  }
  if (expected !== actual) {
    return {
      verified: false,
      status: "mismatch",
      expected,
      actual,
      message: "真机日志绑定的 G-code SHA-256 与当前文件不匹配",
    };
  }
  return {
    verified: true,
    status: "verified",
    expected,
    actual,
    message: "真机日志与当前 G-code 的 SHA-256 已验证一致",
  };
}

function comparison(
  name: string,
  planned: number,
  actual: number,
  unit: string,
  tolerance: number,
  note: string
): ComparisonRow {
  const rel = planned > 0 ? Math.abs(actual - planned) / planned : actual === 0 ? 0 : null;
  return {
    name,
    planned,
    actual,
    unit,
    relDiff: rel,
    agrees: rel !== null && rel <= tolerance,
    note,
  };
}

export function compare(gcode: ParsedGcodeResult, log: MachineLogResult): ComparisonRow[] {
  if (!gcode || !gcode.stats || !log) throw new Error("需要 G-code 解析结果与真机日志");
  const out: ComparisonRow[] = [];
  if (log.actualTimeSec != null)
    out.push(
      comparison(
        "任务时长",
        gcode.stats.timeSec,
        log.actualTimeSec,
        "秒",
        0.15,
        "G-code 侧是匀速运动估算；真机包含加速度、预热、换层、暂停与固件宏"
      )
    );
  if (log.filamentMm != null)
    out.push(
      comparison(
        "耗材长度",
        gcode.stats.filamentM * 1000,
        log.filamentMm,
        "mm",
        0.05,
        "计划值来自 G-code E 增量；实测值取自日志，传感器或固件口径可能不同"
      )
    );
  if (log.filamentG != null)
    out.push(
      comparison(
        "耗材克重",
        gcode.stats.filamentG,
        log.filamentG,
        "g",
        0.08,
        "两侧材料密度或称量方式不同会直接造成偏差"
      )
    );
  if (log.completedLayers != null)
    out.push(
      comparison(
        "完成层数",
        gcode.totalLayers,
        log.completedLayers,
        "层",
        0,
        "层数不足通常表示任务中止；日志层号起点不同也可能产生 1 层偏差"
      )
    );
  return out;
}
