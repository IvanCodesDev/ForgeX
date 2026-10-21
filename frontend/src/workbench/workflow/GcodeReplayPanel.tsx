import { useEffect, useRef, useState } from "react";
import { requestLayerTimeline, requestReplayCheckpoint } from "../../authority/gcode-replay";
import type { AuthorityAnalysisResponse } from "../../authority/gcode-authority";
import type { GCodeLayerTimeline, GCodeReplayCheckpoint } from "../../generated/forgex-api";
import "./gcode-cost.css";
import { ReplayBookmarks } from "./ReplayBookmarks";
import { deriveLayerPlan } from "../../authority/gcode-replay";

export function GcodeReplayPanel({
  jobId,
  source,
  previewLayer,
  canLink,
  onPreview,
}: {
  readonly jobId: string;
  readonly source: AuthorityAnalysisResponse;
  readonly previewLayer: number;
  readonly canLink: boolean;
  readonly onPreview: (index: number) => void;
}) {
  const [page, setPage] = useState<GCodeLayerTimeline | null>(null);
  const [checkpoint, setCheckpoint] = useState<GCodeReplayCheckpoint | null>(null);
  const [elapsed, setElapsed] = useState("0");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
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
    setBusy(false);
    setError(null);
    setCheckpoint(null);
  };
  const run = async (offset?: number) => {
    invalidate();
    if (offset !== undefined) setPage(null);
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      if (offset !== undefined) {
        const result = await requestLayerTimeline(jobId, source, offset, import.meta.env, controller.signal);
        if (!controller.signal.aborted) setPage(result);
      } else {
        if (!elapsed.trim()) throw new Error("请输入回放秒数");
        const result = await requestReplayCheckpoint(
          jobId,
          source,
          Number(elapsed),
          page?.fingerprint,
          import.meta.env,
          controller.signal
        );
        if (!controller.signal.aborted) setCheckpoint(result);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "层计划请求失败");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const order = source.layers[previewLayer]?.sourceOrder;
  const restore = async (seconds: number) => {
    invalidate();
    setPage(null);
    setElapsed(String(seconds));
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const plan = deriveLayerPlan(source);
      const row = plan.layers.find((layer) => layer.endSeconds > seconds);
      const offset = Math.floor((row?.sequence ?? Math.max(0, plan.layers.length - 1)) / 50) * 50;
      const loaded = await requestLayerTimeline(jobId, source, offset, import.meta.env, controller.signal);
      const checked = await requestReplayCheckpoint(
        jobId,
        source,
        seconds,
        loaded.fingerprint,
        import.meta.env,
        controller.signal
      );
      if (!controller.signal.aborted) {
        setPage(loaded);
        setCheckpoint(checked);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "书签恢复失败");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const download = () => {
    if (!page) return;
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ format: "forgex-layer-replay-audit", version: 1, timelinePage: page, checkpoint }, null, 2)],
        { type: "application/json" }
      )
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `forgex-layer-replay-${jobId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <details id="gcode-replay-panel">
      <summary>C# 层计划与回放核验</summary>
      <div className="gcode-summary gcode-cost-form">
        <div className="note">
          按源文件执行顺序核验运动时间；不含预热、等待和固件加速度。下方路径画布仍为浏览器预览。
        </div>
        <button className="btn" disabled={busy} onClick={() => void run(0)}>
          加载权威时间轴
        </button>
        <button
          className="btn"
          disabled={busy || !canLink || order == null}
          onClick={() => void run(Math.floor((order ?? 0) / 50) * 50)}
        >
          读取预览层的权威计划
        </button>
        {!canLink && <div className="note">预览层与权威层不能一一对应，暂不联动。</div>}
        <ReplayBookmarks
          source={source}
          elapsedSeconds={checkpoint?.elapsedSeconds ?? null}
          busy={busy}
          onRestore={(seconds) => {
            void restore(seconds);
          }}
        />
        {error && (
          <div className="note" role="alert">
            {error}
          </div>
        )}
        {busy && <div role="status">正在核验层计划…</div>}
        {page && (
          <div id="gcode-timeline-result" data-fingerprint={page.fingerprint}>
            <div className="note">
              {page.totalLayers} 层 · 运动 {page.totalSeconds.toFixed(3)} 秒 · 首层前空驶{" "}
              {page.leadingMotionSeconds.toFixed(3)} 秒
            </div>
            <div className="note">
              逐层正向耗丝 {page.totalPositiveExtrusionMm.toFixed(3)} mm；作业净耗丝{" "}
              {(page.basis.netFilamentLengthM * 1000).toFixed(3)} mm（含回抽及纯 E，口径不同）。
            </div>
            <div className="replay-rows">
              {page.layers.map((row) => (
                <div className="replay-row" key={row.sequence}>
                  <span className="mono">
                    执行 {row.sequence + 1} · 预览层 {row.layerIndex + 1} · Z {row.zMm.toFixed(3)} ·{" "}
                    {row.startSeconds.toFixed(3)}–{row.endSeconds.toFixed(3)} s
                  </span>
                  <button className="btn" disabled={!canLink} onClick={() => onPreview(row.layerIndex)}>
                    预览此层
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      invalidate();
                      setElapsed(String(row.startSeconds));
                    }}
                  >
                    定位层起点
                  </button>
                </div>
              ))}
            </div>
            <div className="replay-actions">
              <button
                className="btn"
                disabled={busy || page.offset === 0}
                onClick={() => void run(Math.max(0, page.offset - page.limit))}
              >
                上一页
              </button>
              <span>
                {page.offset + (page.layers.length ? 1 : 0)}–{page.offset + page.layers.length} / {page.totalLayers}
              </span>
              <button
                className="btn"
                disabled={busy || page.nextOffset === null}
                onClick={() => void run(page.nextOffset ?? 0)}
              >
                下一页
              </button>
            </div>
            {page.warnings.map((warning) => (
              <div className="note" key={warning}>
                {warning}
              </div>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <label>
                <span>回放时间（秒）</span>
                <input
                  aria-label="回放时间（秒）"
                  type="number"
                  min="0"
                  max={page.totalSeconds}
                  step="any"
                  required
                  value={elapsed}
                  onChange={(event) => {
                    invalidate();
                    setElapsed(event.target.value);
                  }}
                />
              </label>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  invalidate();
                  setElapsed(String(page.totalSeconds));
                }}
              >
                定位计划终点
              </button>
              <button className="btn btn-primary" disabled={busy}>
                校验回放时间点
              </button>
            </form>
            {checkpoint && (
              <div id="gcode-replay-result" data-phase={checkpoint.phase} data-fingerprint={checkpoint.fingerprint}>
                <div className="note">
                  {checkpoint.phase === "completed"
                    ? "计划已完成"
                    : checkpoint.phase === "initial-travel"
                      ? "首层前空驶"
                      : `当前执行层 ${(checkpoint.activeLayer?.sequence ?? 0) + 1}`}{" "}
                  · 已完成 {checkpoint.completedLayerCount} 层 · 剩余 {checkpoint.remainingSeconds.toFixed(3)} 秒
                </div>
                <div className="note">
                  已完成层正向耗丝 {checkpoint.completedPositiveExtrusionMm.toFixed(3)} mm；不推算当前层材料或喷头坐标。
                </div>
                {checkpoint.activeLayer && (
                  <button
                    className="btn"
                    disabled={!canLink}
                    onClick={() => onPreview(checkpoint.activeLayer!.layerIndex)}
                  >
                    预览检查点所在层
                  </button>
                )}
              </div>
            )}
            <button className="btn" onClick={download}>
              下载层计划审计 JSON
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
