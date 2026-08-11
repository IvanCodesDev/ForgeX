import { type ChangeEvent, type DragEvent } from "react";
import type { GcodeReconciliationPlan, MachineLogComparison } from "./machine-log-types";
import { useMachineLogWorker } from "./useMachineLogWorker";

interface MachineLogPanelProps {
  readonly plan: GcodeReconciliationPlan | null;
  readonly gcodeRevision: number | string;
  readonly disabledReason: string;
}

const BINDING_LABELS = {
  verified: "已验证",
  missing: "缺少摘要",
  invalid: "摘要无效",
  unavailable: "G-code 摘要未就绪",
  mismatch: "摘要不匹配",
} as const;

function number(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function metricValue(value: number, comparison: MachineLogComparison): string {
  if (comparison.metric === "durationSec") return `${number(value, 1)} 秒`;
  if (comparison.metric === "filamentG") return `${number(value, 3)} g`;
  return `${number(value, comparison.metric === "completedLayers" ? 0 : 2)} ${comparison.unit}`;
}

export function MachineLogPanel({ plan, gcodeRevision, disabledReason }: MachineLogPanelProps) {
  const { state, parseFile, cancel, reset } = useMachineLogWorker(gcodeRevision);

  const acceptFile = (file: File | null) => {
    if (file && plan) parseFile(file, plan);
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    if (plan) acceptFile(event.dataTransfer.files[0] ?? null);
  };

  const imported = state.result;
  const binding = imported?.binding ?? null;

  return (
    <section className="panel" aria-labelledby="machine-log-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">MACHINE LOG / SHA-256 BINDING</p>
          <h2 id="machine-log-heading">真机日志与计划/实测对账</h2>
        </div>
        {imported ? (
          <button className="reset-button" type="button" onClick={reset}>
            清除日志
          </button>
        ) : null}
      </div>

      <p className="muted">
        日志在 Web Worker 中解析并计算内容摘要；只有日志声明的 G-code SHA-256 与当前原始文件一致时才生成对账。
      </p>

      <label
        className="gcode-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        aria-disabled={!plan}
      >
        <input
          type="file"
          accept=".json,.csv,application/json,text/csv"
          disabled={!plan}
          onChange={onInput}
          aria-label="选择真机日志"
        />
        <strong>{plan ? "选择或拖入真机日志" : "等待 G-code 摘要与权威计划"}</strong>
        <span>{plan ? "最大 20 MB · JSON / CSV" : disabledReason}</span>
      </label>

      {state.status !== "idle" ? (
        <div className="worker-status" role="status" aria-live="polite">
          <div>
            <span>{state.stage}</span>
            <span>{Math.round(state.progress * 100)}%</span>
          </div>
          <progress max="1" value={state.progress} />
          {state.status === "reading" || state.status === "parsing" ? (
            <button type="button" onClick={cancel}>
              取消日志解析
            </button>
          ) : null}
          {state.status === "error" ? (
            <p className="error-copy">
              <code>{state.errorCode}</code> · {state.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {imported && binding ? (
        <>
          <div className="gcode-evidence">
            <p>
              <span>真机日志</span>
              <code>
                {imported.log.name} · {imported.log.status}
              </code>
            </p>
            <p>
              <span>日志内容 SHA-256</span>
              <code>{imported.file.sha256}</code>
            </p>
            <p>
              <span>G-code 绑定</span>
              <code>
                {BINDING_LABELS[binding.status]} · {binding.verified ? "verified" : binding.status}
              </code>
            </p>
            <p>
              <span>日志声明 / 当前 G-code</span>
              <code>
                {binding.expected || "missing"} / {binding.actual || "unavailable"}
              </code>
            </p>
            <p>
              <span>计划口径</span>
              <code>
                {imported.plan.provenance === "dotnet-authority" ? "C# 权威" : "浏览器预览"} ·{" "}
                {imported.plan.engineVersion}
              </code>
            </p>
            {imported.log.machineId || imported.log.firmware ? (
              <p>
                <span>设备 / 固件</span>
                <code>
                  {imported.log.machineId || "未声明"} / {imported.log.firmware || "未声明"}
                </code>
              </p>
            ) : null}
          </div>

          {binding.verified ? (
            <table aria-label="真机日志计划与实测对账">
              <thead>
                <tr>
                  <th scope="col">指标</th>
                  <th scope="col">计划</th>
                  <th scope="col">实测</th>
                  <th scope="col">相对差异</th>
                  <th scope="col">判定</th>
                </tr>
              </thead>
              <tbody>
                {imported.comparisons.map((comparison) => (
                  <tr key={comparison.metric}>
                    <th scope="row">{comparison.name}</th>
                    <td>{metricValue(comparison.planned, comparison)}</td>
                    <td>{metricValue(comparison.actual, comparison)}</td>
                    <td>{number(comparison.relDiff * 100, 1)}%</td>
                    <td>{comparison.agrees ? "容差内" : "超出容差"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="error-copy" role="alert">
              {binding.message}。本次日志仅完成解析，未生成计划/实测对账。
            </p>
          )}

          {imported.log.warnings.length ? (
            <ul className="warning-list" aria-label="真机日志警告">
              {imported.log.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
