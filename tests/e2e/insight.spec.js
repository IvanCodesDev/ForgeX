/* 洞察面板 —— 覆盖「界面说了假话」这一类。

   这是整个重构最该被守住的地方。P0 到 P3 修掉的那些问题，
   大多数在纯逻辑层面是看不出来的：
     - 报告里算出了置信区间，但界面只显示点估计；
     - 引擎是规则引擎，标签却写着「AI」；
     - 数据是合成的，界面上不标；
     - 结论不显著，措辞却像已定论。
   这些只有把界面渲染出来、读上面的字才能验证。 */
"use strict";

const { test, expect } = require("@playwright/test");

async function openInsight(page) {
  await page.goto("/");
  await page.waitForFunction(() => window.FX && window.FX.insight, null, { timeout: 30_000 });
  const pill = page.locator("#pill-insight");
  await pill.click();
  const body = page.locator("#insight-body");
  if (!(await body.isVisible())) await pill.click();
  await expect(body).toBeVisible();
  return body;
}

/** 提问并等报告渲染完成 */
async function ask(page, question) {
  await page.locator(".ask-input").fill(question);
  await page.locator(".ask-btn").click();
  await expect(page.locator(".report-box .rp-title")).toBeVisible({ timeout: 30_000 });
  return page.locator(".report-box");
}

