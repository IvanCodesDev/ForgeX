/* FORGE·X 智造洞察 — 面板层：数据接入 / KPI 看板 / 自然语言提问 / 报告与图表 / 3D 视口联动
   引擎路由：后端（InfiniSynapse 代理）可用走云端，否则本地演示引擎（FXInsightEngine）。 */
(function (root) {
  "use strict";

  var $ = FXU.$, el = FXU.el, esc = FXU.esc;

  var QUICK_QUESTIONS = [
    "哪台机故障率最高，主要故障是什么",
    "PLA 和 PETG 在悬垂件上的失败率差多少",
    "层高与打印时长的相关性",
    "本月成本趋势与拆解",
    "失败批次有没有共性，哪台机该保养了",
  ];

  var FAULT_MAP = [
    ["断料", "断料"], ["堵", "堵料"], ["热失控", "热失控"],
  ];

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
      var btnRow = el("div", "prow ins-actions");
      var upBtn = el("button", "mini-btn", "上传 CSV");
      upBtn.addEventListener("click", function () { $("#csv-input").click(); });
      var dlBtn = el("button", "mini-btn", "下载示例 CSV");
      dlBtn.addEventListener("click", function () {
        FXInsightData.downloadCsv(this.store.sets.sample.rows, "print_jobs_sample.csv");
      }.bind(this));
      var simBtn = el("button", "mini-btn", "导出模拟采集");
      simBtn.addEventListener("click", function () {
        var rows = this.store.sets.sim.rows;
        if (!rows.length) return this.ui.toast("暂无模拟采集数据 — 先跑一次打印任务", "warn");
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
      // 数据集 chips
      var row = this._dsRow;
      row.innerHTML = "";
      var sets = this.store.sets;
      for (var key in sets) {
        (function (k, self) {
          var s = sets[k];
          var c = el("div", "chip sm" + (self.store.active === k ? " on" : ""),
            s.label + " · " + s.rows.length);
          c.addEventListener("click", function () {
            if (!s.rows.length) return self.ui.toast(k === "sim" ? "还没有模拟采集数据，先完成一次打印" : "该数据集为空，请先上传", "warn");
            self.store.use(k);
          });
          row.appendChild(c);
        })(key, this);
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
      var tiles = [
        { lab: "任务总数", val: String(k.total), sub: "近三周" },
        { lab: "综合良率", val: (k.yield * 100).toFixed(1) + "%", sub: "良品 " + Math.round(k.yield * k.total) + " 件", cls: k.yield >= 0.9 ? "good" : k.yield >= 0.8 ? "mid" : "bad" },
        { lab: "良品均本", val: "¥" + (k.avgCostFen / 100).toFixed(2), sub: "耗材+能耗+机时" },
        { lab: "重点关注", val: k.worstMachine ? k.worstMachine.id.replace("FX-256-", "") + " 号机" : "—",
          sub: k.worstMachine ? "故障率 " + (k.worstMachine.failRate * 100).toFixed(0) + "% · " + (k.topReason ? k.topReason.name : "") : "无异常", cls: k.worstMachine && k.worstMachine.failRate > 0.15 ? "bad" : "" },
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
      var reason = "";
      if (d.status === "fail" && d.fault) {
        for (var i = 0; i < FAULT_MAP.length; i++)
          if (d.fault.indexOf(FAULT_MAP[i][0]) >= 0) { reason = FAULT_MAP[i][1]; break; }
        if (!reason) reason = "热失控";
      }
      var rec = FXInsightData.recordFromSim(this.sim, d.status, reason);
      this.store.addSimRecord(rec);
      this.ui.toast("运行数据已采集 → 模拟采集（共 " + this.store.sets.sim.rows.length + " 条）", "info");
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
      this._showProgress(["解析问题意图", "聚合生产数据", "生成结论与建议"]);

      if (FXApiClient.available) {
        this._askRemote(question, rows);
      } else {
        // 本地演示引擎：分步推进进度，保持与云端一致的节奏感
        var self = this;
        this._stepTo(1, 320, function () {
          self._stepTo(2, 620, function () {
            var report;
            try { report = FXInsightEngine.analyze(question, rows); }
            catch (err) {
              console.error("[insight]", err);
              self._finishAsk();
              self.ui.toast("分析出错：" + err.message, "err");
              return;
            }
            self._stepTo(3, 900, function () {
              self._finishAsk();
              self._pushHistory(question);
              self._renderReport(report);
            });
          });
        });
      }
    }

    _askRemote(question, rows) {
      var self = this;
      // 后端可用：上传当前数据集 → 建任务 → SSE 进度 → 拉结果（三步映射到进度条）
      FXApiClient.uploadDatasource(FXInsightData.toCsv(rows), "print_jobs.csv")
        .then(function (ds) {
          self._stepDone(0);
          return FXApiClient.analyze(question, ds.datasourceId);
        })
        .then(function (t) {
          self._stepDone(1);
          return new Promise(function (resolve, reject) {
            FXApiClient.stream(t.taskId, function () {}, function () { resolve(t.taskId); }, reject);
          });
        })
        .then(function (taskId) { return FXApiClient.result(taskId); })
        .then(function (report) {
          self._stepDone(2);
          self._finishAsk();
          self._pushHistory(question);
          self._renderReport(report);
        })
        .catch(function (err) {
          console.error("[insight remote]", err);
          self._finishAsk();
          self.ui.toast("云端分析失败，已回退本地引擎", "warn");
          var report = FXInsightEngine.analyze(question, rows);
          self._pushHistory(question);
          self._renderReport(report);
        });
    }

    /* ── 进度视觉 ─────────────────────────── */

    _showProgress(steps) {
      var p = this._progress;
      p.innerHTML = "";
      p.hidden = false;
      this._steps = [];
      for (var i = 0; i < steps.length; i++) {
        var s = el("div", "ai-step", '<span class="as-dot"></span><span>' + esc(steps[i]) + "</span>");
        p.appendChild(s);
        this._steps.push(s);
      }
      this._steps[0].classList.add("run");
    }
    _stepTo(n, delayMs, then) {
      var self = this;
      setTimeout(function () {
        for (var i = 0; i < self._steps.length; i++) {
          self._steps[i].classList.toggle("done", i < n);
          self._steps[i].classList.toggle("run", i === n);
        }
        then();
      }, delayMs);
    }
    _stepDone(i) {
      if (!this._steps || !this._steps[i]) return;
      this._steps[i].classList.remove("run");
      this._steps[i].classList.add("done");
      if (this._steps[i + 1]) this._steps[i + 1].classList.add("run");
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

      // 引擎标注必须如实：mock 后端绝不冒充 InfiniSynapse
      var engineLabel = report.engine === "infinisynapse" ? "InfiniSynapse"
        : report.engine === "mock" ? "后端演示引擎" : "本地演示引擎";
      var head = el("div", "rp-head",
        '<span class="rp-title">' + esc(report.title || "分析报告") + '</span>' +
        '<span class="ph-tag mono">' + engineLabel + " · " + (report.rowCount || 0) + " 行</span>");
      box.appendChild(head);

      box.appendChild(el("div", "verdict", esc(report.verdict || "")));

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

      if (report.highlight && report.highlight.type === "machine") {
        var btn = el("button", "btn btn-ghost btn-block", "在 3D 视口中定位 " + report.highlight.id);
        btn.addEventListener("click", this._highlightMachine.bind(this, report.highlight.id));
        box.appendChild(btn);
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
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var y = 8 + k * 30;
        var frac = isRate ? Math.min(1, it.value) : it.value / maxV;
        var barW = Math.max(2, frac * (W - 150));
        var hot = isRate ? it.value >= 0.15 : k === 0;
        c.fillStyle = "#1d222b";
        c.textAlign = "left";
        c.fillText(it.label, 0, y + 13);
        // 条底槽 + 数据条
        c.fillStyle = "rgba(29,34,43,0.08)";
        var bx = 84;
        c.fillRect(bx, y + 4, W - 150, 12);
        c.fillStyle = hot ? "#f0561a" : "rgba(79,131,224,0.6)";
        c.fillRect(bx, y + 4, barW, 12);
        c.fillStyle = "#5a6270";
        c.font = "10px Consolas";
        c.fillText(isRate ? (it.value * 100).toFixed(1) + "%" : String(Math.round(it.value)), bx + (W - 150) + 6, y + 14);
        c.font = "11px 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
      }
    }

    /* ── 3D 视口联动 ──────────────────────── */

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
      this.ui.toast("已在 3D 视口中定位 " + id + "（演示环境映射至当前机台）", "ok");
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
      if (!tag) return;
      tag.textContent = !FXApiClient.available ? "本地演示"
        : FXApiClient.engineMode === "infinisynapse" ? "云端 AI" : "后端演示";
      if (this._engineNote) {
        this._engineNote.hidden = false;
        this._engineNote.innerHTML = !FXApiClient.available
          ? "当前为<b>本地演示引擎</b>（file:// 直开或后端未启动）：KPI 与报告由浏览器对所选数据集<b>真实聚合</b>产出，非预置文案。" +
            "要启用 InfiniSynapse <b>云端真实 AI 分析</b>：命令行运行 <span class=\"mono\">node server/index.js</span>，改用 <span class=\"mono\">http://127.0.0.1:8787</span> 打开本页。"
          : FXApiClient.engineMode === "infinisynapse"
          ? "已连接 <b>InfiniSynapse 云端真实分析</b>：每次提问都会创建真实云端任务（SSE 实时进度，约 2–4 分钟），任务记录可在 app.infinisynapse.cn/tasks 后台核对。"
          : "后端已连接（<b>演示引擎</b>：未配置云端密钥或未核准）。配好 server/.env 的 INFINI_API_KEY 并置 INFINI_VERIFIED=1 后自动切云端真实分析。";
      }
    }
  }

  root.FXInsight = FXInsight;
})(typeof window !== "undefined" ? window : globalThis);
