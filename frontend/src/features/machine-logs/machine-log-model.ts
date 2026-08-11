import { legacyMachineLog } from "../../legacy/machine-log-adapter.js";
import { MACHINE_LOG_MAX_BYTES } from "./machine-log-limits";
import type {
  GcodeReconciliationPlan,
  LegacyMachineLogComparison,
  MachineLogBinding,
  MachineLogComparison,
  MachineLogMetricCode,
  MachineLogRecord,
} from "./machine-log-types";

const METRIC_BY_NAME: Readonly<Record<string, MachineLogMetricCode>> = {
  任务时长: "durationSec",
  耗材长度: "filamentMm",
  耗材克重: "filamentG",
  完成层数: "completedLayers",
};

if (legacyMachineLog.MAX_BYTES !== MACHINE_LOG_MAX_BYTES) {
  throw new Error("真机日志 Worker 与 legacy 文件上限不一致");
}

export function parseMachineLog(text: string, name: string): MachineLogRecord {
  return legacyMachineLog.parse(text, { name });
}

function stableComparison(comparison: LegacyMachineLogComparison): MachineLogComparison {
  const metric = METRIC_BY_NAME[comparison.name];
  if (!metric) throw new Error(`真机日志返回未知对账指标：${comparison.name}`);
  return { ...comparison, metric };
}

/**
 * Binding is the invariant for reconciliation. The legacy numerical formulas
 * remain the only implementation; this layer adds stable metric identifiers
 * and prevents an unbound log from reaching them.
 */
export function reconcileMachineLog(
  log: MachineLogRecord,
  plan: GcodeReconciliationPlan
): { readonly binding: MachineLogBinding; readonly comparisons: readonly MachineLogComparison[] } {
  const binding = legacyMachineLog.verifyGcodeBinding({ sha256: plan.gcodeSha256 }, log);
  if (!binding.verified) return { binding, comparisons: [] };

  const legacyPlan = {
    totalLayers: plan.totalLayers,
    stats: {
      timeSec: plan.estimatedTimeSec,
      filamentM: plan.filamentMm / 1000,
      filamentG: plan.filamentG ?? undefined,
    },
  };
  const comparableLog = plan.filamentG == null ? { ...log, filamentG: null } : log;
  return {
    binding,
    comparisons: legacyMachineLog.compare(legacyPlan, comparableLog).map(stableComparison),
  };
}
