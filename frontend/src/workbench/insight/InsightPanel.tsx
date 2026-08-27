import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { legacyInsightServices, type InsightReport, type LegacyUi } from "../../legacy/engine";
import type { Insight } from "./useInsight";
import { drawReportChart } from "./report-chart";

const QUICK_QUESTIONS = [
  "哪台机故障率最高，主要故障是什么",
  "各材料的失败率对比",
  "层高与打印时长的相关性",
  "成本趋势与拆解",
  "失败批次有没有共性",
];

const CONFIDENCE_LABEL: Readonly<Record<string, string>> = {
  high: "可信度：高",
  medium: "可信度：中",
  low: "可信度：低",
  "insufficient-data": "样本不足",
};

/** 引擎标识 → 界面文案。规则引擎必须自称规则引擎，只有真 AI provider 才能带「AI」字样。 */
function engineLabel(id?: string): string {
  switch (id) {
    case "infinisynapse":
      return "InfiniSynapse 云端 AI";
    case "server-rules":
      return "后端规则引擎（无 AI）";
    case "local-rules":
      return "本地规则引擎（无 AI）";
    case "dotnet-authority":
      return "C# 权威统计引擎（无 AI）";
    default:
      return id ? String(id) : "未知引擎";
  }
}

function EngineNote({ mode, authority }: { readonly mode: Insight["engineMode"]; readonly authority: boolean }) {
  const { apiClient } = legacyInsightServices();
  if (authority) {
    return (
      <div className="note">
        统计计算由 <b>C# 权威引擎</b>执行（VITE_ANALYTICS_AUTHORITY=dotnet）。<b>它不是 AI</b>
        ：算法与本地规则引擎逐字段镜像（同一套 Wilson 置信区间 / Fisher 精确检验），由金样本双跑保证一致；
        权威服务不可用时自动回退浏览器本地计算并在报告中明示。
      </div>
    );
  }
  return (
    <div className="note">
      {mode === "local" ? (
        <>
          当前是<b>本地规则引擎</b>（file:// 直开或后端未启动）。<b>它不是 AI</b>：报告由关键词路由 + 统计核（Wilson
          置信区间 / Fisher 精确检验 / 偏相关）产出。要接 AI：运行 <span className="mono">node server/index.js</span>
          ，改用 <span className="mono">http://127.0.0.1:8787</span> 打开本页。
        </>
      ) : mode === "ai" ? (
        <>
          已连接 <b>{apiClient.providerLabel || "AI provider"}</b>。架构上 <b>AI 只负责叙述，数字由本地统计核算</b>
          ——所以图表、视口联动、置信区间与显著性检验在 AI 模式下同样具备，且报告里每个数字都能在「计算依据」里找到出处。
        </>
      ) : (
        <>
          后端已连接，运行的是<b>后端规则引擎</b>（未配置 AI provider）。<b>它不是 AI</b>
          ，但结论同样带置信区间与显著性检验。配置 <span className="mono">INFINI_API_KEY</span> 或{" "}
          <span className="mono">OPENAI_API_KEY</span> 后可接 AI。
        </>
      )}
    </div>
  );
}

/**
 * 知识库入口。只在 AI provider 下展示——
 * 规则引擎是确定性统计，不读自然语言知识，摆一个没用的上传框只会误导。
 */
