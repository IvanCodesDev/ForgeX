import type { MachineLogResult } from "./machine-log";

export interface SampleRange {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
}
export interface MachineLogTelemetrySummary {
  readonly sampleCount: number;
  readonly timeSec: SampleRange;
  readonly nozzleC: SampleRange;
  readonly bedC: SampleRange;
}
export type MachineLogSummary = Omit<MachineLogResult, "samples"> & {
  readonly telemetry: MachineLogTelemetrySummary;
};

/** 后台保留完整解析校验，仅回传常量大小的遥测汇总，避免主线程克隆百万条对象。 */
export function summarizeMachineLog(parsed: MachineLogResult): MachineLogSummary {
  const range = (): { count: number; min: number | null; max: number | null } => ({ count: 0, min: null, max: null });
  const timeSec = range(),
    nozzleC = range(),
    bedC = range();
  const add = (target: ReturnType<typeof range>, value: number | null) => {
    if (value === null) return;
    target.count++;
    target.min = target.min === null ? value : Math.min(target.min, value);
    target.max = target.max === null ? value : Math.max(target.max, value);
  };
  for (const sample of parsed.samples) {
    add(timeSec, sample.timeSec);
    add(nozzleC, sample.nozzleC);
    add(bedC, sample.bedC);
  }
  const { samples, ...log } = parsed;
  return { ...log, telemetry: { sampleCount: samples.length, timeSec, nozzleC, bedC } };
}
