import { type ChangeEvent, useMemo, useState } from "react";
import { type AnalyticsAuthorityMode, useAnalyticsAuthority } from "./analytics-authority";
import { AccessibleAnalyticsChart } from "./AccessibleAnalyticsChart";
import {
  ANALYTICS_QUESTIONS,
  AnalyticsImportError,
  analyticsKpis,
  importAnalyticsCsv,
  listBuiltInAnalyticsDatasets,
  MAX_ANALYTICS_CSV_BYTES,
  runAnalyticsQuestion,
} from "./analytics-model";
import type { AnalyticsDataset, AnalyticsReport } from "./analytics-types";
import { createAnalyticsReportExport, type AnalyticsExportFormat, type AnalyticsExportArtifact } from "./report-export";
import "./analytics.css";

function percent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function number(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function evidenceNumber(value: number | null): string {
  if (value == null) return "—";
  if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2);
  return number(value, 4);
}

function triggerDownload(artifact: AnalyticsExportArtifact): void {
  const url = URL.createObjectURL(new Blob([artifact.text], { type: artifact.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ReportView({ report }: { readonly report: AnalyticsReport }) {
  return (
    <section className="panel analytics-report" aria-labelledby="analytics-report-heading">
      <div className="panel-heading analytics-report-heading">
        <div>
          <p className="eyebrow">LOCAL RULES + STATISTICS / AUDITABLE</p>
          <h2 id="analytics-report-heading">{report.title}</h2>
        </div>
        <span className={`analytics-confidence analytics-confidence-${report.confidence}`}>
          可信度：{report.confidence}
        </span>
      </div>
      <p className="analytics-engine-note">
        计算引擎：<strong>本地规则引擎（非 AI）</strong> · {report.rowCount} 行 · 意图 {report.intent}
      </p>
      <div className="analytics-verdict" role="status" aria-live="polite">
        <strong>结论</strong>
        <p>{report.verdict}</p>
      </div>

      {report.chart ? <AccessibleAnalyticsChart chart={report.chart} /> : null}

      {report.evidence.length ? (
        <div className="analytics-evidence">
          <h3>统计证据</h3>
          <div className="analytics-table-scroll">
            <table aria-label="分析报告统计证据">
              <thead>
                <tr>
                  <th scope="col">主张</th>
                  <th scope="col">方法</th>
                  <th scope="col">n</th>
                  <th scope="col">统计量</th>
                  <th scope="col">95% CI</th>
                  <th scope="col">p 值</th>
                </tr>
              </thead>
              <tbody>
                {report.evidence.map((item, index) => (
                  <tr key={`${item.claim}-${index}`}>
                    <th scope="row">{item.claim}</th>
                    <td>{item.method}</td>
                    <td>{item.n}</td>
                    <td>{evidenceNumber(item.statistic)}</td>
                    <td>{item.ci95 ? `${evidenceNumber(item.ci95[0])} – ${evidenceNumber(item.ci95[1])}` : "—"}</td>
                    <td>{evidenceNumber(item.pValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="muted">此分析维度没有生成可单列的统计检验证据；请结合报告口径审阅。</p>
      )}

      <div className="analytics-sections">
        {report.sections.map((section, index) => (
          <article key={`${section.h}-${index}`}>
            <h3>{section.h}</h3>
            <ul>
              {section.lines.map((line, lineIndex) => (
                <li key={`${lineIndex}-${line}`}>{line}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

export interface AnalyticsPageProps {
  readonly authorityMode?: AnalyticsAuthorityMode;
  readonly apiBase?: string | null;
}

export function AnalyticsPage({ authorityMode = "browser", apiBase = null }: AnalyticsPageProps = {}) {
  const builtIns = useMemo(listBuiltInAnalyticsDatasets, []);
  const initialDataset = builtIns[0]!;
  const [uploads, setUploads] = useState<readonly AnalyticsDataset[]>([]);
  const [dataset, setDataset] = useState<AnalyticsDataset>(initialDataset);
  const [question, setQuestion] = useState<string>(ANALYTICS_QUESTIONS[0]);
  const [report, setReport] = useState<AnalyticsReport>(() =>
    runAnalyticsQuestion(ANALYTICS_QUESTIONS[0], initialDataset)
  );
  const [formError, setFormError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const authority = useAnalyticsAuthority(authorityMode, apiBase);
  const datasets = useMemo(() => [...builtIns, ...uploads], [builtIns, uploads]);
  const kpis = useMemo(() => analyticsKpis(dataset), [dataset]);

  const selectDataset = (id: string) => {
    const next = datasets.find((candidate) => candidate.id === id);
    if (!next) return;
    setDataset(next);
    const nextReport = runAnalyticsQuestion(question, next);
    setReport(nextReport);
    void authority.run(question, next, nextReport);
    setFormError("");
  };

  const run = () => {
    try {
      const nextReport = runAnalyticsQuestion(question, dataset);
      setReport(nextReport);
      void authority.run(question, dataset, nextReport);
      setFormError("");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "分析失败");
    }
  };

  const onCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setImportMessage("");
    try {
      const imported = await importAnalyticsCsv(file);
      setUploads((current) => [...current.filter((item) => item.id !== imported.id), imported]);
      setDataset(imported);
      const nextReport = runAnalyticsQuestion(question, imported);
      setReport(nextReport);
      void authority.run(question, imported, nextReport);
      setImportMessage(
        imported.warnings.length
          ? `已导入 ${imported.rows.length} 行；${imported.warnings.join("；")}`
          : authorityMode === "shadow"
            ? `已导入 ${imported.rows.length} 行；已发送归一化数据行用于 C# 影子比对`
            : `已导入 ${imported.rows.length} 行；文件内容仅在本地处理`
      );
    } catch (reason) {
      const message = reason instanceof AnalyticsImportError ? reason.message : "导入 CSV 失败";
      setImportMessage(message);
    } finally {
      setImporting(false);
    }
  };

  const exportReport = (format: AnalyticsExportFormat) => {
    triggerDownload(
      createAnalyticsReportExport(report, format, {
        basename: `forgex-${report.intent}-${dataset.id}`,
      })
    );
  };

  return (
    <div className="page-stack analytics-page">
      <section className="hero-panel">
        <p className="eyebrow">ANALYTICS / STAGE 2 VERTICAL SLICE</p>
        <h1>数据来源、规则判断与统计证据保持在同一份可审计报告中。</h1>
        <p className="hero-copy">
          内置数据与本地 CSV 始终先由既有规则引擎计算并显示；
          {authorityMode === "shadow"
            ? "当前显式启用了 C# 影子比对，运行分析时会经 Node 发送归一化数据行，但不会用影子结果替换页面报告。"
            : "当前为 browser 模式，不发送 Analytics 网络请求。"}
          本页面不把规则引擎描述为 AI。
        </p>
      </section>

      <section className="panel analytics-controls" aria-labelledby="analytics-data-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DATASET / LOCAL ONLY</p>
            <h2 id="analytics-data-heading">选择数据与问题</h2>
          </div>
          <span className="analytics-row-count">{dataset.rows.length} 行</span>
        </div>

        <div className="analytics-control-grid">
          <label>
            <span>当前数据集</span>
            <select value={dataset.id} onChange={(event) => selectDataset(event.target.value)}>
              {datasets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.rows.length} 行
                </option>
              ))}
            </select>
          </label>
          <label className="analytics-file-input">
            <span>导入本地 CSV</span>
            <input type="file" accept=".csv,text/csv" onChange={(event) => void onCsv(event)} disabled={importing} />
            <small>最大 {MAX_ANALYTICS_CSV_BYTES / 1024 / 1024} MB · 最多解析 5,000 行</small>
          </label>
        </div>

        <aside className="analytics-provenance" data-kind={dataset.kind} aria-label="数据来源声明">
          <strong>
            来源：{dataset.label}
            {dataset.provenance.badge && dataset.provenance.badge !== dataset.label
              ? ` · ${dataset.provenance.badge}`
              : ""}{" "}
            · {dataset.provenance.synthetic ? "非真实产线数据" : "用户提供"}
          </strong>
          <p>{dataset.description}</p>
          <p>{dataset.provenance.note}</p>
          {dataset.provenance.generator ? (
            <code>
              {dataset.provenance.generator.name} v{dataset.provenance.generator.version} · seed{" "}
              {dataset.provenance.generator.seed ?? "n/a"}
            </code>
          ) : null}
        </aside>
        {importMessage ? (
          <p className={importMessage.startsWith("已导入") ? "analytics-import-ok" : "error-copy"} role="status">
            {importMessage}
          </p>
        ) : null}

        <div className="analytics-question-grid">
          <label>
            <span>快速问题</span>
            <select defaultValue="" onChange={(event) => event.target.value && setQuestion(event.target.value)}>
              <option value="" disabled>
                选择分析维度
              </option>
              {ANALYTICS_QUESTIONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>问题</span>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
          </label>
          <button type="button" className="analytics-run" onClick={run}>
            运行规则分析
          </button>
        </div>
        {formError ? (
          <p className="error-copy" role="alert">
            {formError}
          </p>
        ) : null}
      </section>

      <section className="analytics-kpis" aria-label="数据集关键指标">
        <article>
          <span>任务数</span>
          <strong>{number(kpis.total, 0)}</strong>
        </article>
        <article>
          <span>良率</span>
          <strong>{percent(kpis.yield)}</strong>
        </article>
        <article>
          <span>良品平均成本</span>
          <strong>¥{number(kpis.avgCostFen / 100)}</strong>
        </article>
        <article>
          <span>耗材 / 能耗</span>
          <strong>
            {number(kpis.filamentKg, 3)} kg / {number(kpis.energyKwh)} kWh
          </strong>
        </article>
        <article>
          <span>重点线索</span>
          <strong>
            {kpis.worstMachine ? `${kpis.worstMachine.id} · ${percent(kpis.worstMachine.failRate)}` : "样本不足"}
          </strong>
        </article>
      </section>

      <div className="analytics-export-bar" aria-label="报告导出">
        <span>导出内容包含来源标记、引擎、结论、证据和图表数据。</span>
        <button type="button" onClick={() => exportReport("json")}>
          导出 JSON
        </button>
        <button type="button" onClick={() => exportReport("csv")}>
          导出 CSV
        </button>
      </div>

      <section className={`panel analytics-authority analytics-authority-${authority.state.status}`} aria-live="polite">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AUTHORITY / {authorityMode.toUpperCase()}</p>
            <h2>C# 字段级影子比对</h2>
          </div>
          <strong>{authority.state.status}</strong>
        </div>
        <p>{authority.state.detail}</p>
        {"engineVersion" in authority.state ? (
          <p className="muted">
            引擎版本：{authority.state.engineVersion} · 已比较 {authority.state.comparedFields} 个字段
          </p>
        ) : null}
        {authority.state.status === "mismatch" ? (
          <div className="analytics-table-scroll">
            <table aria-label="C# Analytics 影子差异">
              <thead>
                <tr>
                  <th scope="col">字段</th>
                  <th scope="col">浏览器 JS</th>
                  <th scope="col">C#</th>
                </tr>
              </thead>
              <tbody>
                {authority.state.differences.map((difference) => (
                  <tr key={difference.field}>
                    <th scope="row">{difference.field}</th>
                    <td>{difference.expected}</td>
                    <td>{difference.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <ReportView report={report} />
    </div>
  );
}