function KnowledgeBox({ ui, question }: { readonly ui: LegacyUi; readonly question: string }) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [hits, setHits] = useState<{ q: string; items: Array<{ score: number; text: string }> } | null>(null);

  const upload = () => {
    const trimmed = text.trim();
    if (!trimmed) return ui.toast("先粘贴一些知识内容", "warn");
    setUploading(true);
    const { apiClient } = legacyInsightServices();
    apiClient
      .uploadKnowledge(`knowledge-${Date.now()}.md`, trimmed)
      .then((out) => {
        setText("");
        ui.toast(out.retrievalEnabled ? "已登记，提问时会按需检索注入" : (out.note ?? ""), "ok");
      })
      .catch((error: Error) => ui.toast(error.message, "err"))
      .then(() => setUploading(false));
  };

  const testSearch = () => {
    const q = question.trim() || "翘边";
    const { apiClient } = legacyInsightServices();
    apiClient
      .searchKnowledge(q)
      .then((out) => setHits({ q, items: out.hits }))
      .catch((error: Error) => ui.toast(error.message, "err"));
  };

  return (
    <div className="kb-box">
      <div className="sec-label">领域知识（可选）</div>
      <div className="note">
        上传工艺术语表 / 材料参数 / 设备手册，提问时会按问题检索相关片段注入 AI 提示词。<b>检索不到就不注入</b>
        ——宁可不给，也不给无关内容。存储为内存态，重启即失效。
      </div>
      <textarea
        className="kb-input"
        rows={4}
        placeholder={
          "粘贴知识内容，例如：\n翘边：首层与热床附着失效，边缘翘起离床。\n\nOEE：设备综合效率 = 可用率 × 性能 × 良率。"
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="prow ins-actions">
        <button className="mini-btn" disabled={uploading} onClick={upload}>
          上传知识
        </button>
        <button className="mini-btn" title="看看当前问题会检索到哪些片段——自己验证，不用盲信" onClick={testSearch}>
          测试检索
        </button>
      </div>
      {hits ? (
        <div className="kb-res">
          {hits.items.length ? (
            <>
              <div className="kb-h">{`「${hits.q}」检索到 ${hits.items.length} 段：`}</div>
              {hits.items.map((hit, index) => (
                <div className="kb-hit" key={index}>
                  <span className="mono">{hit.score.toFixed(2)}</span> {hit.text.slice(0, 90)}
                  {hit.text.length > 90 ? "…" : ""}
                </div>
              ))}
            </>
          ) : (
            <div className="kb-h">{`「${hits.q}」没有检索到相关片段——分析时不会注入任何知识内容。`}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ReportChart({ report }: { readonly report: InsightReport }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current && report.chart) drawReportChart(canvasRef.current, report.chart);
  }, [report]);
  if (!report.chart?.items?.length) return null;
  return (
    <div className="rp-chart">
      <div className="ch-lab rp-ch-title">{report.chart.title || ""}</div>
      <canvas ref={canvasRef} />
    </div>
  );
}

function ReportView({ insight, ui }: { readonly insight: Insight; readonly ui: LegacyUi }) {
  const report = insight.report;
  const [sharing, setSharing] = useState(false);
  if (!report) return <div className="report-box" />;

  const { stats, apiClient } = legacyInsightServices();
  const prov = report.provenance;
  const confidence = report.confidence ? CONFIDENCE_LABEL[report.confidence] : null;
  const machines = report.chart && report.chart.kind === "bar-rate" ? report.chart.items : null;
  const highlight = report.highlight;

  return (
    <div className="report-box">
      <div className="rp-head">
        <span className="rp-title">{report.title || "分析报告"}</span>
        <span className="ph-tag mono">
          {engineLabel(report.engine)} · {report.rowCount || 0} 行
          {report.elapsedMs != null ? ` · ${(report.elapsedMs / 1000).toFixed(report.elapsedMs < 1000 ? 2 : 1)}s` : ""}
        </span>
      </div>

      {prov ? (
        <div className={prov.synthetic ? "rp-prov synth" : "rp-prov"}>
          {prov.synthetic ? (
            <>
              ⚠ 基于<b>{prov.badge}数据</b>：{prov.note || prov.source || ""}
            </>
          ) : (
            <>数据来源：{prov.note || prov.source || ""}</>
          )}
        </div>
      ) : null}
      {report.fallbackFrom === "backend" ? (
        <div className="rp-prov warnline">后端不可用，本报告由浏览器本地规则引擎计算。</div>
      ) : null}
      {report.fallbackFrom === "dotnet-authority" ? (
        <div className="rp-prov warnline">C# 权威服务不可用，本报告由浏览器本地规则引擎计算。</div>
      ) : null}

      <div className="verdict">{report.verdict || ""}</div>

      {confidence ? (
        <div className={`rp-conf c-${report.confidence}`}>
          {confidence}
          {report.confidence === "high" || report.confidence === "medium"
            ? ""
            : " — 该结论证据不足，请补充数据后再据此决策"}
        </div>
      ) : null}

      <ReportChart report={report} />

      {(report.sections ?? []).map((section, index) => (
        <div className="rp-sec" key={index}>
          <div className="rp-h">{section.h}</div>
          {(section.lines ?? []).map((line, li) => (
            <div className="rp-line" key={li}>
              {line}
            </div>
          ))}
        </div>
      ))}

      {report.evidence?.length ? (
        <details className="rp-evi">
          <summary>{`计算依据（${report.evidence.length} 条）`}</summary>
          {report.evidence.map((ev, index) => {
            const parts: string[] = [];
            if (ev.method) parts.push(ev.method);
            if (ev.n != null) parts.push(`n=${ev.n}`);
            if (ev.statistic != null) parts.push(`统计量=${Number(ev.statistic).toFixed(3)}`);
            if (ev.ci95) parts.push(`95%CI ${Number(ev.ci95[0]).toFixed(3)}–${Number(ev.ci95[1]).toFixed(3)}`);
            if (ev.pValue != null) parts.push(stats.fmtP(ev.pValue));
            return (
              <div className="evi-item" key={index}>
                <div className="evi-claim">{ev.claim}</div>
                <div className="evi-meta mono">{parts.join(" · ")}</div>
              </div>
            );
          })}
        </details>
      ) : null}

      {/* 视口联动：多台机器进机群视图；只有一台且就是视口里那台时直接高亮 */}
      {highlight && highlight.type === "machine" ? (
        machines && machines.length > 1 ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => insight.showFleet(machines, highlight.id)}
          >
            {`在机群视图中定位 ${highlight.id}（共 ${machines.length} 台）`}
          </button>
        ) : insight.viewportMatches(highlight.id) ? (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => insight.highlightMachine(highlight.id)}
          >
            {`在 3D 视口中高亮 ${highlight.id}`}
          </button>
        ) : null
      ) : null}

      {report.taskId && apiClient.available ? (
        <button
          type="button"
          className="mini-btn ins-share"
          disabled={sharing}
          onClick={() => {
            if (!report.taskId) return;
            setSharing(true);
            void insight.shareReport(report.taskId).then(() => setSharing(false));
          }}
        >
          生成分享页
        </button>
      ) : null}
      {ui ? null : null}
    </div>
  );
}

