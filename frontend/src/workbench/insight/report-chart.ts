import type { InsightChart } from "../../legacy/engine";

/** 报告图表：横向条（比率/数值）与折线，琥珀色系。与遗留 _drawChart 逐行对应。 */
export function drawReportChart(cv: HTMLCanvasElement, chart: InsightChart): void {
  const items = chart.items;
  const W = 356;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const isLine = chart.kind === "line";
  const H = isLine ? 150 : items.length * 30 + 10;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = "100%";
  const c = cv.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);

  let maxV = 0;
  for (const item of items) maxV = Math.max(maxV, item.value);
  if (maxV <= 0) maxV = 1;

  if (isLine) {
    const n = items.length;
    const X = (i: number) => 14 + (i / Math.max(1, n - 1)) * (W - 28);
    const Y = (v: number) => H - 24 - (v / maxV) * (H - 46);
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(255,106,43,0.22)");
    grad.addColorStop(1, "rgba(255,106,43,0)");
    c.beginPath();
    items.forEach((item, p) => (p ? c.lineTo(X(p), Y(item.value)) : c.moveTo(X(p), Y(item.value))));
    c.strokeStyle = "#f0561a";
    c.lineWidth = 1.8;
    c.stroke();
    c.lineTo(X(n - 1), H - 20);
    c.lineTo(X(0), H - 20);
    c.closePath();
    c.fillStyle = grad;
    c.fill();
    c.fillStyle = "#5a6270";
    c.font = "9px Consolas";
    c.textAlign = "center";
    const step = Math.max(1, Math.ceil(n / 7));
    for (let q = 0; q < n; q += step) c.fillText(items[q]?.label ?? "", X(q), H - 8);
    return;
  }

  const isRate = chart.kind === "bar-rate";
  c.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
  const bx = 84;
  const trackW = W - 150;
  items.forEach((it, k) => {
    const y = 8 + k * 30;
    const frac = isRate ? Math.min(1, it.value) : it.value / maxV;
    const barW = Math.max(2, frac * trackW);
    const hot = isRate ? it.value >= 0.15 : k === 0;
    // 样本不足的条目整体压暗：视觉上就不该和有证据的条目等量齐观
    c.globalAlpha = it.weak ? 0.42 : 1;
    c.fillStyle = "#1d222b";
    c.textAlign = "left";
    c.fillText(it.label, 0, y + 13);
    c.fillStyle = "rgba(29,34,43,0.08)";
    c.fillRect(bx, y + 4, trackW, 12);
    c.fillStyle = hot ? "#f0561a" : "rgba(79,131,224,0.6)";
    c.fillRect(bx, y + 4, barW, 12);

    // 95% 置信区间误差线：让「证据强度」变成看得见的东西
    if (isRate && it.ciLo != null && it.ciHi != null) {
      const xLo = bx + Math.min(1, it.ciLo) * trackW;
      const xHi = bx + Math.min(1, it.ciHi) * trackW;
      const cy = y + 10;
      c.strokeStyle = "rgba(29,34,43,0.55)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(xLo, cy);
      c.lineTo(xHi, cy);
      c.moveTo(xLo, cy - 4);
      c.lineTo(xLo, cy + 4);
      c.moveTo(xHi, cy - 4);
      c.lineTo(xHi, cy + 4);
      c.stroke();
    }

    c.fillStyle = "#5a6270";
    c.font = "10px Consolas";
    c.fillText(isRate ? (it.value * 100).toFixed(1) + "%" : String(Math.round(it.value)), bx + trackW + 6, y + 14);
    c.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    c.globalAlpha = 1;
  });
}
