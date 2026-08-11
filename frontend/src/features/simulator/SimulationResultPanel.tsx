import type { QuickSimulationResult, QuickSimulationState } from "./simulator-types";

export interface SimulationResultPanelProps {
  readonly state: QuickSimulationState;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly runDisabled?: boolean;
}

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  return hours ? `${hours} 小时 ${minutes} 分 ${rest} 秒` : `${minutes} 分 ${rest} 秒`;
}

function Result({ result }: { readonly result: QuickSimulationResult }) {
  const summary = result.summary;
  return (
    <>
      <div className="simulator-engine-line">
        <span>{result.engine.name}</span>
        <code>{result.engine.version}</code>
        <span>运行 {formatNumber(result.runtimeMs, 1)} ms</span>
      </div>

      <p className="simulator-input-snapshot">
        输入快照：{result.model.name} · {result.input.machineProfile.id} · {result.input.materialProfile.id} · 层高{" "}
        {formatNumber(result.input.settings.layerHeight)} mm · 填充{" "}
        {formatNumber(result.input.settings.infillDensity * 100, 0)}% · {result.input.settings.speed} mm/s
      </p>

      <div className="simulator-kpis" aria-label="即时预览关键结果">
        <article>
          <span>层 / 路径</span>
          <strong>
            {summary.totalLayers} / {summary.pathCount}
          </strong>
        </article>
        <article>
          <span>模型高度</span>
          <strong>{formatNumber(summary.heightMm)} mm</strong>
        </article>
        <article>
          <span>预计总时长</span>
          <strong>{formatDuration(summary.estimatedTimeSeconds)}</strong>
        </article>
        <article>
          <span>耗材</span>
          <strong>{formatNumber(summary.filamentMassG)} g</strong>
          <small>{formatNumber(summary.filamentLengthM, 3)} m</small>
        </article>
        <article>
          <span>体积 / 材料成本</span>
          <strong>{formatNumber(summary.volumeCm3, 3)} cm³</strong>
          <small>¥{formatNumber(summary.materialCostCny, 2)}</small>
        </article>
        <article>
          <span>路径 / 空驶</span>
          <strong>
            {formatNumber(summary.extrusionLengthMm / 1000, 2)} / {formatNumber(summary.travelLengthMm / 1000, 2)} m
          </strong>
        </article>
      </div>

      <section className="simulator-evidence" aria-labelledby="simulator-evidence-heading">
        <h3 id="simulator-evidence-heading">计算证据与边界</h3>
        <div className="simulator-table-scroll">
          <table aria-label="即时预览计算证据">
            <thead>
              <tr>
                <th scope="col">证据</th>
                <th scope="col">值</th>
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              {result.evidence.map((item) => (
                <tr key={item.code}>
                  <th scope="row">固定流程开销</th>
                  <td>
                    {item.value} {item.unit}
                  </td>
                  <td>{item.note}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">路径运动时间</th>
                <td>{formatDuration(summary.pathTimeSeconds)}</td>
                <td>按预览路径长度与名义速度计算</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="simulator-quality" aria-labelledby="simulator-quality-heading">
        <h3 id="simulator-quality-heading">参数质量证据</h3>
        <div className="simulator-table-scroll">
          <table aria-label="即时预览质量证据">
            <thead>
              <tr>
                <th scope="col">检查项</th>
                <th scope="col">评分</th>
                <th scope="col">等级</th>
                <th scope="col">依据</th>
              </tr>
            </thead>
            <tbody>
              {result.quality.map((finding) => (
                <tr key={finding.name} data-level={finding.level}>
                  <th scope="row">{finding.name}</th>
                  <td>{finding.score}</td>
                  <td>{finding.level === "good" ? "良好" : finding.level === "mid" ? "关注" : "风险"}</td>
                  <td>{finding.tip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="simulator-warnings" aria-labelledby="simulator-warnings-heading">
        <h3 id="simulator-warnings-heading">预览限制</h3>
        <ul>
          {result.warnings.map((warning) => (
            <li key={warning.code}>
              <code>{warning.code}</code> {warning.message}
            </li>
          ))}
        </ul>
      </aside>
    </>
  );
}

export function SimulationResultPanel({ state, onRun, onCancel, runDisabled = false }: SimulationResultPanelProps) {
  const running = state.status === "running";
  const hasResult = state.result !== null;
  return (
    <section className="panel simulator-results" aria-labelledby="simulator-result-heading" aria-busy={running}>
      <div className="simulator-result-heading">
        <div>
          <p className="eyebrow">PREVIEW RESULT / LOCAL WORKER</p>
          <h2 id="simulator-result-heading">即时计算结果</h2>
        </div>
        <span className="simulator-authority-badge">浏览器即时预览（非权威）</span>
      </div>

      <div className="simulator-runbar">
        <div className="simulator-run-status" role="status" aria-live="polite">
          {running ? (
            <>
              <strong>
                {state.stage || "正在计算"}
                {hasResult ? "；下方暂留上次结果。" : ""}
              </strong>
              <progress aria-label="模拟计算进度" max={1} value={state.progress} />
              <span>{Math.round(state.progress * 100)}%</span>
            </>
          ) : state.status === "stale" ? (
            <strong>参数已变化，以下结果已经过期；300 ms 后会自动刷新。</strong>
          ) : state.status === "error" ? (
            <strong>计算失败：{state.error || state.errorCode}</strong>
          ) : state.status === "cancelled" ? (
            <strong>本次计算已取消。</strong>
          ) : state.status === "success" ? (
            <strong>预览计算完成。</strong>
          ) : (
            <strong>填写参数后自动计算，也可以立即运行。</strong>
          )}
        </div>
        {running ? (
          <button type="button" className="simulator-secondary-action" onClick={onCancel}>
            取消计算
          </button>
        ) : (
          <button type="button" className="simulator-primary-action" onClick={onRun} disabled={runDisabled}>
            立即重新计算
          </button>
        )}
      </div>

      {state.status === "error" ? (
        <p className="simulator-error" role="alert">
          {state.error || "即时预览计算失败"}
        </p>
      ) : null}
      {hasResult ? (
        <Result result={state.result!} />
      ) : (
        <p className="simulator-empty">暂无结果。有效参数会在 300 ms 防抖后提交到本地 Worker。</p>
      )}
    </section>
  );
}