interface InsightPanelProps {
  readonly insight: Insight;
  readonly ui: LegacyUi | null;
}

export function InsightPanel({ insight, ui }: InsightPanelProps) {
  const store = insight.store;
  const services = store ? legacyInsightServices() : null;
  const insightData = services?.insightData ?? null;
  const insightEngine = services?.insightEngine ?? null;
  void insight.storeVersion; // 数据集变化驱动重渲

  /* dotnet 权威只接管规则计算；真 AI 管线保持原标识（叙述能力优先级更高，见 useInsight 调度）。 */
  const authorityActive = insight.authorityMode === "dotnet" && insight.engineMode !== "ai";
  const engineTag = authorityActive
    ? "C# 权威"
    : insight.engineMode === "local"
      ? "本地规则"
      : insight.engineMode === "ai"
        ? "AI + 统计核"
        : "后端规则";

  const onAskKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") insight.ask(insight.question);
  };

  const rows = store?.rows() ?? [];
  const kpis = rows.length && insightEngine ? insightEngine.kpis(rows) : null;
  const minSample = insightEngine?.MIN_SAMPLE ?? 0;
  const provenance = store?.provenance();

  return (
    <section
      id="insight-panel"
      className={insight.entering ? "float-card entering" : "float-card"}
      hidden={!insight.open}
    >
      <header className="panel-head">
        <h2>智造洞察</h2>
        <span className="ph-tag mono" id="insight-engine-tag">
          {engineTag}
        </span>
        <button className="close-btn" id="insight-close" title="收起面板" onClick={() => insight.close()} />
      </header>
      <div className="panel-body" id="insight-body">
        {store && ui && insightData && insightEngine ? (
          <>
            <EngineNote mode={insight.engineMode} authority={authorityActive} />
            {insight.engineMode === "ai" ? <KnowledgeBox ui={ui} question={insight.question} /> : null}

            <div className="sec-label">数据接入</div>
            <div className="chip-row">
              {Object.entries(store.sets).map(([key, set]) => {
                const p = set.provenance || {};
                return (
                  <div
                    key={key}
                    className={"chip sm" + (store.active === key ? " on" : "") + (p.synthetic ? " synth" : "")}
                    title={p.note || undefined}
                    onClick={() => {
                      if (!set.rows.length) {
                        ui.toast(
                          key === "sim" ? "还没有本机采集数据，先完成一次打印" : "该数据集为空，请先上传",
                          "warn"
                        );
                        return;
                      }
                      store.use(key);
                    }}
                  >
                    {`${set.label} · ${set.rows.length}`}
                    {p.badge ? (
                      <>
                        {" "}
                        <i className="ds-badge">{p.badge}</i>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {provenance ? (
              <div className={provenance.synthetic ? "note note-synth" : "note"}>
                {provenance.synthetic ? (
                  <>
                    ⚠ <b>{provenance.badge}数据</b>：{provenance.note}
                  </>
                ) : (
                  <>数据来源：{provenance.note}</>
                )}
              </div>
            ) : null}
            <div className="prow ins-actions">
              <button className="mini-btn" onClick={() => document.getElementById("csv-input")?.click()}>
                上传 CSV
              </button>
              <button
                className="mini-btn"
                title="由虚拟机群物理仿真产出，非真实产线数据"
                onClick={() => insightData.downloadCsv(store.sets.farm?.rows ?? [], "print_farm.csv")}
              >
                下载机群数据
              </button>
              <button
                className="mini-btn"
                onClick={() => {
                  const simRows = store.sets.sim?.rows ?? [];
                  if (!simRows.length) return ui.toast("暂无本机采集数据 — 先跑一次打印任务", "warn");
                  insightData.downloadCsv(simRows, "sim_jobs.csv");
                }}
              >
                导出本机采集
              </button>
            </div>

            <div className="sec-label">关键指标</div>
            <div className="kpi-grid">
              {!kpis ? (
                <div className="note">当前数据集为空。</div>
              ) : (
                [
                  {
                    lab: "任务总数",
                    val: String(kpis.total),
                    sub: kpis.dateRange ? kpis.dateRange.label : "无日期列",
                    cls: "",
                  },
                  {
                    lab: "综合良率",
                    val: (kpis.yield * 100).toFixed(1) + "%",
                    sub: `良品 ${Math.round(kpis.yield * kpis.total)} 件`,
                    cls: kpis.yield >= 0.9 ? "good" : kpis.yield >= 0.8 ? "mid" : "bad",
                  },
                  {
                    lab: "良品均本",
                    val: "¥" + (kpis.avgCostFen / 100).toFixed(2),
                    sub: "耗材+能耗+机时（估算口径）",
                    cls: "",
                  },
                  kpis.worstMachine
                    ? {
                        lab: "失败率最高",
                        val: kpis.worstMachine.id,
                        sub:
                          (kpis.worstMachine.failRate * 100).toFixed(0) +
                          "% · n=" +
                          kpis.worstMachine.n +
                          (kpis.topReason ? " · " + kpis.topReason.name : ""),
                        cls: kpis.worstMachine.failRate > 0.15 ? "bad" : "",
                      }
                    : { lab: "失败率最高", val: "—", sub: `无机台达到 ${minSample} 个任务的最小样本量`, cls: "" },
                ].map((tile) => (
                  <div key={tile.lab} className={"kpi-tile" + (tile.cls ? " k-" + tile.cls : "")}>
                    <div className="kt-lab">{tile.lab}</div>
                    <div className="kt-val mono">{tile.val}</div>
                    <div className="kt-sub">{tile.sub}</div>
                  </div>
                ))
              )}
            </div>

            <div className="sec-label">自然语言分析</div>
            <div className="ask-row">
              <input
                className="ask-input"
                type="text"
                placeholder="问点什么，比如：哪台机故障率最高"
                maxLength={120}
                value={insight.question}
                onChange={(event) => insight.setQuestion(event.target.value)}
                onKeyDown={onAskKey}
              />
              <button
                className="btn btn-primary ask-btn"
                disabled={insight.busy}
                onClick={() => insight.ask(insight.question)}
              >
                分析
              </button>
            </div>
            <div className="chip-row quick-qs">
              {QUICK_QUESTIONS.map((q) => (
                <div key={q} className="chip sm" onClick={() => insight.ask(q)}>
                  {q}
                </div>
              ))}
            </div>

            {/* 空闲态是空容器：进度条骨架只在分析进行中存在（与旧 _pushStage 的惰性构建一致） */}
            <div className="ai-steps" hidden={!insight.stages.length}>
              {insight.stages.length ? (
                <>
                  <div className="ai-bar">
                    <i style={{ width: `${(insight.progress * 100).toFixed(1)}%` }} />
                  </div>
                  {insight.stages.map((stage, index) => (
                    <div
                      key={stage.id}
                      className={index === insight.stages.length - 1 ? "ai-step run" : "ai-step done"}
                    >
                      <span className="as-dot" />
                      <span>{stage.message}</span>
                    </div>
                  ))}
                </>
              ) : null}
            </div>

            <ReportView insight={insight} ui={ui} />

            <div className="sec-label">分析历史</div>
            <div className="hist-box">
              {!insight.history.length ? (
                <div className="note">还没有分析记录，从上面的快捷问题开始吧。</div>
              ) : (
                insight.history.map((entry, index) => (
                  <div className="hist-item" key={index} onClick={() => insight.ask(entry.q)}>
                    <span className="lt mono">{entry.at}</span>
                    <span>{entry.q}</span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