test.describe("数据来源标记", () => {
  test("合成数据在数据接入区与报告里都有标记", async ({ page }) => {
    await openInsight(page);

    // 数据集 chip 上的徽章
    const badge = page.locator(".chip .ds-badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/机群仿真|合成|仿真/);

    // 来源说明必须显式说清楚它不是真实产线数据
    const note = page.locator("#insight-body .note.note-synth").first();
    await expect(note).toBeVisible();
    await expect(note).toContainText(/物理仿真|合成/);

    const report = await ask(page, "哪台机故障率最高");
    // 报告里也要标——只在数据接入区标一次不够，报告会被分享出去
    await expect(report.locator(".rp-prov.synth")).toBeVisible();
    await expect(report.locator(".rp-prov.synth")).toContainText(/仿真|合成/);
  });
});

test.describe("引擎标识不冒充 AI", () => {
  test("规则引擎必须自称规则引擎", async ({ page }) => {
    await openInsight(page);
    // 面板标题栏的标识
    await expect(page.locator("#insight-engine-tag")).toHaveText(/规则/);
    // 引擎说明必须明确否定 AI
    await expect(page.locator("#insight-body .note").first()).toContainText(/不是 AI/);

    const report = await ask(page, "哪台机故障率最高");
    const tag = await report.locator(".ph-tag").first().textContent();
    expect(tag).toMatch(/规则引擎/);
    expect(tag).not.toMatch(/云端 AI/);
  });
});

test.describe("统计严谨性在界面上可见", () => {
  test("显著结论：带置信区间、p 值、可信度与证据链", async ({ page }) => {
    await openInsight(page);
    const report = await ask(page, "哪台机故障率最高，主要故障是什么");

    const verdict = await report.locator(".verdict").textContent();
    expect(verdict).toMatch(/95%CI/);          // 区间必须出现在结论里，不能只在明细里
    expect(verdict).toMatch(/p[<=]/);

    // 可信度徽章
    const conf = report.locator(".rp-conf");
    await expect(conf).toBeVisible();
    await expect(conf).toContainText(/可信度|样本不足/);

    // 证据链：默认折叠，但必须存在且可展开
    const evi = report.locator(".rp-evi");
    await expect(evi).toBeVisible();
    await expect(evi.locator("summary")).toContainText(/计算依据/);
    expect(await evi.evaluate((el) => el.open)).toBe(false);   // 默认折叠，不打扰
    await evi.locator("summary").click();
    const items = evi.locator(".evi-item");
    expect(await items.count()).toBeGreaterThan(0);
    // 每条证据都要写明用了什么方法
    await expect(items.first().locator(".evi-meta")).toContainText(/检验|相关|区间/);
  });

  test("图表画出 95% 置信区间误差线（证据强度要看得见）", async ({ page }) => {
    await openInsight(page);
    const report = await ask(page, "哪台机故障率最高");

    await expect(report.locator(".rp-chart canvas")).toBeVisible();
    // 误差线端点来自 chart items 的 ciLo/ciHi；没有它们就画不出来
    const chart = await page.evaluate(() => {
      const c = window.FX.insight._report.chart;
      return { kind: c.kind, items: c.items.length, withCi: c.items.filter((i) => i.ciLo != null).length };
    });
    expect(chart.kind).toBe("bar-rate");
    expect(chart.withCi).toBe(chart.items);

    // canvas 真的被绘制了（不是空白）——取像素校验，避免「元素在但没画」
    const painted = await page.evaluate(() => {
      const cv = document.querySelector(".rp-chart canvas");
      const ctx = cv.getContext("2d");
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let nonBlank = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBlank++;
      return nonBlank;
    });
    expect(painted).toBeGreaterThan(500);
  });

  test("不显著时措辞必须收住，且可信度降为 low", async ({ page }) => {
    await openInsight(page);
    // 注入一份差异微弱的数据：5/20 vs 4/20，Fisher p=1.0
    await page.evaluate(() => {
      const mk = (m, n, f) =>
        Array.from({ length: n }, (_, i) => ({
          job_id: m + i, date: "2026-07-01", machine_id: m,
          model_name: "件A", material: "PLA", layer_height_mm: 0.2,
          duration_min: 100, filament_g: 30, cost_fen: 300,
          status: i < f ? "fail" : "success", fail_reason: i < f ? "堵料" : "", energy_kwh: 0.4,
        }));
      window.FX.insight.store.setUpload(mk("A", 20, 5).concat(mk("B", 20, 4)));
    });
    const report = await ask(page, "哪台机故障率最高");

    const verdict = await report.locator(".verdict").textContent();
    expect(verdict).toMatch(/未达统计显著/);
    expect(verdict).not.toMatch(/显著高于/);

    await expect(report.locator(".rp-conf.c-low")).toBeVisible();
    await expect(report.locator(".rp-conf")).toContainText(/证据不足/);
  });

  test("样本全都不足时拒绝排名，而不是硬挑一个", async ({ page }) => {
    await openInsight(page);
    await page.evaluate(() => {
      window.FX.insight.store.setUpload([
        { job_id: "1", date: "2026-07-01", machine_id: "TINY", model_name: "x", material: "PLA",
          layer_height_mm: 0.2, duration_min: 10, filament_g: 5, cost_fen: 50,
          status: "fail", fail_reason: "堵料", energy_kwh: 0.1 },
      ]);
    });
    const report = await ask(page, "哪台机故障率最高");
    await expect(report.locator(".verdict")).toContainText(/样本不足/);
    await expect(report.locator(".rp-conf.c-insufficient-data")).toBeVisible();
    // 100% 故障率的单样本机台绝不能被当成结论抛出来
    expect(await report.locator(".verdict").textContent()).not.toMatch(/TINY 故障率最高/);
  });
});

test.describe("听不懂就说听不懂", () => {
  test("未命中分析维度时明说，并列出支持的维度", async ({ page }) => {
    await openInsight(page);
    const report = await ask(page, "今天天气怎么样");
    await expect(report.locator(".rp-title")).toContainText(/未识别/);
    const text = await report.textContent();
    expect(text).toMatch(/没有匹配到分析维度|机台故障率排行/);
  });
});

test.describe("KPI 看板", () => {
  test("时间跨度按数据实算，机台编号原样显示", async ({ page }) => {
    await openInsight(page);
    const tiles = page.locator(".kpi-tile");
    expect(await tiles.count()).toBe(4);

    // 曾经无条件写死「近三周」
    const sub = await tiles.first().locator(".kt-sub").textContent();
    expect(sub).not.toMatch(/近三周/);
    expect(sub).toMatch(/\d{4}-\d{2}-\d{2}/);

    // 曾经硬剥 "FX-256-" 前缀，别的编号体系会显示错乱
    const worst = await tiles.nth(3).locator(".kt-val").textContent();
    if (worst.trim() !== "—") expect(worst).toMatch(/^FX-/);
  });
});

test.describe("机群视图", () => {
  test("从分析结论进入机群视图并能退出", async ({ page }) => {
    await openInsight(page);
    const report = await ask(page, "哪台机故障率最高");

    const btn = report.locator("button", { hasText: /机群视图中定位/ });
    await expect(btn).toBeVisible();
    await btn.click();

    // 机群建起来了，详细打印机让位
    const state = await page.evaluate(() => ({
      visible: window.FX.fx.fleet.group.visible,
      count: window.FX.fx.fleet.entries.length,
      printerHidden: !window.FX.fx.printer.group.visible,
      highlighted: window.FX.fx.fleet.entries.filter((e) => e.highlighted).length,
    }));
    expect(state.visible).toBe(true);
    expect(state.count).toBeGreaterThan(1);
    expect(state.printerHidden).toBe(true);
    expect(state.highlighted).toBe(1);

    // 证据强度编码：样本不足的机台必须更透明
    const opacity = await page.evaluate(() =>
      window.FX.fx.fleet.entries.map((e) => ({ id: e.machine.id, o: e.machine.status.opacity })));
    expect(opacity.every((x) => x.o > 0 && x.o <= 1)).toBe(true);

    // 必须有明确的回头路
    const exit = page.locator("#fleet-exit");
    await expect(exit).toBeVisible();
    await exit.click();
    const after = await page.evaluate(() => ({
      visible: window.FX.fx.fleet.group.visible,
      printerVisible: window.FX.fx.printer.group.visible,
    }));
    expect(after.visible).toBe(false);
    expect(after.printerVisible).toBe(true);
    await expect(exit).toBeHidden();
  });
});

test.describe("进度是真实的", () => {
  test("走后端时渲染服务端推来的阶段，而不是固定动画", async ({ page }) => {
    await openInsight(page);
    // 拦下 SSE 事件，验证界面阶段来自后端而非本地写死
    const stages = [];
    page.on("console", (m) => {
      if (m.text().startsWith("__stage__")) stages.push(m.text().slice(9));
    });
    await page.evaluate(() => {
      const orig = window.FXApiClient.stream;
      window.FXApiClient.stream = function (taskId, onEvent, onDone, onError) {
        return orig.call(this, taskId, (ev) => { console.log("__stage__" + (ev.stage || "")); onEvent(ev); }, onDone, onError);
      };
    });
    await ask(page, "成本趋势与拆解");
    // 后端规则引擎会推 intent / aggregate / generate 三个真实阶段
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.join(",")).toMatch(/intent|aggregate|generate/);
  });
});
