import { useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import { GcodeViewer } from "./GcodeViewer";
import { selectEffectiveSummary } from "./gcode-authority";
import type { GcodeParseOptions } from "./gcode-types";
import { useGcodeAuthority } from "./useGcodeAuthority";
import { useGcodeWorker } from "./useGcodeWorker";

function number(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

export function GcodePage() {
  const { state, parseFile, cancel, reset } = useGcodeWorker();
  const [file, setFile] = useState<File | null>(null);
  const [bedSize, setBedSize] = useState(256);
  const [densityG, setDensityG] = useState(1.24);
  const [origin, setOrigin] = useState<GcodeParseOptions["origin"]>("corner");
  const [submittedOptions, setSubmittedOptions] = useState<GcodeParseOptions>({
    bedSize: 256,
    densityG: 1.24,
    origin: "corner",
  });
  const [selectedLayer, setSelectedLayer] = useState(0);

  const options = useMemo<GcodeParseOptions>(() => ({ bedSize, densityG, origin }), [bedSize, densityG, origin]);
  const result = state.result;
  const authority = useGcodeAuthority(file, submittedOptions, result);
  const layer = result?.layers[selectedLayer] ?? null;
  const effectiveSummary = selectEffectiveSummary(authority.mode, authority.status, result, authority.result);
  const primaryWarnings =
    effectiveSummary?.provenance === "dotnet-authority"
      ? (authority.result?.warnings.map((warning) => `${warning.code} · ${warning.message}`) ?? [])
      : (result?.warnings ?? []);

  const summaryLabel = (() => {
    if (effectiveSummary?.provenance === "dotnet-authority") return "C# 权威结果";
    if (authority.mode === "dotnet") return "浏览器临时预览 · C# 权威未完成";
    if (authority.mode === "shadow") {
      return authority.status === "done"
        ? "浏览器即时预览 · C# Shadow 仅作差异对照"
        : "浏览器即时预览 · C# Shadow 对照未完成";
    }
    return "浏览器即时预览（非权威）";
  })();

  useEffect(() => setSelectedLayer(0), [result]);

  const acceptFile = (next: File | null) => {
    if (!next) return;
    setFile(next);
    setSubmittedOptions(options);
    void parseFile(next, options);
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFile(event.target.files?.[0] ?? null);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    acceptFile(event.dataTransfer.files[0] ?? null);
  };

  const reparseCurrentFile = () => {
    if (!file) return;
    setSubmittedOptions(options);
    void parseFile(file, options);
  };

  const authorityStatusPanel =
    authority.mode !== "browser" && file ? (
      <section className="panel authority-panel" role="status" aria-live="polite">
        <div>
          <p className="eyebrow">C# AUTHORITY / {authority.mode.toUpperCase()}</p>
          <h2>
            {authority.mode === "shadow"
              ? authority.status === "done"
                ? "C# Shadow 对照完成"
                : "C# Shadow 对照未完成"
              : authority.status === "done"
                ? "C# 权威结果已生效"
                : "C# 权威未完成"}
          </h2>
        </div>
        {authority.status === "running" ? (
          <>
            <p className="muted">
              {authority.mode === "dotnet"
                ? "C# 权威未完成；浏览器结果仅作临时预览。"
                : "浏览器即时预览保持主结果；C# Shadow 正在并行对照。"}
            </p>
            <button className="reset-button" type="button" onClick={authority.cancel}>
              取消 C# 分析
            </button>
          </>
        ) : null}
        {authority.status === "error" ? (
          <p className="error-copy">
            {authority.mode === "dotnet"
              ? "浏览器结果仅作临时预览；C# 权威未完成："
              : "浏览器即时预览保持主结果；C# Shadow 对照未完成："}
            {authority.error}
          </p>
        ) : null}
        {authority.status === "done" && authority.result && !authority.diff ? (
          <p className="muted">
            {authority.mode === "dotnet"
              ? "C# 权威结果已返回；浏览器分层可视化抽样完成后再计算差异。"
              : "C# Shadow 结果已返回；浏览器预览完成后再计算差异，主摘要仍使用浏览器预览。"}
          </p>
        ) : null}
        {authority.result && authority.diff ? (
          <div className="authority-grid">
            <p>
              <span>引擎</span>
              <code>{authority.result.engine.version}</code>
            </p>
            <p>
              <span>原始 SHA</span>
              <code>{authority.diff.sha256Matches ? "match" : "mismatch"}</code>
            </p>
            <p>
              <span>契约 / 输入 / 参数</span>
              <code>
                {authority.diff.engineMatches &&
                authority.diff.contractMatches &&
                authority.diff.inputMatches &&
                authority.diff.parametersMatch
                  ? "match"
                  : "mismatch"}
              </code>
            </p>
            <p>
              <span>字段差异</span>
              <code>
                {authority.diff.fields.filter((field) => !field.pass).length} failed / {authority.diff.fields.length}
              </code>
            </p>
            <p>
              <span>切换判定</span>
              <code>
                {authority.mode === "dotnet"
                  ? authority.diff.pass
                    ? "C# authority active"
                    : "C# authority active · review drift"
                  : authority.diff.pass
                    ? "browser preview retained · shadow match"
                    : "browser preview retained · review drift"}
              </code>
            </p>
          </div>
        ) : null}
        {authority.diff && !authority.diff.pass ? (
          <ul className="warning-list">
            {!authority.diff.engineMatches ? <li>C# 引擎版本或来源与 G-code 权威契约不一致</li> : null}
            {!authority.diff.contractMatches ? <li>C# schemaVersion 与前端契约不一致</li> : null}
            {!authority.diff.inputMatches ? <li>C# bytesRead 与浏览器文件字节数不一致</li> : null}
            {!authority.diff.parametersMatch ? <li>C# 返回参数与本次提交参数不一致</li> : null}
            {authority.diff.fields
              .filter((field) => !field.pass)
              .slice(0, 6)
              .map((field) => (
                <li key={field.field}>
                  {field.field}: Δ {number(field.absoluteDelta, 6)} &gt; {number(field.limit, 6)}
                </li>
              ))}
          </ul>
        ) : null}
      </section>
    ) : null;

  return (
    <div className="gcode-page page-stack">
      <section className="panel gcode-controls">
        <div>
          <p className="eyebrow">REACT VERTICAL SLICE / WEB WORKER / {authority.mode.toUpperCase()}</p>
          <h1>G-code 权威摘要前的即时预览</h1>
          <p className="muted">原始字节在 Worker 中计算 SHA-256 并解析；主线程只接收受限的分层路径数据。</p>
        </div>
        <div className="gcode-options">
          <label>
            平台尺寸（mm）
            <input
              type="number"
              min="80"
              max="1000"
              value={bedSize}
              onChange={(event) => setBedSize(Number(event.target.value))}
            />
          </label>
          <label>
            材料密度（g/cm³）
            <input
              type="number"
              min="0.5"
              max="3"
              step="0.01"
              value={densityG}
              onChange={(event) => setDensityG(Number(event.target.value))}
            />
          </label>
          <label>
            坐标原点
            <select value={origin} onChange={(event) => setOrigin(event.target.value as GcodeParseOptions["origin"])}>
              <option value="corner">床角</option>
              <option value="center">床心（Delta）</option>
            </select>
          </label>
        </div>
        <label className="gcode-drop" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <input type="file" accept=".gcode,.gco,.gc,text/plain" onChange={onInput} />
          <strong>{file ? file.name : "选择或拖入 G-code"}</strong>
          <span>{file ? `${number(file.size / 1024, 1)} KB` : "最大 64 MB · .gcode / .gco / .gc"}</span>
        </label>
        {state.status !== "idle" ? (
          <div className="worker-status" aria-live="polite">
            <div>
              <span>{state.stage}</span>
              <span>{Math.round(state.progress * 100)}%</span>
            </div>
            <progress max="1" value={state.progress} />
            {state.status === "reading" || state.status === "parsing" ? (
              <button type="button" onClick={cancel}>
                取消
              </button>
            ) : null}
            {state.status === "error" ? (
              <p className="error-copy">
                <code>{state.errorCode}</code> · {state.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {authorityStatusPanel}

      {effectiveSummary ? (
        <>
          <p className="eyebrow" role="status" aria-live="polite">
            摘要口径：{summaryLabel}
          </p>
          <section className="gcode-metrics" aria-label={`G-code 摘要：${summaryLabel}`}>
            <article>
              <span>层数</span>
              <strong>{effectiveSummary.totalLayers}</strong>
              <small>{number(effectiveSummary.heightMm)} mm</small>
            </article>
            <article>
              <span>路径长度</span>
              <strong>{number(effectiveSummary.extrusionLengthMm / 1000)} m</strong>
              <small>空驶 {number(effectiveSummary.travelLengthMm / 1000)} m</small>
            </article>
            <article>
              <span>预计时长</span>
              <strong>{duration(effectiveSummary.estimatedTimeSeconds)}</strong>
              <small>{effectiveSummary.provenance === "dotnet-authority" ? "C# 引擎权威口径" : "浏览器估算口径"}</small>
            </article>
            <article>
              <span>耗材</span>
              <strong>{number(effectiveSummary.filamentLengthM)} m</strong>
              <small>
                {effectiveSummary.filamentMassG == null ? "—" : `${number(effectiveSummary.filamentMassG)} g`}
              </small>
            </article>
          </section>

          <div className="gcode-evidence">
            <p>
              <span>{effectiveSummary.provenance === "dotnet-authority" ? "权威 SHA-256" : "预览 SHA-256"}</span>
              <code>{effectiveSummary.sha256}</code>
            </p>
            <p>
              <span>摘要边界</span>
              <code>
                X {number(effectiveSummary.bounds.minX)}–{number(effectiveSummary.bounds.maxX)} mm · Y{" "}
                {number(effectiveSummary.bounds.minY)}–{number(effectiveSummary.bounds.maxY)} mm · {summaryLabel}
              </code>
            </p>
          </div>
          {primaryWarnings.length ? (
            <ul className="warning-list" aria-label={`${summaryLabel}警告`}>
              {primaryWarnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {result ? (
        <section className="panel gcode-result">
          <div className="viewer-toolbar">
            <div>
              <p className="eyebrow">BROWSER LAYER VISUALIZATION SAMPLE</p>
              <h2>
                浏览器可视化抽样 · 第 {selectedLayer + 1} / {result.totalLayers} 层
              </h2>
            </div>
            <label>
              层{" "}
              <input
                type="range"
                min="0"
                max={Math.max(0, result.layers.length - 1)}
                value={selectedLayer}
                onInput={(event) => setSelectedLayer(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <GcodeViewer layer={layer} bounds={effectiveSummary?.bounds ?? result.bounds} />
          <div className="gcode-evidence">
            <p>
              <span>浏览器抽样层</span>
              <code>
                Z {number(layer?.z ?? 0)} mm · {layer?.sourcePathCount ?? 0} paths · {layer?.sourcePointCount ?? 0}{" "}
                points
              </code>
            </p>
            <p>
              <span>预览预算</span>
              <code>
                {number(result.previewSegments, 0)} / {number(result.sourceSegments, 0)} segments
                {result.previewTruncated ? " · browser sampled" : " · browser complete"}
              </code>
            </p>
          </div>
          <div className="result-actions">
            <button className="reset-button" type="button" onClick={reparseCurrentFile}>
              按当前参数重新解析
            </button>
            <button
              className="reset-button"
              type="button"
              onClick={() => {
                setFile(null);
                reset();
              }}
            >
              清除结果
            </button>
          </div>
        </section>
      ) : effectiveSummary?.provenance === "dotnet-authority" ? (
        <section className="panel" role="status" aria-live="polite">
          <p className="eyebrow">BROWSER LAYER VISUALIZATION SAMPLE</p>
          <h2>3D 浏览器抽样尚未完成</h2>
          <p className="muted">C# 权威摘要已返回；Worker 分层路径仅用于浏览器可视化抽样，完成后将在此显示。</p>
        </section>
      ) : null}
    </div>
  );
}
