import { reconcileMachineCost, type MachineCostRow } from "../../engine/machine-cost";
import type { GCodeCostEstimate } from "../../generated/forgex-api";
import type { MachineLogRecord } from "../../legacy/engine";

function value(number: number | null, unit: MachineCostRow["unit"]): string {
  if (number === null) return "未知";
  if (unit === "CNY")
    return Math.abs(number) > 0 && Math.abs(number) < 0.01
      ? `${number < 0 ? "−" : ""}不足 ¥0.01`
      : `¥${number.toFixed(2)}`;
  return `${number.toFixed(unit === "kWh" ? 6 : 2)} ${unit}`;
}

export function MachineCostComparison({
  estimate,
  log,
}: {
  readonly estimate: GCodeCostEstimate;
  readonly log: MachineLogRecord;
}) {
  let report;
  try {
    report = reconcileMachineCost(estimate, log);
  } catch (error) {
    return (
      <div className="note" role="status">
        {error instanceof Error ? error.message : "日志不能参与成本对账"}
      </div>
    );
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `forgex-cost-comparison-${estimate.basis.jobId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <section id="machine-cost-comparison" aria-label="真机日志成本对账">
      <div className="sec-label">计划估算 ↔ 日志核算</div>
      <div className="note">同一费率 · 每项依次显示计划与日志核算值，差值为日志减计划。</div>
      {report.rows.map((row) => (
        <div className="machine-cost-row" key={row.key} data-cost-comparison={row.key}>
          <strong>{row.label}</strong>
          <div>
            {value(row.planned, row.unit)} ↔ {value(row.recorded, row.unit)}
          </div>
          <div className="note">
            差值 {value(row.delta, row.unit)}
            {row.relativeDelta === null ? " · 无可用百分比基准" : ` · ${(row.relativeDelta * 100).toFixed(1)}%`}
          </div>
        </div>
      ))}
      <details className="machine-cost-evidence">
        <summary>查看计量依据与核算口径</summary>
        <div className="note">计量依据：{report.log.energyEvidence || "未提供"}</div>
        <div className="note">日志原件 {report.log.sha256.slice(0, 16)}…</div>
        {report.warnings.map((warning) => (
          <div className="note" key={warning}>
            {warning}
          </div>
        ))}
      </details>
      <button className="btn btn-ghost" type="button" onClick={download}>
        下载成本对账 JSON
      </button>
    </section>
  );
}
