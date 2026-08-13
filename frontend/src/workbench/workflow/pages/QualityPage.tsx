import { useEffect, useReducer } from "react";
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
      <div className="sec-label">本次成品实测报告</div>
      {actual ? (
        <>
          <div className="note">
            实测评级{" "}
            <b className="mono" style={{ color: scoreColor(actual.score) }}>
              {actual.grade}
            </b>{" "}
            · 综合{" "}
            <b className="mono" style={{ color: scoreColor(actual.score) }}>
              {actual.score}
            </b>{" "}
            / 100 — 机时 {fmtHuman(actual.elapsed)} · 耗材 {actual.usedG.toFixed(1)} g ·{" "}
            {actual.at.toLocaleTimeString()} 完成。 数据来源：打印全程遥测（温度曲线 / 调平网格 / 事件实录 /
            速度轨迹）。
          </div>
          {actual.checks.map((check) => (
            <QualityCheckItem key={check.name} check={check} />
          ))}
        </>
      ) : (
        <div className="note">
          {printing
            ? "打印进行中，正在采集运行遥测（温度偏差 / 事件 / 速度轨迹），完成后生成实测报告。"
            : "尚无成品。完成一次打印后，这里将基于全程运行遥测生成实测质量报告。"}
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
