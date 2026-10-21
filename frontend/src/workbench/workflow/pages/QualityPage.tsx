import { useEffect, useReducer, useState } from "react";
import { simulationQualityAudit } from "../../../engine/quality-audit";
import {
  legacyComputeQuality,
  legacyUtil,
  type LegacyEventBus,
  type LegacySim,
  type QualityCheck,
} from "../../../legacy/engine";

function levelColor(level: string): string {
  return level === "good" ? "var(--ok)" : level === "mid" ? "var(--warn)" : "var(--err)";
}

function scoreColor(score: number): string {
  return score >= 80 ? "var(--ok)" : score >= 55 ? "var(--warn)" : "var(--err)";
}

function QualityCheckItem({ check }: { readonly check: QualityCheck }) {
  const color = levelColor(check.level);
  return (
    <div className="qcheck">
      <div className="qc-head">
        <span className="qc-name">{check.name}</span>
        <span className={`qc-score q-${check.level} mono`}>{check.score}</span>
      </div>
      <div className="qc-bar">
        <div className="qc-fill" style={{ width: `${check.score}%`, background: color }} />
      </div>
      <div className="qc-tip">{check.tip}</div>
    </div>
  );
}

interface QualityPageProps {
  readonly sim: LegacySim;
  readonly bus: LegacyEventBus;
}

export function QualityPage({ sim, bus }: QualityPageProps) {
  const { fmtHuman } = legacyUtil();
  const [, bump] = useReducer((version: number) => version + 1, 0);
  const [exportError, setExportError] = useState("");

  /* 参数面板（遗留）调参经防抖走 renderCtx("quality")，页级守卫将其转发为
     ctx-page-refresh；实测报告则由打印完成时的 quality-actual 直达。 */
  useEffect(
    () =>
      bus.on("ctx-page-refresh", (id) => {
        if (id === "quality") bump();
      }),
    [bus]
  );
  useEffect(() => bus.on("quality-actual", bump), [bus]);
  useEffect(() => bus.on("settings", bump), [bus]);

  const actual = sim.lastQuality;
  const printing = sim.state === "print" || sim.state === "pause" || sim.state === "fault";
  const predicted = legacyComputeQuality(sim.settings, sim.model);
  const average = Math.round(predicted.reduce((sum, check) => sum + check.score, 0) / predicted.length);

  return (
    <>
      <div className="sec-label">最近一次仿真质量报告</div>
      {actual ? (
        <>
          <div className="note">
            仿真评级{" "}
            <b className="mono" style={{ color: scoreColor(actual.score) }}>
              {actual.grade}
            </b>{" "}
            · 综合{" "}
            <b className="mono" style={{ color: scoreColor(actual.score) }}>
              {actual.score}
            </b>{" "}
            / 100 — 模拟机时 {fmtHuman(actual.elapsed)} · 模拟耗材 {actual.usedG.toFixed(1)} g ·{" "}
            {actual.at.toLocaleTimeString()} 完成。 数据来源：浏览器仿真遥测（温度 / 调平 / 事件 /
            速度），不是打印机实测或成品检测。
          </div>
          <div data-react-only="simulation-quality-audit" data-quality-source="browser-simulation">
            {actual.provenance && (
              <div className="note">
                来源模型：{actual.provenance.basis.modelName ?? "未记录"} · 机台：{actual.provenance.basis.machineId}
              </div>
            )}
            <button
              className="btn"
              onClick={() => {
                try {
                  const json = simulationQualityAudit(actual),
                    url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "forgex-simulation-quality.json";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 0);
                  setExportError("");
                } catch (error) {
                  setExportError(error instanceof Error ? error.message : "报告导出失败");
                }
              }}
            >
              下载仿真质量审计 JSON
            </button>
            {exportError && (
              <div className="note" role="alert">
                {exportError}
              </div>
            )}
          </div>
          {actual.checks.map((check) => (
            <QualityCheckItem key={check.name} check={check} />
          ))}
        </>
      ) : (
        <div className="note">
          {printing
            ? "仿真进行中，正在记录模拟温度、事件和速度，完成后生成仿真质量报告。"
            : "尚无仿真报告。完成一次浏览器仿真后可查看规则评分；该评分不能替代成品检测。"}
        </div>
      )}

      <div className="sec-label">打印前参数预估</div>
      <div className="note">
        综合工艺评分{" "}
        <b className="mono" style={{ color: scoreColor(average) }}>
          {average}
        </b>{" "}
        / 100 — 随参数实时更新，开始打印前建议消除全部红色项。
      </div>
      {predicted.map((check) => (
        <QualityCheckItem key={check.name} check={check} />
      ))}
    </>
  );
}
