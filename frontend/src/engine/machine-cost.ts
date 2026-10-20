import type { GCodeCostEstimate } from "../generated/forgex-api";
import type { MachineLogRecord } from "../legacy/engine";

export interface MachineCostRow {
  readonly key: string;
  readonly label: string;
  readonly unit: "s" | "g" | "kWh" | "CNY";
  readonly planned: number | null;
  readonly recorded: number | null;
  readonly delta: number | null;
  /** 计划为零时不制造百分比；绝对差值仍保留。 */
  readonly relativeDelta: number | null;
}

export interface MachineCostComparison {
  readonly schemaVersion: "1.0";
  readonly modelVersion: "forgex-machine-cost-comparison/1";
  readonly estimate: GCodeCostEstimate;
  readonly log: {
    readonly name: string;
    readonly sha256: string;
    readonly gcodeSha256: string;
    readonly jobId: string;
    readonly machineId: string;
    readonly firmware: string;
    readonly status: string;
    readonly durationSeconds: number | null;
    readonly filamentMassG: number | null;
    readonly energyKwh: number | null;
    readonly energyEvidence: string;
  };
  readonly rows: readonly MachineCostRow[];
  readonly warnings: readonly string[];
}

/** 按已声明费率核算日志记录；不推断电表读数，不将浮点核算结果当作结算账单。 */
export function reconcileMachineCost(estimate: GCodeCostEstimate, log: MachineLogRecord): MachineCostComparison {
  if (
    !/^[a-f0-9]{64}$/.test(log.sourceSha256) ||
    !/^[a-f0-9]{64}$/.test(log.gcodeSha256) ||
    log.gcodeSha256 !== estimate.basis.inputSha256 ||
    !log.gcodeBinding?.verified
  )
    throw new Error("成本对账需要与当前 G-code 摘要匹配、且已计算原件摘要的真机日志");
  for (const [value, maximum] of [
    [log.actualTimeSec, 31536000],
    [log.filamentG, 1000000],
    [log.energyKwh, 1000000],
  ] as const)
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum))
      throw new Error("日志时长、克重或能耗超出成本核算范围");
  const energy = log.energyKwh !== null && log.energyEvidence.trim() ? log.energyKwh : null;
  const { electricityCnyPerKwh, materialCnyPerKg, machineCnyPerHour } = estimate.inputs;
  const material =
    log.filamentG === null || materialCnyPerKg === null ? null : (log.filamentG * materialCnyPerKg) / 1000;
  const electricity = energy === null || electricityCnyPerKwh === null ? null : energy * electricityCnyPerKwh;
  const machine =
    log.actualTimeSec === null || machineCnyPerHour === null ? null : (log.actualTimeSec * machineCnyPerHour) / 3600;
  const total = material === null || electricity === null || machine === null ? null : material + electricity + machine;
  const row = (
    key: string,
    label: string,
    unit: MachineCostRow["unit"],
    planned: number | null,
    recorded: number | null
  ): MachineCostRow => ({
    key,
    label,
    unit,
    planned,
    recorded,
    delta: planned === null || recorded === null ? null : recorded - planned,
    relativeDelta: planned === null || recorded === null || planned === 0 ? null : (recorded - planned) / planned,
  });
  return {
    schemaVersion: "1.0",
    modelVersion: "forgex-machine-cost-comparison/1",
    estimate,
    log: {
      name: log.name,
      sha256: log.sourceSha256,
      gcodeSha256: log.gcodeSha256,
      jobId: log.jobId ?? "",
      machineId: log.machineId ?? "",
      firmware: log.firmware ?? "",
      status: log.status,
      durationSeconds: log.actualTimeSec,
      filamentMassG: log.filamentG,
      energyKwh: log.energyKwh,
      energyEvidence: log.energyEvidence,
    },
    rows: [
      row("duration", "任务时长", "s", estimate.basis.durationSeconds, log.actualTimeSec),
      row("filament", "耗材克重", "g", estimate.basis.filamentMassG, log.filamentG),
      row("energy", "能耗", "kWh", estimate.totals.energyKwh, energy),
      row("material", "材料成本", "CNY", estimate.totals.materialCostCny, material),
      row("electricity", "电费", "CNY", estimate.totals.electricityCostCny, electricity),
      row("machine", "机时成本", "CNY", estimate.totals.machineTimeCostCny, machine),
      row("total", "总成本", "CNY", estimate.totals.totalCostCny, total),
    ],
    warnings: [
      "按同一组声明费率核算日志记录；日志与计量依据由用户提供，文件摘要只证明文件绑定，不核实记录真实性。",
      "日志时长可能含预热、暂停和待机；G-code 计划按运动时长估算。能耗必须是该任务的消耗量，不是累计电表读数。",
      "日志核算使用浏览器浮点数，导出保留计算值；显示金额四舍五入至分，不作为结算账单。",
      ...(energy === null ? ["缺少能耗消耗量或计量依据，电费与总成本保持未知。"] : []),
      ...(!(log.actualTimeSec !== null && log.filamentG !== null)
        ? ["日志缺少任务时长或耗材克重，相关分项与总成本保持未知。"]
        : []),
      `日志任务状态：${log.status || "unknown"}。失败、取消或未完成任务的记录可能只覆盖部分作业。`,
      ...log.warnings,
    ],
  };
}
