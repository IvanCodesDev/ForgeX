import { useId } from "react";
import type { AnalyticsChart } from "./analytics-types";

interface AccessibleAnalyticsChartProps {
  readonly chart: AnalyticsChart;
}

function formatValue(kind: string, value: number): string {
  if (kind.includes("rate")) {
    return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
}

export function AccessibleAnalyticsChart({ chart }: AccessibleAnalyticsChartProps) {
  const titleId = useId();
  const descriptionId = useId();
  const maxValue = Math.max(1, ...chart.items.map((item) => Math.abs(item.value)));
  const chartHeight = Math.max(150, chart.items.length * 44 + 34);

  return (
    <figure className="analytics-chart">
      <svg viewBox={`0 0 720 ${chartHeight}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{chart.title}</title>
        <desc id={descriptionId}>横向条形图；相同数据同时列于图表下方的表格中。</desc>
        {chart.items.map((item, index) => {
          const y = index * 44 + 12;
          const width = Math.max(2, (Math.abs(item.value) / maxValue) * 390);
          return (
            <g key={`${item.label}-${index}`}>
              <text x="0" y={y + 17} className="analytics-chart-label">
                {item.label.slice(0, 18)}
              </text>
              <rect
                x="190"
                y={y}
                width={width}
                height="24"
                rx="5"
                className={item.weak ? "analytics-chart-bar analytics-chart-bar-weak" : "analytics-chart-bar"}
              >
                <title>{`${item.label}：${formatValue(chart.kind, item.value)}${item.hint ? `；${item.hint}` : ""}`}</title>
              </rect>
              <text x={Math.min(620, 202 + width)} y={y + 17} className="analytics-chart-value">
                {formatValue(chart.kind, item.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>{chart.title}</figcaption>
      <div className="analytics-table-scroll">
        <table aria-label={`${chart.title}数据表`}>
          <thead>
            <tr>
              <th scope="col">项目</th>
              <th scope="col">数值</th>
              <th scope="col">说明</th>
            </tr>
          </thead>
          <tbody>
            {chart.items.map((item, index) => (
              <tr key={`${item.label}-${index}`}>
                <th scope="row">{item.label}</th>
                <td>{formatValue(chart.kind, item.value)}</td>
                <td>{item.hint ?? (item.weak ? "样本量不足，仅作线索" : "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
