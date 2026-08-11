import { lazy, Suspense, useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import type { FeatureFlags } from "../../app/runtime/feature-flags";
import { MachineLogPanel } from "../machine-logs/MachineLogPanel";
import type { GcodeReconciliationPlan } from "../machine-logs/machine-log-types";
import { ProfileSelector } from "../profiles/ProfileSelector";
import { useProfileSelection } from "../profiles/useProfileSelection";
import { decodeAuthorityToolpathLayer } from "./authority-toolpath";
import { selectEffectiveSummary } from "./gcode-authority";
import type { GcodeParseOptions } from "./gcode-types";
import { useGcodeAuthority } from "./useGcodeAuthority";
import { useGcodeWorker } from "./useGcodeWorker";

const GcodeViewer = lazy(() => import("./GcodeViewer").then((module) => ({ default: module.GcodeViewer })));

function number(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

export interface GcodePageProps {
  readonly featureFlags: Pick<FeatureFlags, "machineLogReact" | "profileSelectorReact">;
}

export function GcodePage({ featureFlags }: GcodePageProps) {
  const { state, parseFile, cancel, reset } = useGcodeWorker();
  const profile = useProfileSelection();
  const [file, setFile] = useState<File | null>(null);
  const [bedSize, setBedSize] = useState(256);
  const [densityG, setDensityG] = useState(1.24);
  const [origin, setOrigin] = useState<GcodeParseOptions["origin"]>("corner");
  const [submittedOptions, setSubmittedOptions] = useState<GcodeParseOptions>({
    bedSize: 256,
    densityG: 1.24,
    origin: "corner",
    machineProfileId: "unspecified-machine",
    materialProfileId: "unspecified-material",
  });
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [gcodeRevision, setGcodeRevision] = useState(0);

  const fallbackOptions = useMemo<GcodeParseOptions>(
    () => ({
      bedSize,
      densityG,
      origin,
      machineProfileId: "unspecified-machine",
      materialProfileId: "unspecified-material",
    }),
    [bedSize, densityG, origin]
  );
  const options = featureFlags.profileSelectorReact ? profile.value.options : fallbackOptions;
  const result = state.result;
  const authority = useGcodeAuthority(file, submittedOptions, result);
  const layer = result?.layers[selectedLayer] ?? null;
  const authorityToolpathActive = Boolean(
    authority.mode === "dotnet" && authority.status === "done" && authority.result
  );
  const authorityLayer = useMemo(
    () =>
      authorityToolpathActive && authority.result
        ? decodeAuthorityToolpathLayer(authority.result, selectedLayer)
        : null,
    [authority.result, authorityToolpathActive, selectedLayer]
  );
  const visualizationLayerCount = authorityToolpathActive
    ? (authority.result?.visualization.layers.length ?? 0)
    : (result?.layers.length ?? 0);
  const effectiveSummary = selectEffectiveSummary(authority.mode, authority.status, result, authority.result);
  const primaryWarnings =
    effectiveSummary?.provenance === "dotnet-authority"
      ? (authority.result?.warnings.map((warning) => `${warning.code} · ${warning.message}`) ?? [])
      : (result?.warnings ?? []);
  const hasUnsubmittedOptions = Boolean(
    file &&
    options &&
    (options.bedSize !== submittedOptions.bedSize ||
      options.densityG !== submittedOptions.densityG ||
      options.origin !== submittedOptions.origin ||
      options.machineProfileId !== submittedOptions.machineProfileId ||
      options.materialProfileId !== submittedOptions.materialProfileId)
  );

  const reconciliationPlan = useMemo<GcodeReconciliationPlan | null>(() => {
    if (!result || !effectiveSummary) return null;
    if (authority.mode === "dotnet" && effectiveSummary.provenance !== "dotnet-authority") return null;
    if (effectiveSummary.sha256 !== result.sha256) return null;
    return {
      gcodeSha256: result.sha256,
      provenance: effectiveSummary.provenance,
      engineVersion:
        effectiveSummary.provenance === "dotnet-authority"
          ? (authority.result?.engine.version ?? "unknown")
          : "legacy-browser-preview",
      totalLayers: effectiveSummary.totalLayers,
      estimatedTimeSec: effectiveSummary.estimatedTimeSeconds,
      filamentMm: effectiveSummary.filamentLengthM * 1000,
      filamentG: effectiveSummary.filamentMassG,
    };
  }, [authority.mode, authority.result?.engine.version, effectiveSummary, result]);

  const machineLogDisabledReason = (() => {
    if (!result) return "请先完成 G-code 原始字节摘要与解析";
    if (authority.mode === "dotnet" && effectiveSummary?.provenance !== "dotnet-authority") {
      return "等待 C# 权威结果与浏览器原始摘要交叉核验";
    }
    if (effectiveSummary?.sha256 !== result.sha256) return "C# 与浏览器原始摘要不一致";
    return "对账计划尚未就绪";
  })();

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

  useEffect(() => setSelectedLayer(0), [result?.sha256, authorityToolpathActive, authority.result?.input.sha256]);

  const acceptFile = (next: File | null) => {
    if (!next || !options) return;
    setGcodeRevision((current) => current + 1);
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
    if (!file || !options) return;
    setGcodeRevision((current) => current + 1);
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
            {authority.jobId ? (
              <div className="worker-status authority-job-status">
                <div>
                  <span>
                    作业 {authority.jobId.slice(0, 8)}… · {authority.phase} · {authority.transport.toUpperCase()}
                  </span>
                  <span>{Math.round(authority.progress * 100)}%</span>
                </div>
                <progress aria-label="C# 权威异步作业进度" max="1" value={authority.progress} />
              </div>
            ) : (
              <p className="muted">正在创建可恢复的 C# 分析作业…</p>
            )}
            <button className="reset-button" type="button" onClick={authority.cancel}>
              {authority.jobId ? "取消 C# 作业" : "取消 C# 分析"}
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
              <span>契约 / 输入 / 参数 / Profile / 层计划 / 工具路径</span>
              <code>
                {authority.diff.engineMatches &&
                authority.diff.contractMatches &&
                authority.diff.inputMatches &&
                authority.diff.parametersMatch &&
                authority.diff.profileMatches &&
                authority.diff.layerPlanMatches
                  ? "match"
                  : "mismatch"}
              </code>
            </p>
            <p>
              <span>Profile</span>
              <code>
                {authority.result.profile.machineProfileId} / {authority.result.profile.materialProfileId}
              </code>
            </p>
            <p>
              <span>Profile 指纹</span>
              <code>{authority.result.profile.fingerprint.slice(0, 12)}…</code>
            </p>
            <p>
              <span>字段差异</span>
              <code>
                {authority.diff.fields.filter((field) => !field.pass).length} failed / {authority.diff.fields.length}
              </code>
            </p>
            <p>
              <span>权威层计划</span>
              <code>
                {authority.diff.layerPlanMatches
                  ? `${authority.result.layers.length} layers match`
                  : `${authority.diff.layerMismatchCount} layers mismatch`}
              </code>
            </p>
            <p>
              <span>权威工具路径</span>
              <code>
                {authority.result.visualization.encoding} · {authority.result.visualization.segmentCount} /{" "}
                {authority.result.visualization.sourceSegmentCount} segments · stride{" "}
                {authority.result.visualization.samplingStride}
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
            {!authority.diff.profileMatches ? <li>C# Profile 摘要与本次提交或返回参数不一致</li> : null}
            {!authority.diff.layerPlanMatches ? <li>C# 逐层计划与浏览器完整解析结果不一致</li> : null}
            {authority.diff.fields
              .filter((field) => !field.pass)
              .slice(0, 6)
              .map((field) => (
                <li key={field.field}>
                  {field.field}: Δ {number(field.absoluteDelta, 6)} &gt; {number(field.limit, 6)}
                </li>
              ))}
            {authority.diff.layerFields.slice(0, 6).map((field) => (
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
        {featureFlags.profileSelectorReact ? (
          <ProfileSelector value={profile.value} actions={profile.actions} />
        ) : (
          <div className="gcode-options">
            <label>
              平台尺寸（mm）
              <input
                type="number"
                min="50"
                max="2000"
                value={bedSize}
                onChange={(event) => setBedSize(Number(event.target.value))}
              />
            </label>
            <label>
              材料密度（g/cm³）
              <input
                type="number"
                min="0.2"
                max="5"
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
        )}
        {hasUnsubmittedOptions ? (
          <p className="profile-pending-note" role="status">
            当前结果仍使用上次提交的参数；点击“按当前参数重新解析”后更新。
          </p>
        ) : null}
        <label
          className={`gcode-drop${options ? "" : " gcode-drop-disabled"}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <input type="file" accept=".gcode,.gco,.gc,text/plain" disabled={!options} onChange={onInput} />
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

      {featureFlags.machineLogReact ? (
        <MachineLogPanel
          plan={reconciliationPlan}
          gcodeRevision={gcodeRevision}
          disabledReason={machineLogDisabledReason}
        />
      ) : null}

      {result || authorityToolpathActive ? (
        <section className="panel gcode-result">
          <div className="viewer-toolbar">
            <div>
              <p className="eyebrow">
                {authorityToolpathActive ? "C# PACKED TOOLPATH / THREE.JS" : "BROWSER LAYER VISUALIZATION SAMPLE"}
              </p>
              <h2>
                {authorityToolpathActive ? "C# 有界工具路径" : "浏览器可视化抽样"} · 第 {selectedLayer + 1} /{" "}
                {visualizationLayerCount} 层
              </h2>
            </div>
            <label>
              层{" "}
              <input
                type="range"
                min="0"
                max={Math.max(0, visualizationLayerCount - 1)}
                value={selectedLayer}
                onInput={(event) => setSelectedLayer(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <Suspense
            fallback={
              <div className="gcode-viewer gcode-viewer-loading" role="status">
                正在加载 Three.js 路径视口…
              </div>
            }
          >
            <GcodeViewer
              layer={authorityToolpathActive ? null : layer}
              authorityLayer={authorityLayer}
              bounds={effectiveSummary?.bounds ?? result?.bounds ?? null}
            />
          </Suspense>
          <div className="gcode-evidence">
            <p>
              <span>{authorityToolpathActive ? "C# 工具路径层" : "浏览器抽样层"}</span>
              <code>
                Z {number(authorityLayer?.z ?? layer?.z ?? 0)} mm ·{" "}
                {authorityLayer?.sourcePathCount ?? layer?.sourcePathCount ?? 0} paths ·{" "}
                {authorityToolpathActive
                  ? `${number(authorityLayer?.sourceSegmentCount ?? 0, 0)} source segments`
                  : `${number(layer?.sourcePointCount ?? 0, 0)} points`}
              </code>
            </p>
            <p>
              <span>预览预算</span>
              <code>
                {authorityToolpathActive
                  ? `${number(authority.result?.visualization.segmentCount ?? 0, 0)} / ${number(
                      authority.result?.visualization.sourceSegmentCount ?? 0,
                      0
                    )} segments${authority.result?.visualization.truncated ? " · C# bounded" : " · C# complete"}`
                  : `${number(result?.previewSegments ?? 0, 0)} / ${number(
                      result?.sourceSegments ?? 0,
                      0
                    )} segments${result?.previewTruncated ? " · browser sampled" : " · browser complete"}`}
              </code>
            </p>
          </div>
          <div className="result-actions">
            <button className="reset-button" type="button" disabled={!options} onClick={reparseCurrentFile}>
              按当前参数重新解析
            </button>
            <button
              className="reset-button"
              type="button"
              onClick={() => {
                setGcodeRevision((current) => current + 1);
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
