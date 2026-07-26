/* FORGE·X 智造洞察 — 面板层：数据接入 / KPI 看板 / 提问 / 报告与图表 / 3D 视口联动
   引擎路由：后端可用走后端（规则引擎或云端 provider），否则走浏览器内的本地规则引擎。
   ⚠ 本地与后端的默认引擎都是**规则引擎，不是 AI**，界面文案不得混淆二者。 */
(function (root) {
  "use strict";

  var $ = FXU.$, el = FXU.el, esc = FXU.esc;

  var QUICK_QUESTIONS = [
    "哪台机故障率最高，主要故障是什么",
    "各材料的失败率对比",
    "层高与打印时长的相关性",
    "成本趋势与拆解",
    "失败批次有没有共性",
  ];

  /* 仿真器故障名 → 标准故障词表的映射，已收敛到 FXInsightData.normalizeFault()
     （单一真源，与虚拟机群 tools/farm-sim.js 共用同一套规则）。
     未命中一律记为「未知」——历史上这里兜底猜成「热失控」，会往数据集里写入错误的故障类型。 */

  var CONFIDENCE_LABEL = {
    high: "可信度：高",
    medium: "可信度：中",
    low: "可信度：低",
    "insufficient-data": "样本不足",
  };

  /** 引擎标识 → 界面文案。规则引擎必须自称规则引擎，只有真 AI provider 才能带「AI」字样。 */
  function ENGINE_LABEL(id) {
    switch (id) {
      case "infinisynapse": return "InfiniSynapse 云端 AI";
      case "server-rules": return "后端规则引擎（无 AI）";
      case "local-rules": return "本地规则引擎（无 AI）";
      default: return id ? String(id) : "未知引擎";
    }
  }

  class FXInsight {
    constructor(sim, fx, bus, ui) {
      this.sim = sim;
      this.fx = fx;
      this.bus = bus;
      this.ui = ui;
      this.store = new FXInsightData.Store(bus);
      this.history = [];
      this._busy = false;
      this._report = null;

      this.panel = $("#insight-panel");
      this.body = $("#insight-body");

      $("#insight-close").addEventListener("click", function () { this.hide(); }.bind(this));
      $("#csv-input").addEventListener("change", this._onCsvPicked.bind(this));

      // 导航互斥：点其他流程页关闭洞察；点「洞察」胶囊开关本面板
      bus.on("insight-toggle", this.toggle.bind(this));
      bus.on("ctx-open", this.hide.bind(this));
      bus.on("insight-data", this._refreshData.bind(this));
      // 模拟器完成/故障中止 → 采集运行数据（自洽闭环）
      bus.on("job-record", this._onSimRecord.bind(this));

      // 后端探测：可用则切云端引擎标识
      FXApiClient.probe().then(this._refreshEngineTag.bind(this));

      this._build();
    }

    /* ── 面板开关 ─────────────────────────── */

    toggle(pillEl) {
      if (this.panel.hidden) this.show(pillEl);
      else this.hide();
    }
    show(pillEl) {
      if (this.ui) this.ui._closeCtx();               // 与左侧流程卡互斥
      if (pillEl && pillEl.classList) pillEl.classList.add("on");
      this.panel.hidden = false;
      this.panel.classList.add("entering");
      setTimeout(function () { this.panel.classList.remove("entering"); }.bind(this), 360);
      this._refreshData();
    }
    hide() {
      if (this.panel.hidden) return;
      this.panel.hidden = true;
      var pill = $("#pill-insight");
      if (pill) pill.classList.remove("on");
    }

    /* ── 静态骨架 ─────────────────────────── */

    _build() {
      var b = this.body;
      b.innerHTML = "";

      /* 引擎状态说明（真实性自证：当前分析跑在哪、如何切云端） */
      this._engineNote = el("div", "note");
      this._engineNote.hidden = true;
      b.appendChild(this._engineNote);

      /* 数据接入 */
      b.appendChild(el("div", "sec-label", "数据接入"));
      var dsRow = el("div", "chip-row");
      this._dsRow = dsRow;
      b.appendChild(dsRow);
      /* 当前数据集来源说明（合成数据的显著提示位） */
      this._provNote = el("div", "note");
      this._provNote.hidden = true;
      b.appendChild(this._provNote);
      var btnRow = el("div", "prow ins-actions");
      var upBtn = el("button", "mini-btn", "上传 CSV");
      upBtn.addEventListener("click", function () { $("#csv-input").click(); });
      var dlBtn = el("button", "mini-btn", "下载机群数据");
      dlBtn.title = "由虚拟机群物理仿真产出，非真实产线数据";
      dlBtn.addEventListener("click", function () {
        FXInsightData.downloadCsv(this.store.sets.farm.rows, "print_farm.csv");
      }.bind(this));
      var simBtn = el("button", "mini-btn", "导出本机采集");
      simBtn.addEventListener("click", function () {
        var rows = this.store.sets.sim.rows;
        if (!rows.length) return this.ui.toast("暂无本机采集数据 — 先跑一次打印任务", "warn");
        FXInsightData.downloadCsv(rows, "sim_jobs.csv");
      }.bind(this));
      btnRow.append(upBtn, dlBtn, simBtn);
      b.appendChild(btnRow);

      /* KPI 看板 */
      b.appendChild(el("div", "sec-label", "关键指标"));
      this._kpiGrid = el("div", "kpi-grid");
      b.appendChild(this._kpiGrid);

      /* 提问 */
      b.appendChild(el("div", "sec-label", "自然语言分析"));
      var askRow = el("div", "ask-row");
      var input = el("input", "ask-input");
      input.type = "text";
      input.placeholder = "问点什么，比如：哪台机故障率最高";
      input.maxLength = 120;
      var askBtn = el("button", "btn btn-primary ask-btn", "分析");
      var run = function () { this.ask(input.value); }.bind(this);
      askBtn.addEventListener("click", run);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
      askRow.append(input, askBtn);
      b.appendChild(askRow);
      this._askInput = input;
      this._askBtn = askBtn;

      var quick = el("div", "chip-row quick-qs");
      for (var i = 0; i < QUICK_QUESTIONS.length; i++) {
        (function (q, self) {
          var c = el("div", "chip sm", q);
          c.addEventListener("click", function () { input.value = q; self.ask(q); });
          quick.appendChild(c);
        })(QUICK_QUESTIONS[i], this);
      }
      b.appendChild(quick);

      /* 进度 / 报告 / 历史容器 */
      this._progress = el("div", "ai-steps");
      this._progress.hidden = true;
      b.appendChild(this._progress);
      this._reportBox = el("div", "report-box");
      b.appendChild(this._reportBox);
      b.appendChild(el("div", "sec-label", "分析历史"));
      this._histBox = el("div", "hist-box");
      b.appendChild(this._histBox);
      this._renderHistory();

      this._refreshData();
    }

    /* ── 数据集 ───────────────────────────── */

    _refreshData() {
      // 数据集 chips —— 合成数据必须带可见标记
      var row = this._dsRow;
      row.innerHTML = "";
      var sets = this.store.sets;
      for (var key in sets) {
        (function (k, self) {
          var s = sets[k];
          var p = s.provenance || {};
          var c = el("div", "chip sm" + (self.store.active === k ? " on" : "") + (p.synthetic ? " synth" : ""),
            esc(s.label) + " · " + s.rows.length + (p.badge ? ' <i class="ds-badge">' + esc(p.badge) + "</i>" : ""));
          if (p.note) c.title = p.note;
          c.addEventListener("click", function () {
            if (!s.rows.length) return self.ui.toast(k === "sim" ? "还没有本机采集数据，先完成一次打印" : "该数据集为空，请先上传", "warn");
            self.store.use(k);
          });
          row.appendChild(c);
        })(key, this);
      }

      // 当前数据集的来源说明（合成数据在这里必须说清楚）
      var prov = this.store.provenance();
      if (this._provNote) {
        this._provNote.hidden = false;
        this._provNote.className = "note" + (prov.synthetic ? " note-synth" : "");
        this._provNote.innerHTML = prov.synthetic
          ? "⚠ <b>" + esc(prov.badge) + "数据</b>：" + esc(prov.note)
          : "数据来源：" + esc(prov.note);
      }

      // KPI
      var rows = this.store.rows();
      var g = this._kpiGrid;
      g.innerHTML = "";
      if (!rows.length) {
        g.appendChild(el("div", "note", "当前数据集为空。"));
        return;
      }
      var k = FXInsightEngine.kpis(rows);
      var MIN_N = FXInsightEngine.MIN_SAMPLE;
      var tiles = [
        // 时间跨度按数据实际计算，不再无条件写「近三周」
        { lab: "任务总数", val: String(k.total), sub: k.dateRange ? k.dateRange.label : "无日期列" },
        { lab: "综合良率", val: (k.yield * 100).toFixed(1) + "%", sub: "良品 " + Math.round(k.yield * k.total) + " 件", cls: k.yield >= 0.9 ? "good" : k.yield >= 0.8 ? "mid" : "bad" },
        { lab: "良品均本", val: "¥" + (k.avgCostFen / 100).toFixed(2), sub: "耗材+能耗+机时（估算口径）" },
        // 机台 ID 原样显示（旧代码写死 .replace("FX-256-","")，别的编号体系会显示错乱）
        k.worstMachine
          ? { lab: "失败率最高", val: k.worstMachine.id,
              sub: (k.worstMachine.failRate * 100).toFixed(0) + "% · n=" + k.worstMachine.n + (k.topReason ? " · " + k.topReason.name : ""),
              cls: k.worstMachine.failRate > 0.15 ? "bad" : "" }
          : { lab: "失败率最高", val: "—", sub: "无机台达到 " + MIN_N + " 个任务的最小样本量" },
      ];
      for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        g.appendChild(el("div", "kpi-tile" + (t.cls ? " k-" + t.cls : ""),
          '<div class="kt-lab">' + t.lab + '</div><div class="kt-val mono">' + esc(t.val) + '</div><div class="kt-sub">' + esc(t.sub) + "</div>"));
      }
    }

    _onCsvPicked(e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) return this.ui.toast("CSV 超过 4MB，请精简后重试", "err");
      var rd = new FileReader();
      rd.onload = function () {
        var out = FXInsightData.parseCsv(rd.result);
        if (!out.rows.length) return this.ui.toast("解析失败：" + (out.errors[0] || "无有效数据"), "err");
        this.store.setUpload(out.rows);
        var msg = "已导入 " + out.rows.length + " 条记录";
        if (out.errors.length) msg += "（" + out.errors[0] + "）";
        this.ui.toast(msg, "ok");
      }.bind(this);
      rd.onerror = function () { this.ui.toast("文件读取失败", "err"); }.bind(this);
      rd.readAsText(f, "utf-8");
    }

    _onSimRecord(d) {
      // 归不了类就如实写「未知」，不猜——猜错会污染整个数据集的故障归因
      var reason = d.status === "fail" ? FXInsightData.normalizeFault(d.fault) : "";
      var rec = FXInsightData.recordFromSim(this.sim, d.status, reason);
      this.store.addSimRecord(rec);
      this.ui.toast("运行数据已采集 → 本机采集 " + rec.machine_id +
        "（共 " + this.store.sets.sim.rows.length + " 条）", "info");
    }

    /* ── 提问 → 分析 ──────────────────────── */

    ask(question) {
      question = String(question || "").trim();
      if (!question) return this.ui.toast("先输入要分析的问题", "warn");
      if (this._busy) return;
      var rows = this.store.rows();
      if (!rows.length) return this.ui.toast("当前数据集为空，请先载入数据", "warn");

      this._busy = true;
      this._askBtn.disabled = true;
      this._reportBox.innerHTML = "";
      this._resetProgress();

      if (FXApiClient.available) this._askRemote(question, rows);
      else this._askLocal(question, rows);
    }

    /** 本地规则引擎：同步计算，毫秒级返回。不插入任何人造延时或假分步。 */
    _askLocal(question, rows) {
      var t0 = Date.now();
      var report;
      try {
        report = FXInsightEngine.analyze(question, rows, { provenance: this.store.provenance() });
      } catch (err) {
        console.error("[insight]", err);
        this._finishAsk();
        this.ui.toast("分析出错：" + err.message, "err");
        return;
      }
      report.elapsedMs = Date.now() - t0;
      this._finishAsk();
      this._pushHistory(question);
      this._renderReport(report);
    }

    _askRemote(question, rows) {
      var self = this;
      var t0 = Date.now();
      this._pushStage("上传数据集（" + rows.length + " 行）", 0.05);
      FXApiClient.uploadDatasource(FXInsightData.toCsv(rows), "print_jobs.csv")
        .then(function (ds) {
          self._pushStage("提交分析任务", 0.12);
          return FXApiClient.analyze(question, ds.datasourceId);
        })
        .then(function (t) {
          return new Promise(function (resolve, reject) {
            // 渲染后端真实推送的阶段事件（旧实现这里传的是空函数，进度全丢）
            FXApiClient.stream(
              t.taskId,
              function (ev) { self._pushStage(ev.message || ev.stage || "处理中…", ev.progress); },
              function () { resolve(t.taskId); },
              reject
            );
          });
        })
        .then(function (taskId) {
          self._pushStage("拉取分析结果", 0.97);
          return FXApiClient.result(taskId);
        })
        .then(function (report) {
          self._pushStage("完成 · 耗时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s", 1);
          report.elapsedMs = Date.now() - t0;
          // 后端不知道浏览器侧数据集的来源标记，这里补齐，保证报告始终带 provenance
          if (!report.provenance) report.provenance = self.store.provenance();
          self._finishAsk();
          self._pushHistory(question);
          self._renderReport(report);
        })
        .catch(function (err) {
          console.error("[insight remote]", err);
          self._finishAsk();
          self.ui.toast("后端分析失败（" + err.message + "），已回退浏览器本地规则引擎", "warn");
          var report = FXInsightEngine.analyze(question, rows, { provenance: self.store.provenance() });
          report.fallbackFrom = "backend";
          self._pushHistory(question);
          self._renderReport(report);
        });
    }

    /* ── 进度：由真实事件驱动 ──────────────────
       原实现用三个 setTimeout 播固定动画、同时丢弃后端推来的真实事件，
       现改为每条阶段都对应一次真实的后端事件或本地状态变化。 */

    _resetProgress() {
      var p = this._progress;
      p.innerHTML = "";
      p.hidden = true;
      this._stageEls = [];
      this._bar = null;
    }

    _pushStage(message, progress) {
      var p = this._progress;
      if (p.hidden) {
        p.hidden = false;
        this._bar = el("div", "ai-bar", "<i></i>");
        p.appendChild(this._bar);
      }
      if (this._stageEls.length) {
        var prev = this._stageEls[this._stageEls.length - 1];
        prev.classList.remove("run");
        prev.classList.add("done");
      }
      var s = el("div", "ai-step run", '<span class="as-dot"></span><span>' + esc(message) + "</span>");
      p.appendChild(s);
      this._stageEls.push(s);
      if (this._bar && typeof progress === "number" && isFinite(progress)) {
        this._bar.firstChild.style.width = (Math.max(0, Math.min(1, progress)) * 100).toFixed(1) + "%";
      }
      // 云端任务事件很多，只保留最近 8 条，避免面板被撑爆
      while (this._stageEls.length > 8) {
        var old = this._stageEls.shift();
        if (old.parentNode) old.parentNode.removeChild(old);
      }
    }

    _finishAsk() {
      this._busy = false;
      this._askBtn.disabled = false;
      this._progress.hidden = true;
    }

    /* ── 报告渲染 ─────────────────────────── */

    _renderReport(report) {
      this._report = report;
      var box = this._reportBox;
      box.innerHTML = "";
      if (!report) return;

      // 引擎标注必须如实：规则引擎绝不冒充 AI，后端规则引擎绝不冒充 InfiniSynapse
      var head = el("div", "rp-head",
        '<span class="rp-title">' + esc(report.title || "分析报告") + '</span>' +
        '<span class="ph-tag mono">' + esc(ENGINE_LABEL(report.engine)) + " · " + (report.rowCount || 0) + " 行" +
        (report.elapsedMs != null ? " · " + (report.elapsedMs / 1000).toFixed(report.elapsedMs < 1000 ? 2 : 1) + "s" : "") + "</span>");
      box.appendChild(head);

      // 数据来源：合成数据必须在报告里也标出来，不能只在数据接入区标一次
      var prov = report.provenance;
      if (prov) {
        box.appendChild(el("div", "rp-prov" + (prov.synthetic ? " synth" : ""),
          (prov.synthetic ? "⚠ 基于<b>" + esc(prov.badge) + "数据</b>：" : "数据来源：") + esc(prov.note || prov.source || "")));
      }
      if (report.fallbackFrom === "backend") {
        box.appendChild(el("div", "rp-prov warnline", "后端不可用，本报告由浏览器本地规则引擎计算。"));
      }

      box.appendChild(el("div", "verdict", esc(report.verdict || "")));

      // 可信度：低于「中」时明确提示，避免用户把弱证据当结论
      if (report.confidence && CONFIDENCE_LABEL[report.confidence]) {
        box.appendChild(el("div", "rp-conf c-" + report.confidence,
          esc(CONFIDENCE_LABEL[report.confidence]) +
          (report.confidence === "high" || report.confidence === "medium" ? ""
            : " — 该结论证据不足，请补充数据后再据此决策")));
      }

      if (report.chart && report.chart.items && report.chart.items.length) {
        var wrap = el("div", "rp-chart");
        wrap.appendChild(el("div", "ch-lab rp-ch-title", report.chart.title || ""));
        var cv = el("canvas");
        wrap.appendChild(cv);
        box.appendChild(wrap);
        this._drawChart(cv, report.chart);
      }

      var secs = report.sections || [];
      for (var i = 0; i < secs.length; i++) {
        var sec = el("div", "rp-sec");
        sec.appendChild(el("div", "rp-h", esc(secs[i].h)));
        var lines = secs[i].lines || [];
        for (var j = 0; j < lines.length; j++) sec.appendChild(el("div", "rp-line", esc(lines[j])));
        box.appendChild(sec);
      }

      // 证据链：每条结论是怎么算出来的。默认折叠——
      // 不想看的人不受打扰，想追问「凭什么」的人一定找得到。
      if (report.evidence && report.evidence.length) {
        var det = el("details", "rp-evi");
        var sum = el("summary", "", "计算依据（" + report.evidence.length + " 条）");
        det.appendChild(sum);
        for (var e = 0; e < report.evidence.length; e++) {
          var ev = report.evidence[e];
          var parts = [];
          if (ev.method) parts.push(esc(ev.method));
          if (ev.n != null) parts.push("n=" + ev.n);
          if (ev.statistic != null) parts.push("统计量=" + Number(ev.statistic).toFixed(3));
          if (ev.ci95) parts.push("95%CI " + Number(ev.ci95[0]).toFixed(3) + "–" + Number(ev.ci95[1]).toFixed(3));
          if (ev.pValue != null) parts.push(FXStats.fmtP(ev.pValue));
          det.appendChild(el("div", "evi-item",
            '<div class="evi-claim">' + esc(ev.claim) + "</div>" +
            '<div class="evi-meta mono">' + parts.join(" · ") + "</div>"));
        }
        box.appendChild(det);
      }

      // 视口联动：分析结论 → 3D 空间里的具体机台。
      // 数据里有多台机器时进机群视图；只有一台且就是视口里那台时，直接高亮它。
      if (report.highlight && report.highlight.type === "machine") {
        var machines = report.chart && report.chart.kind === "bar-rate" ? report.chart.items : null;
        if (machines && machines.length > 1) {
          var fbtn = el("button", "btn btn-ghost btn-block",
            "在机群视图中定位 " + report.highlight.id + "（共 " + machines.length + " 台）");
          fbtn.addEventListener("click", this._showFleet.bind(this, machines, report.highlight.id));
          box.appendChild(fbtn);
        } else if (this._viewportMatches(report.highlight.id)) {
          var btn = el("button", "btn btn-ghost btn-block", "在 3D 视口中高亮 " + report.highlight.id);
          btn.addEventListener("click", this._highlightMachine.bind(this, report.highlight.id));
          box.appendChild(btn);
        }
      }

      // 后端产出的报告可生成公开分享页（doc §3.3-6）
      if (report.taskId && FXApiClient.available) {
        var shareBtn = el("button", "mini-btn ins-share", "生成分享页");
        shareBtn.addEventListener("click", this._shareReport.bind(this, report.taskId, shareBtn));
        box.appendChild(shareBtn);
      }
    }

    _shareReport(taskId, btn) {
      var self = this;
      btn.disabled = true;
      FXApiClient.share(taskId)
        .then(function (out) {
          var win = window.open(out.publicUrl, "_blank");
          if (win) self.ui.toast("分享页已在新窗口打开（24 小时有效）", "ok");
          else self.ui.toast("分享链接：" + out.publicUrl, "info");
        })
        .catch(function (err) { self.ui.toast(err.message, "err"); })
        .then(function () { btn.disabled = false; });
    }

    /** 图表：横向条（比率/数值）与折线，琥珀色系 */
    _drawChart(cv, chart) {
      var items = chart.items;
      var W = 356;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var isLine = chart.kind === "line";
      var H = isLine ? 150 : items.length * 30 + 10;
      cv.width = W * dpr; cv.height = H * dpr;
      cv.style.width = "100%";
      var c = cv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);

      var maxV = 0;
      for (var i = 0; i < items.length; i++) maxV = Math.max(maxV, items[i].value);
      if (maxV <= 0) maxV = 1;

      if (isLine) {
        var n = items.length;
        var X = function (i) { return 14 + (i / Math.max(1, n - 1)) * (W - 28); };
        var Y = function (v) { return H - 24 - (v / maxV) * (H - 46); };
        // 面积渐变（v4 蓝图玻璃：浅卡上的橙色主线）
        var grad = c.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "rgba(255,106,43,0.22)");
        grad.addColorStop(1, "rgba(255,106,43,0)");
        c.beginPath();
        for (var p = 0; p < n; p++) p ? c.lineTo(X(p), Y(items[p].value)) : c.moveTo(X(p), Y(items[p].value));
        c.strokeStyle = "#f0561a"; c.lineWidth = 1.8; c.stroke();
        c.lineTo(X(n - 1), H - 20); c.lineTo(X(0), H - 20); c.closePath();
        c.fillStyle = grad; c.fill();
        // 端点与标签
        c.fillStyle = "#5a6270";
        c.font = "9px Consolas";
        c.textAlign = "center";
        var step = Math.max(1, Math.ceil(n / 7));
        for (var q = 0; q < n; q += step) c.fillText(items[q].label, X(q), H - 8);
        return;
      }

      var isRate = chart.kind === "bar-rate";
      c.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      var bx = 84, trackW = W - 150;
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var y = 8 + k * 30;
        var frac = isRate ? Math.min(1, it.value) : it.value / maxV;
        var barW = Math.max(2, frac * trackW);
        var hot = isRate ? it.value >= 0.15 : k === 0;
        // 样本不足的条目整体压暗：视觉上就不该和有证据的条目等量齐观
        c.globalAlpha = it.weak ? 0.42 : 1;
        c.fillStyle = "#1d222b";
        c.textAlign = "left";
        c.fillText(it.label, 0, y + 13);
        // 条底槽 + 数据条
        c.fillStyle = "rgba(29,34,43,0.08)";
        c.fillRect(bx, y + 4, trackW, 12);
        c.fillStyle = hot ? "#f0561a" : "rgba(79,131,224,0.6)";
        c.fillRect(bx, y + 4, barW, 12);

        // 95% 置信区间误差线：让「证据强度」变成看得见的东西——
        // 两条点估计接近但区间宽度差一倍时，光看柱子长度会得出错误印象。
        if (isRate && it.ciLo != null && it.ciHi != null) {
          var xLo = bx + Math.min(1, it.ciLo) * trackW;
          var xHi = bx + Math.min(1, it.ciHi) * trackW;
          var cy = y + 10;
          c.strokeStyle = "rgba(29,34,43,0.55)";
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(xLo, cy); c.lineTo(xHi, cy);          // 横线
          c.moveTo(xLo, cy - 4); c.lineTo(xLo, cy + 4);  // 左端帽
          c.moveTo(xHi, cy - 4); c.lineTo(xHi, cy + 4);  // 右端帽
          c.stroke();
        }

        c.fillStyle = "#5a6270";
        c.font = "10px Consolas";
        c.fillText(isRate ? (it.value * 100).toFixed(1) + "%" : String(Math.round(it.value)), bx + trackW + 6, y + 14);
        c.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
        c.globalAlpha = 1;
      }
    }

    /* ── 3D 视口联动 ──────────────────────── */

    /**
     * 进入机群视图并定位到目标机台。
     *
     * 视觉编码有意与统计口径对齐：色相 = 失败率，**不透明度 = 证据强度**。
     * 只按失败率上色会让「1 单 1 失败」显示成最刺眼的红色，而那恰恰最不该信；
     * 置信区间越宽越透明，看不清就对应统计上的证据不足。
     */
    _showFleet(items, targetId) {
      var fleet = this.fx.fleet;
      if (!fleet) return this.ui.toast("当前场景不支持机群视图", "warn");

      var machines = FXFleetView.fromChartItems(items, targetId);
      fleet.build(machines).highlight(targetId).show(true);
      if (this.fx.printer) this.fx.printer.group.visible = false;   // 与详细机型互斥，避免遮挡

      var view = fleet.focusTarget(targetId);
      this.fx.orbit.setView(view.pos, view.target, false);
      this._fleetOn = true;
      this._renderFleetExit();

      var weak = machines.filter(function (m) { return !m.status.trustworthy; }).length;
      this.ui.toast("机群视图：" + machines.length + " 台，已定位 " + targetId +
        (weak ? "（其中 " + weak + " 台证据不足，显示为半透明）" : ""), "ok");
    }

    /** 退出机群视图，回到详细打印机 */
    _exitFleet() {
      if (!this._fleetOn) return;
      this.fx.fleet.show(false).clear();
      if (this.fx.printer) this.fx.printer.group.visible = true;
      this.fx.setCameraPreset("overview");
      this._fleetOn = false;
      var b = $("#fleet-exit");
      if (b) b.hidden = true;
    }

    _renderFleetExit() {
      var b = $("#fleet-exit");
      if (!b) return;
      b.hidden = false;
      if (!b._bound) {
        b._bound = true;
        b.addEventListener("click", this._exitFleet.bind(this));
      }
    }

    /** 结论指向的机台，是否就是视口里当前装载的这台机型 */
    _viewportMatches(machineId) {
      var P = this.sim && this.sim.printer;
      var tag = P && (P.MODEL_TAG || P.MODEL_NAME);
      return !!(tag && String(machineId || "").indexOf(String(tag)) === 0);
    }

    _highlightMachine(id) {
      var P = this.fx.printer;
      this.fx.setCameraPreset("overview");
      var origin = P.stateLED.material.color.getHex();
      var n = 0;
      clearInterval(this._blinkT);
      this._blinkT = setInterval(function () {
        P.setStateLED(n % 2 ? origin : 0xff5f52);
        if (++n >= 9) { clearInterval(this._blinkT); P.setStateLED(origin); }
      }.bind(this), 240);
      this.ui.toast("已高亮 " + id + " 的状态灯", "ok");
    }

    /* ── 历史 ─────────────────────────────── */

    _pushHistory(q) {
      this.history.unshift({ q: q, at: FXU.nowHMS() });
      if (this.history.length > 5) this.history.pop();
      this._renderHistory();
    }
    _renderHistory() {
      var box = this._histBox;
      box.innerHTML = "";
      if (!this.history.length) {
        box.appendChild(el("div", "note", "还没有分析记录，从上面的快捷问题开始吧。"));
        return;
      }
      for (var i = 0; i < this.history.length; i++) {
        (function (h, self) {
          var item = el("div", "hist-item", '<span class="lt mono">' + h.at + "</span><span>" + esc(h.q) + "</span>");
          item.addEventListener("click", function () {
            self._askInput.value = h.q;
            self.ask(h.q);
          });
          box.appendChild(item);
        })(this.history[i], this);
      }
    }

    _refreshEngineTag() {
      var tag = $("#insight-engine-tag");
      var caps = FXApiClient.capabilities || { ai: false };
      var isAi = !!(FXApiClient.available && caps.ai);
      if (tag) {
        tag.textContent = !FXApiClient.available ? "本地规则" : isAi ? "AI + 统计核" : "后端规则";
      }
      if (this._engineNote) {
        this._engineNote.hidden = false;
        this._engineNote.innerHTML = !FXApiClient.available
          ? "当前是<b>本地规则引擎</b>（file:// 直开或后端未启动）。<b>它不是 AI</b>：" +
            "报告由关键词路由 + 统计核（Wilson 置信区间 / Fisher 精确检验 / 偏相关）产出。" +
            "要接 AI：运行 <span class=\"mono\">node server/index.js</span>，" +
            "改用 <span class=\"mono\">http://127.0.0.1:8787</span> 打开本页。"
          : isAi
            ? "已连接 <b>" + esc(FXApiClient.providerLabel || "AI provider") + "</b>。" +
              "架构上 <b>AI 只负责叙述，数字由本地统计核算</b>——" +
              "所以图表、视口联动、置信区间与显著性检验在 AI 模式下同样具备，" +
              "且报告里每个数字都能在「计算依据」里找到出处。"
            : "后端已连接，运行的是<b>后端规则引擎</b>（未配置 AI provider）。<b>它不是 AI</b>，" +
              "但结论同样带置信区间与显著性检验。配置 " +
              "<span class=\"mono\">INFINI_API_KEY</span> 或 <span class=\"mono\">OPENAI_API_KEY</span> 后可接 AI。";
      }
      this._renderKnowledge(isAi);
    }

    /**
     * 知识库入口。只在 AI provider 下展示——
     * 规则引擎是确定性统计，不读自然语言知识，摆一个没用的上传框只会误导。
     */
    _renderKnowledge(isAi) {
      if (this._kbBox) { this._kbBox.remove(); this._kbBox = null; }
      if (!isAi) return;

      var box = el("div", "kb-box");
      box.appendChild(el("div", "sec-label", "领域知识（可选）"));
      box.appendChild(el("div", "note",
        "上传工艺术语表 / 材料参数 / 设备手册，提问时会按问题检索相关片段注入 AI 提示词。" +
        "<b>检索不到就不注入</b>——宁可不给，也不给无关内容。存储为内存态，重启即失效。"));

      var ta = el("textarea", "kb-input");
      ta.placeholder = "粘贴知识内容，例如：\n翘边：首层与热床附着失效，边缘翘起离床。\n\nOEE：设备综合效率 = 可用率 × 性能 × 良率。";
      ta.rows = 4;
      box.appendChild(ta);

      var row = el("div", "prow ins-actions");
      var self = this;
      var upBtn = el("button", "mini-btn", "上传知识");
      upBtn.addEventListener("click", function () {
        var text = ta.value.trim();
        if (!text) return self.ui.toast("先粘贴一些知识内容", "warn");
        upBtn.disabled = true;
        FXApiClient.uploadKnowledge("knowledge-" + Date.now() + ".md", text)
          .then(function (out) {
            ta.value = "";
            self.ui.toast(out.retrievalEnabled ? "已登记，提问时会按需检索注入" : out.note, "ok");
          })
          .catch(function (e) { self.ui.toast(e.message, "err"); })
          .then(function () { upBtn.disabled = false; });
      });
      var testBtn = el("button", "mini-btn", "测试检索");
      testBtn.title = "看看当前问题会检索到哪些片段——自己验证，不用盲信";
      testBtn.addEventListener("click", function () {
        var q = (self._askInput && self._askInput.value.trim()) || "翘边";
        FXApiClient.searchKnowledge(q)
          .then(function (out) {
            res.hidden = false;
            res.innerHTML = out.hits.length
              ? '<div class="kb-h">「' + esc(q) + "」检索到 " + out.hits.length + " 段：</div>" +
                out.hits.map(function (h) {
                  return '<div class="kb-hit"><span class="mono">' + h.score.toFixed(2) + "</span> " +
                    esc(h.text.slice(0, 90)) + (h.text.length > 90 ? "…" : "") + "</div>";
                }).join("")
              : '<div class="kb-h">「' + esc(q) + "」没有检索到相关片段——分析时不会注入任何知识内容。</div>";
          })
          .catch(function (e) { self.ui.toast(e.message, "err"); });
      });
      row.append(upBtn, testBtn);
      box.appendChild(row);

      var res = el("div", "kb-res");
      res.hidden = true;
      box.appendChild(res);

      // 插在「自然语言分析」小节之前
      this.body.insertBefore(box, this._askInput.parentNode.previousSibling);
      this._kbBox = box;
    }
  }

  root.FXInsight = FXInsight;
})(typeof window !== "undefined" ? window : globalThis);
