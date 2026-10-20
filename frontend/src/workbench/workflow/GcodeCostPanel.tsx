import { useEffect, useRef, useState, type FormEvent } from "react";
import { COST_LIMITS, requestCostEstimate, type CostField } from "../../authority/gcode-cost";
import type { AuthorityAnalysisResponse } from "../../authority/gcode-authority";
import type { GCodeCostEstimate, GCodeCostInputs } from "../../generated/forgex-api";
import "./gcode-cost.css";
import type { MachineLogState } from "../../legacy/engine";
import { MachineCostComparison } from "./MachineCostComparison";

const LABELS: Record<CostField, string> = {
  averagePowerWatts: "平均功率 W",
  electricityCnyPerKwh: "电价 元/kWh",
  machineCnyPerHour: "纯机时费 元/h",
  materialCnyPerKg: "材料单价 元/kg",
};
const money = (value: number | null) =>
  value === null ? "未配置" : value > 0 && value < 0.01 ? "低于 ¥0.01" : `¥${value.toFixed(2)}`;

export function GcodeCostPanel({
  jobId,
  source,
  machineLog,
}: {
  readonly jobId: string;
  readonly source: AuthorityAnalysisResponse;
  readonly machineLog: MachineLogState | null;
}) {
  const [fields, setFields] = useState<Record<CostField, string>>({
    averagePowerWatts: "",
    electricityCnyPerKwh: "",
    machineCnyPerHour: "",
    materialCnyPerKg: "",
  });
  const [evidence, setEvidence] = useState("");
  const [result, setResult] = useState<GCodeCostEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    []
  );
  const invalidate = () => {
    pending.current?.abort();
    pending.current = null;
    setResult(null);
    setError(null);
    setBusy(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    invalidate();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    const inputs: GCodeCostInputs = {
      averagePowerWatts: fields.averagePowerWatts.trim() ? Number(fields.averagePowerWatts) : null,
      electricityCnyPerKwh: fields.electricityCnyPerKwh.trim() ? Number(fields.electricityCnyPerKwh) : null,
      machineCnyPerHour: fields.machineCnyPerHour.trim() ? Number(fields.machineCnyPerHour) : null,
      materialCnyPerKg: fields.materialCnyPerKg.trim() ? Number(fields.materialCnyPerKg) : null,
      evidence,
    };
    try {
      const estimate = await requestCostEstimate(jobId, source, inputs, import.meta.env, controller.signal);
      if (!controller.signal.aborted) setResult(estimate);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "成本估算失败");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `forgex-cost-${jobId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <details id="gcode-cost-panel" data-react-only="gcode-cost">
      <summary>能耗与机时成本估算</summary>
      <form
        className="gcode-summary gcode-cost-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="note">填写该作业的平均功率与费率；空白表示未知，0 表示明确为零。机时费应排除材料和电费。</div>
        {(Object.keys(LABELS) as CostField[]).map((field) => (
          <label key={field}>
            <span>{LABELS[field]}</span>
            <input
              aria-label={LABELS[field]}
              data-cost-input={field}
              type="number"
              min="0"
              max={COST_LIMITS[field]}
              step="any"
              value={fields[field]}
              onChange={(event) => {
                invalidate();
                setFields((current) => ({ ...current, [field]: event.target.value }));
              }}
            />
          </label>
        ))}
        <label>
          <span>输入依据</span>
          <textarea
            aria-label="成本输入依据"
            maxLength={500}
            required={Object.values(fields).some(Boolean)}
            placeholder="平均功率测量记录、费率日期及来源"
            value={evidence}
            onChange={(event) => {
              invalidate();
              setEvidence(event.target.value);
            }}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "估算中…" : "计算成本"}
        </button>
        {error && (
          <div className="note" role="alert">
            {error}
          </div>
        )}
        {result && (
          <div id="gcode-cost-result" data-cost-complete={String(result.totals.isComplete)}>
            <div className="kv">
              <span className="k">估算能耗</span>
              <span className="v">
                {result.totals.energyKwh === null ? "未配置" : `${result.totals.energyKwh.toFixed(9)} kWh`}
              </span>
            </div>
            {(
              [
                ["耗材成本", result.totals.materialCostCny],
                ["电费", result.totals.electricityCostCny],
                ["机时成本", result.totals.machineTimeCostCny],
              ] as const
            ).map(([label, value]) => (
              <div className="kv" key={label}>
                <span className="k">{label}</span>
                <span className="v">{money(value)}</span>
              </div>
            ))}
            <div className="kv">
              <span className="k">总成本估算</span>
              <span className="v hl">
                {result.totals.totalCostCny === null ? "输入不完整" : money(result.totals.totalCostCny)}
              </span>
            </div>
            {!!result.missingInputs.length && (
              <div className="note">
                缺少：{result.missingInputs.map((key) => LABELS[key as CostField]).join("、")}。不提供总成本。
              </div>
            )}
            {result.warnings.map((warning) => (
              <div className="note" key={warning}>
                {warning}
              </div>
            ))}
            <div className="note">
              成本指纹 {result.fingerprint.slice(0, 16)}… · 原件 {result.basis.inputSha256.slice(0, 12)}…
            </div>
            <button className="btn btn-ghost" type="button" onClick={download}>
              下载成本审计 JSON
            </button>
            {machineLog && <MachineCostComparison estimate={result} log={machineLog.log} />}
          </div>
        )}
      </form>
    </details>
  );
}
