/* FORGE·X — UI 层：顶部流程胶囊 / 浮动面板 / 底部 Dock / 监控浮层 / 弹层与交互 */
(function (root) {
  "use strict";

  const $ = FXU.$, el = FXU.el;

  /* ── 图标库（内联 SVG path） ─────────────── */
  const ICONS = {
    upload: '<path d="M12 16V5m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
    layers: '<path d="M3 8h18M3 12h18M3 16h18M3 20h18M3 4h18"/>',
    infill: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8"/>',
    temp: '<path d="M10 4a2 2 0 014 0v9a4.5 4.5 0 11-4 0z"/><path d="M12 9v6"/>',
    motion: '<path d="M4 17a8 8 0 0116 0"/><path d="M12 17l4.5-5.5"/><circle cx="12" cy="17" r="1.4"/>',
    fan: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.8C12 5 9 3.5 6.5 5c1.8 1 2.6 3 3.2 5.4M14.2 12c4.8 0 6.3-3 4.8-5.5-1 1.8-3 2.6-5.4 3.2M12 14.2c0 4.8 3 6.3 5.5 4.8-1.8-1-2.6-3-3.2-5.4M9.8 12c-4.8 0-6.3 3-4.8 5.5 1-1.8 3-2.6 5.4-3.2"/>',
    support: '<path d="M4 20h16M6 20V8m4 12V8m4 12V8m4 12V8"/><path d="M4 8h16l-2-4H6z"/>',
    material: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
    preset: '<path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/>',
  };
  const svg = (name, size) =>
    `<svg viewBox="0 0 24 24" width="${size || 20}" height="${size || 20}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;

  /* 流程入口：模型（含摆放）/ 切片 / 校准 / 质量 + 智造洞察（数据分析域，独立面板） */
  const NAVS = [
    { id: "import", label: "模型", title: "模型与摆放" },
    { id: "slice", label: "切片", title: "切片分析" },
    { id: "calib", label: "校准", title: "平台校准" },
    { id: "quality", label: "质量", title: "质量评估" },
    { id: "insight", label: "洞察", title: "智造洞察", accent: true },
  ];

  const PRESETS = [
    { name: "精细", desc: "0.12mm · 25% · 80mm/s", p: { layerHeight: 0.12, infillDensity: 0.25, speed: 80 } },
    { name: "标准", desc: "0.20mm · 18% · 120mm/s", p: { layerHeight: 0.2, infillDensity: 0.18, speed: 120 } },
    { name: "草稿", desc: "0.28mm · 10% · 220mm/s", p: { layerHeight: 0.28, infillDensity: 0.1, speed: 220 } },
    { name: "强度", desc: "0.20mm · 45% · 4圈周界", p: { layerHeight: 0.2, infillDensity: 0.45, speed: 100, perimeters: 4 } },
  ];

  class FXUI {
    /* options.adopted：已由宿主（React 工作台）接管的区域名集合。
       被接管区域的事件绑定与周期写入在此跳过，避免两套代码争抢同一批节点。
       旧入口不传该参数，行为与迁移前完全一致。 */
    constructor(sim, fx, bus, options) {
      this.sim = sim;
      this.fx = fx;
      this.bus = bus;
      this.adopted = new Set((options && options.adopted) || []);
      this.currentNav = "import";
      this._disposers = [];
      this._ctrls = [];          // 参数控件同步注册表
      this._lockables = [];
      this._chart = { data: [], last: 0 };
      this._imgState = { img: null, name: "", mode: "relief", widthMm: 80, maxH: 8, invert: false, threshold: 0.5 };
      this._gcodeState = null;
      this._machineLogState = null;

      this._brand();
      this._buildNav();
      this._buildParamPanel();
      this._bindTopbar();
      this._bindMonitor();
      this._bindUpload();
      this._bindBus();
      this.renderCtx("import");
      this._startUiLoop();
    }

    /* ══ 顶层结构 ═══════════════════════════ */

    _brand() {
      $("#brand-mark").innerHTML =
        `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#2c323e"/>
         <path d="M11 12h10l-3.4 6h-3.2z" fill="#eef1f6"/><rect x="14.6" y="19.5" width="2.8" height="4.5" fill="#ff6a2b"/></svg>`;
      // 进度环渐变定义。宿主接管 Dock 时由其自行渲染，避免注入的节点被宿主的差异比对移除。
      if (this._isAdopted("cockpit")) return;
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.innerHTML = `<linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#f0561a"/><stop offset="100%" stop-color="#ff8a52"/></linearGradient>`;
      $(".ring").prepend(defs);
    }

    _buildNav() {
      if (this._isAdopted("nav")) return; // 流程胶囊与面板开合由宿主渲染
      const railEl = $("#flow-pills");
      NAVS.forEach((n, i) => {
        const item = el("button", "flow-pill" + (n.accent ? " fp-accent" : ""),
          `<span class="fp-idx">0${i + 1}</span><span>${n.label}</span>`);
        item.type = "button";
        if (n.id === "insight") {
          // 洞察是独立面板（数据分析域），由 FXInsight 接管开合
          item.id = "pill-insight";
          item.addEventListener("click", () => {
            FXU.$$(".flow-pill", railEl).forEach((e) => e.classList.remove("on"));
            this.bus.emit("insight-toggle", item);
          });
          railEl.appendChild(item);
          return;
        }
        item.addEventListener("click", () => {
          const panel = $("#ctx-panel");
          // 再点当前激活项 = 收起面板（保持视口纯净）
          if (this.currentNav === n.id && !panel.hidden) { this._closeCtx(); return; }
          FXU.$$(".flow-pill", railEl).forEach((e) => e.classList.remove("on"));
          item.classList.add("on");
          this.bus.emit("ctx-open", n.id);   // 通知洞察面板互斥收起
          this._openPanel(panel);
          this.renderCtx(n.id);
        });
        railEl.appendChild(item);
      });
    }

    _openPanel(panel, btn) {
      if (!panel.hidden) return;
      panel.hidden = false;
      if (btn) btn.classList.add("on");
      panel.classList.add("entering");
      setTimeout(() => panel.classList.remove("entering"), 360);
    }
    _togglePanel(panel, btn) {
      if (panel.hidden) this._openPanel(panel, btn);
      else { panel.hidden = true; if (btn) btn.classList.remove("on"); }
    }
    _closeCtx() {
      /* 面板归宿主管时改发事件：insight 面板互斥收起等旧调用路径
         仍然生效，但唯一的开合真相源保持在宿主一侧。 */
      if (this._isAdopted("nav")) { this.bus.emit("ctx-close-request"); return; }
      $("#ctx-panel").hidden = true;
      FXU.$$(".flow-pill").forEach((p) => p.classList.remove("on"));
      this.sim.printer.hideSlicePreview();   // 收起面板时同步清掉视口路径预览
    }

    _isAdopted(zone) {
      return this.adopted.has(zone);
    }

    _bindTopbar() {
      if (!this._isAdopted("cockpit")) {
        // 仿真倍率
        FXU.$$("#speed-seg button").forEach((b) => {
          b.addEventListener("click", () => {
            FXU.$$("#speed-seg button").forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
            this.sim.simMult = +b.dataset.v;
            this.toast(`仿真时间倍率 ${b.dataset.v}×`, "info");
          });
        });
        // 相机
        FXU.$$("#hud-cam button").forEach((b) => {
          b.addEventListener("click", () => {
            FXU.$$("#hud-cam button").forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
            this.fx.setCameraPreset(b.dataset.v);
          });
        });
      }
      $("#btn-fullscreen").addEventListener("click", () => {
        // 全屏 API 前缀兼容：Chromium <71 / 老 Safari 仅有 webkit 前缀版本
        const doc = document, de = doc.documentElement;
        const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
        if (fsEl) {
          const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
          if (exit) { try { const p = exit.call(doc); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
        } else {
          const req = de.requestFullscreen || de.webkitRequestFullscreen;
          if (req) { try { const p = req.call(de); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
          else this.toast("当前浏览器不支持网页全屏", "warn");
        }
      });
      if (!this._isAdopted("overlays")) {
        $("#btn-about").addEventListener("click", () => this._aboutModal());
        // 浮动面板开关
        $("#btn-params").addEventListener("click", () => this._togglePanel($("#param-panel"), $("#btn-params")));
        $("#btn-monitor").addEventListener("click", () => this._togglePanel($("#monitor-pop"), $("#btn-monitor")));
      }
      if (!this._isAdopted("nav")) $("#ctx-close").addEventListener("click", () => this._closeCtx());
      if (!this._isAdopted("overlays")) {
        $("#param-close").addEventListener("click", () => this._togglePanel($("#param-panel"), $("#btn-params")));
        $("#mon-close").addEventListener("click", () => this._togglePanel($("#monitor-pop"), $("#btn-monitor")));
      }
      if (!this._isAdopted("cockpit")) {
        // 打印控制
        $("#btn-start").addEventListener("click", () => this.sim.start());
        $("#btn-pause").addEventListener("click", () => {
          const s = this.sim.state;
          if (s === "pause" || s === "fault") this.sim.resume();
          else this.sim.pause();
        });
        $("#btn-stop").addEventListener("click", () => {
          this._confirm("确认停止当前任务？", "打印进程将中止，平台复位，已成形部分将被清除（模拟）。", () => this.sim.stop());
        });
      }
      if (!this._isAdopted("overlays"))
        $("#log-clear").addEventListener("click", () => { $("#log-list").innerHTML = ""; });
    }

    /* ══ 右侧参数面板 ═══════════════════════ */

    _buildParamPanel() {
      if (this._isAdopted("params")) return; // 参数面板内容由宿主渲染
      const body = $("#param-body");
      const sim = this.sim, st = sim.settings;

      /* 一键预设 */
      let g = this._pgroup(body, "preset", "工艺预设", "presets");
      const psRow = el("div", "chip-row");
      for (const ps of PRESETS) {
        const c = el("div", "chip", ps.name);
        c.title = ps.desc;
        c.addEventListener("click", () => {
          if (this._printLocked()) return this.toast("打印中不可应用预设", "warn");
          sim.updateSettings(ps.p);
          this._syncAllCtrls();
          this.toast(`已应用预设「${ps.name}」（${ps.desc}）`, "ok");
        });
        psRow.appendChild(c);
      }
      g.appendChild(psRow);
      this._lockables.push({ elx: psRow, geom: true, imported: true });

      /* 材料 */
      g = this._pgroup(body, "material", "材料体系", "material");
      const matRow = el("div", "chip-row");
      Object.keys(FXSim.MATERIALS).forEach((k) => {
        const c = el("div", "chip" + (st.material === k ? " on" : ""), k);
        c.addEventListener("click", () => {
          if (this._printLocked()) return this.toast("打印中不可更换材料", "warn");
          sim.applyMaterial(k);
          if (sim.importedToolpath && this._gcodeState) {
            this._gcodeState.reconcile = FXGcodeParser.reconcile(sim.slice);
            if (this._machineLogState) {
              this._machineLogState.comparison = FXMachineLog.compare(sim.slice, this._machineLogState.log);
              this._machineLogState.observation = FXTimeCalibration.observation(
                sim.slice,
                this._machineLogState.log
              );
              this._machineLogState.calibration = this._calibrationFor(
                sim.slice,
                this._machineLogState.log,
                false
              );
            }
            if (this.currentNav === "import") this.renderCtx("import");
          }
          FXU.$$(".chip", matRow).forEach((x) => x.classList.toggle("on", x.textContent === k));
        });
        matRow.appendChild(c);
      });
      g.appendChild(matRow);
      this._lockables.push({ elx: matRow, geom: true });
      g.appendChild(el("div", "p-sub-label", "外观颜色 · 仅改变成品显示"));
      const colRow = el("div", "chip-row");
      FXSim.COLORS.forEach((c, i) => {
        const chip = el("div", "chip sm" + (st.colorIdx === i ? " on" : ""), c.name);
        chip.style.borderColor = "#" + c.hex.toString(16).padStart(6, "0") + "aa";
        chip.addEventListener("click", () => {
          st.colorIdx = i;
          FXU.$$(".chip", colRow).forEach((x, xi) => x.classList.toggle("on", xi === i));
          sim.printer.setFilamentColor(c.hex);
          if (sim.state === "idle" || sim.state === "done") {
            if (sim.importedToolpath) sim.printer.attachToolpath(sim.slice, sim.partColor);
            else sim.reslice();
          }
        });
        colRow.appendChild(chip);
      });
      g.appendChild(colRow);
      this._lockables.push({ elx: colRow, geom: true });

      /* 成型质量 */
      g = this._pgroup(body, "layers", "成型质量", "quality");
      this._slider(g, { label: "层高", min: 0.08, max: 0.32, step: 0.02, unit: "mm", dec: 2, geom: true,
        get: () => st.layerHeight, set: (v) => sim.updateSettings({ layerHeight: v }) });
      this._slider(g, { label: "周界圈数", min: 1, max: 5, step: 1, unit: "圈", dec: 0, geom: true,
        get: () => st.perimeters, set: (v) => sim.updateSettings({ perimeters: v }) });
      this._slider(g, { label: "顶底实心层", min: 2, max: 6, step: 1, unit: "层", dec: 0, geom: true,
        get: () => st.solidLayers, set: (v) => sim.updateSettings({ solidLayers: v }) });

      /* 填充 */
      g = this._pgroup(body, "infill", "内部填充", "infill");
      this._slider(g, { label: "填充密度", min: 0.05, max: 1, step: 0.05, unit: "%", dec: 0, mul: 100, geom: true,
        get: () => st.infillDensity, set: (v) => sim.updateSettings({ infillDensity: v }) });
      const patRow = el("div", "prow");
      patRow.innerHTML = `<span class="p-lab">填充图案</span>`;
      const sel = el("select", "sel");
      ["斜线网格", "直线", "蜂窝"].forEach((p) => {
        const o = el("option", "", p); o.value = p; sel.appendChild(o);
      });
      sel.value = st.infillPattern;
      sel.addEventListener("change", () => sim.updateSettings({ infillPattern: sel.value }));
      patRow.appendChild(sel);
      g.appendChild(patRow);
      this._lockables.push({ elx: patRow, geom: true, imported: true });

      /* 温度 */
      g = this._pgroup(body, "temp", "温度控制", "thermal");
      this._slider(g, { label: "喷嘴温度", min: 120, max: 450, step: 5, unit: "°C", dec: 0,
        get: () => st.nozzleTemp, set: (v) => sim.updateSettings({ nozzleTemp: v }) });
      this._slider(g, { label: "热床温度", min: 0, max: 180, step: 5, unit: "°C", dec: 0,
        get: () => st.bedTemp, set: (v) => sim.updateSettings({ bedTemp: v }) });

      /* 动力学 */
      g = this._pgroup(body, "motion", "运动系统", "kinematics");
      this._slider(g, { label: "打印速度", min: 20, max: 1000, step: 10, unit: "mm/s", dec: 0,
        get: () => st.speed, set: (v) => sim.updateSettings({ speed: v }) });
      this._slider(g, { label: "空驶速度", min: 100, max: 1000, step: 20, unit: "mm/s", dec: 0,
        get: () => st.travelSpeed, set: (v) => sim.updateSettings({ travelSpeed: v }) });
      this._slider(g, { label: "回抽距离", min: 0, max: 4, step: 0.1, unit: "mm", dec: 1,
        get: () => st.retraction, set: (v) => sim.updateSettings({ retraction: v }) });

      /* 冷却 */
      g = this._pgroup(body, "fan", "冷却系统", "cooling");
      this._slider(g, { label: "风扇转速", min: 0, max: 100, step: 5, unit: "%", dec: 0,
        get: () => st.fanSpeed, set: (v) => sim.updateSettings({ fanSpeed: v }) });

      /* 支撑 */
      g = this._pgroup(body, "support", "支撑结构", "supports");
      const swRow = el("div", "prow");
      swRow.innerHTML = `<span class="p-lab">启用支撑</span>`;
      const sw = el("label", "sw");
      sw.innerHTML = `<input type="checkbox" ${st.supportEnabled ? "checked" : ""}><span class="tr"></span>`;
      sw.querySelector("input").addEventListener("change", (e) => sim.updateSettings({ supportEnabled: e.target.checked }));
      swRow.appendChild(sw);
      swRow.appendChild(el("span", "p-val", ""));
      g.appendChild(swRow);
      this._lockables.push({ elx: swRow, geom: true, imported: true });
      this._slider(g, { label: "支撑间距", min: 2, max: 8, step: 0.5, unit: "mm", dec: 1, geom: true,
        get: () => st.supportSpacing, set: (v) => sim.updateSettings({ supportSpacing: v }) });

      body.appendChild(el("div", "note", "温度 / 速度 / 空驶 / 回抽 / 风扇支持打印中实时调整；层高、周界、实心层、填充图案与支撑会生成不同路径，需在待机状态修改并自动重新切片。"));
    }

    _pgroup(parent, icon, title, hint) {
      const g = el("div", "pgroup");
      g.innerHTML = `<div class="pg-head">${svg(icon, 14)}<span>${title}</span><span class="pg-hint">${hint || ""}</span></div>`;
      parent.appendChild(g);
      return g;
    }

    _slider(parent, opt) {
      const row = el("div", "prow");
      const lab = el("span", "p-lab", opt.label);
      const input = el("input", "range");
      input.type = "range";
      input.min = opt.min; input.max = opt.max; input.step = opt.step;
      const val = el("span", "p-val");
      const fmt = () => {
        const v = opt.get();
        const shown = (opt.mul ? v * opt.mul : v).toFixed(opt.dec);
        val.innerHTML = `${shown}<small>${opt.unit}</small>`;
        input.value = v;
        input.style.setProperty("--fill", (((v - opt.min) / (opt.max - opt.min)) * 100).toFixed(1) + "%");
      };
      input.addEventListener("input", () => {
        opt.set(parseFloat(input.value));
        fmt();
        this._onParamTouched();
      });
      row.append(lab, input, val);
      parent.appendChild(row);
      fmt();
      fmt._el = row;
      this._ctrls.push(fmt);
      if (opt.geom) this._lockables.push({ elx: row, geom: true, imported: true });
      return { row, input, sync: fmt };
    }

    _printLocked() {
      return !["idle", "done"].includes(this.sim.state);
    }

    _syncAllCtrls() { for (const f of this._ctrls) f(); }

    _applyLocks() {
      const busy = this._printLocked();
      const imported = !!this.sim.importedToolpath;
      if (!this._isAdopted("params")) {
        const tag = $("#param-lock-tag");
        tag.hidden = !busy && !imported;
        tag.textContent = busy ? "打印中锁定" : "G-code 几何已固化";
      }
      for (const L of this._lockables)
        L.elx.classList.toggle("locked", (busy && L.geom) || (imported && L.imported));
    }

    _onParamTouched() {
      clearTimeout(this._qT);
      this._qT = setTimeout(() => {
        if (this.currentNav === "quality") this.renderCtx("quality");
      }, 350);
    }

    /* ══ 左侧上下文面板 ═════════════════════ */

    renderCtx(id) {
      this.currentNav = id;
      for (const d of this._disposers) d();
      this._disposers = [];
      /* 页级接管：内容已迁宿主的页面只保留上面的状态清理与 currentNav 同步，
         不再写 DOM。遗留内部的重渲调用点（参数防抖 → 质量页、sliced → 切片页等）
         统一转发为刷新事件，由宿主页面订阅后自行回读引擎重渲。 */
      if (this._isAdopted("ctx:" + id)) { this.bus.emit("ctx-page-refresh", id); return; }
      const idx = NAVS.findIndex((n) => n.id === id);
      if (!this._isAdopted("nav")) {
        $("#ctx-title").textContent = NAVS[idx].title;
        $("#ctx-step").textContent = "0" + (idx + 1);
      }
      const body = $("#ctx-body");
      body.innerHTML = "";
      // 清理已随旧面板销毁的控件注册项
      this._ctrls = this._ctrls.filter((f) => !f._el || f._el.isConnected);
      this._lockables = this._lockables.filter((L) => L.elx.isConnected);
      this["_ctx_" + id](body);
      this._applyLocks();
    }

    _sub(ev, fn) { this._disposers.push(this.bus.on(ev, fn)); }

    /* — 01 模型与摆放 — */
    _ctx_import(body) {
      body.appendChild(el("div", "sec-label", "打印机型"));
      const pgrid = el("div", "model-grid");
      for (const pd of FXPrinters.list) {
        const card = el("div", "model-card" + (this.sim.printer.ID === pd.id ? " on" : ""),
          `<svg viewBox="0 0 60 46">${pd.icon}</svg><div class="mc-name">${pd.name}</div><div class="mc-dim">${pd.desc}${pd.community ? " · 社区" : ""}</div>`);
        card.addEventListener("click", () => {
          if (this._printLocked()) return this.toast("打印中不可切换机型", "warn");
          if (this.sim.printer.ID === pd.id) return;
          if (this.sim.setPrinterModel(pd.id)) {
            this.toast(`已切换至「${pd.name}」（${pd.desc}）`, "ok");
            this.renderCtx("import");
          }
        });
        pgrid.appendChild(card);
      }
      body.appendChild(pgrid);
      this._lockables.push({ elx: pgrid, geom: true });

      body.appendChild(el("div", "sec-label", "机器 / 材料 Profile"));
      const profileCount = root.FXProfiles ? root.FXProfiles.listMachines().filter((p) => p.community).length +
        root.FXProfiles.listMaterials().filter((p) => p.community).length : 0;
      const profileRow = el("div", "chip-row");
      const profileUpload = el("button", "btn btn-ghost", "导入 Profile JSON");
      profileUpload.type = "button";
      profileUpload.id = "profile-upload";
      profileUpload.addEventListener("click", () => $("#profile-input").click());
      const profileExample = el("a", "btn btn-ghost", "查看示例");
      profileExample.href = "contracts/profiles/example-bundle.json";
      profileExample.target = "_blank";
      profileExample.rel = "noopener";
      profileRow.append(profileUpload, profileExample);
      body.appendChild(profileRow);
      body.appendChild(el("div", "note", `仅接受声明式 JSON 与已实现运动学，不执行社区代码。当前已载入 ${profileCount} 个社区 Profile。`));

      body.appendChild(el("div", "sec-label", "时间校准包"));
      const calibrationModels = FXCalibrationRegistry.list();
      const activeCalibrations = calibrationModels.filter((model) => model.status === "active").length;
      const calibrationRow = el("div", "chip-row");
      const calibrationUpload = el("button", "btn btn-ghost", "导入校准包 JSON");
      calibrationUpload.type = "button";
      calibrationUpload.id = "calibration-upload";
      calibrationUpload.addEventListener("click", () => $("#calibration-input").click());
      const calibrationExample = el("a", "btn btn-ghost", "查看示例");
      calibrationExample.href = "contracts/calibration/example-bundle.json";
      calibrationExample.target = "_blank";
      calibrationExample.rel = "noopener";
      calibrationRow.append(calibrationUpload, calibrationExample);
      body.appendChild(calibrationRow);
      body.appendChild(el(
        "div",
        "note",
        `按机型、固件和材料精确匹配；合成模型不自动生效。当前 ${calibrationModels.length} 个模型，${activeCalibrations} 个 active。` +
          (FXApiClient.calibrationSync && FXApiClient.calibrationSync.status === "ready"
            ? ` 服务端已审核目录 ${FXApiClient.calibrationSync.count} 个 bundle。`
            : "")
      ));

      body.appendChild(el("div", "sec-label", "内置工程模型"));
      const grid = el("div", "model-grid");
      const icons = {
        gear: '<circle cx="30" cy="23" r="12"/><circle cx="30" cy="23" r="4"/><path d="M30 7v4M30 35v4M14 23h4M42 23h4M18.7 11.7l2.8 2.8M38.5 31.5l2.8 2.8M41.3 11.7l-2.8 2.8M21.5 31.5l-2.8 2.8"/>',
        impeller: '<circle cx="30" cy="23" r="4.5"/><path d="M30 18.5C34 12 42 12 45 16M34.5 25c7 2 9.5 9 7 13M25.5 25c-7 2-9.5 9-7 13M25.5 21C19 17 19 9 23 6"/>',
        bracket: '<path d="M12 38h36v-7H26V10H12z"/><circle cx="19" cy="34.5" r="2.5"/><circle cx="40" cy="34.5" r="2.5"/>',
      };
      for (const m of this._builtins()) {
        const card = el("div", "model-card" + (this.sim.model && this.sim.model.id === m.id ? " on" : ""),
          `<svg viewBox="0 0 60 46">${icons[m.id]}</svg><div class="mc-name">${m.name}</div><div class="mc-dim">${m.dims}</div>`);
        card.addEventListener("click", () => {
          if (this._printLocked()) return this.toast("打印中不可更换模型", "warn");
          this._gcodeState = null;
          this._machineLogState = null;
          this.sim.setModel(m, true);
          FXU.$$(".model-card", grid).forEach((x) => x.classList.remove("on"));
          card.classList.add("on");
          this.toast(`已载入「${m.name}」并完成切片`, "ok");
          this.renderCtx("import");
        });
        grid.appendChild(card);
      }
      body.appendChild(grid);

      body.appendChild(el("div", "sec-label", "真实 G-code · 导入复盘"));
      const gzone = el("div", "upload-zone");
      gzone.id = "gcode-zone";
      gzone.innerHTML = `<svg class="uz-ico" viewBox="0 0 24 24">${ICONS.layers}</svg>
        <div class="uz-t1">拖拽 G-code 到此处，或点击选择</div>
        <div class="uz-t2">解析真实挤出路径 · 3D 逐层回放 · 与切片器自报时间/耗材对账</div>`;
      gzone.addEventListener("click", () => $("#gcode-input").click());
      gzone.addEventListener("dragover", (e) => { e.preventDefault(); gzone.classList.add("drag"); });
      gzone.addEventListener("dragleave", () => gzone.classList.remove("drag"));
      gzone.addEventListener("drop", (e) => {
        e.preventDefault();
        gzone.classList.remove("drag");
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this._handleGcodeFile(f);
      });
      body.appendChild(gzone);

      if (this._gcodeState && this.sim.importedToolpath) {
        const G = this._gcodeState;
        const p = G.parsed;
        const c = p.claims || {};
        const summary = el("div", "gcode-summary");
        summary.id = "gcode-summary";
        const recRows = G.reconcile.map((r) => {
          const value = (v) => r.unit === "秒" ? FXGcodeParser.fmtSec(v) : `${v.toFixed(r.unit === "g" ? 1 : 0)} ${r.unit}`;
          return `<div class="kv"><span class="k">${FXU.esc(r.name)}</span><span class="v ${r.agrees ? "hl" : "warn"}">${value(r.claimed)} ↔ ${value(r.computed)} · ${Math.round(r.relDiff * 100)}%</span></div>`;
        }).join("");
        summary.innerHTML = `<div class="kv"><span class="k">文件</span><span class="v">${FXU.esc(G.name)}</span></div>
          <div class="kv"><span class="k">切片器</span><span class="v">${FXU.esc(c.slicer || "未声明")}</span></div>
          <div class="kv"><span class="k">解析结果</span><span class="v hl">${p.totalLayers} 层 · ${p.stats.filamentM.toFixed(2)} m · ${FXU.fmtHuman(p.stats.timeSec)}</span></div>
          ${recRows || '<div class="kv"><span class="k">对账</span><span class="v">文件未提供时间/耗材声明</span></div>'}`;
        body.appendChild(summary);
        for (const warning of p.warnings) body.appendChild(el("div", "note", `⚠ ${warning}`));

        const logZone = el("div", "upload-zone");
        logZone.id = "machine-log-zone";
        logZone.innerHTML = `<svg class="uz-ico" viewBox="0 0 24 24">${ICONS.motion}</svg>
          <div class="uz-t1">追加真机任务日志</div>
          <div class="uz-t2">JSON / CSV · 将实际时长、耗材和完成层数与当前 G-code 计划并列</div>`;
        logZone.addEventListener("click", () => $("#machine-log-input").click());
        logZone.addEventListener("dragover", (e) => { e.preventDefault(); logZone.classList.add("drag"); });
        logZone.addEventListener("dragleave", () => logZone.classList.remove("drag"));
        logZone.addEventListener("drop", (e) => {
          e.preventDefault();
          logZone.classList.remove("drag");
          const f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (f) this._handleMachineLogFile(f);
        });
        body.appendChild(logZone);

        if (this._machineLogState) {
          const M = this._machineLogState;
          const rows = M.comparison.map((r) => {
            const value = (v) => r.unit === "秒" ? FXGcodeParser.fmtSec(v) :
              `${v.toFixed(r.unit === "g" ? 1 : 0)} ${r.unit}`;
            return `<div class="kv"><span class="k">${FXU.esc(r.name)}</span><span class="v ${r.agrees ? "hl" : "warn"}">${value(r.planned)} 计划 ↔ ${value(r.actual)} 实测 · ${Math.round(r.relDiff * 100)}%</span></div>`;
          }).join("");
          const actual = el("div", "machine-log-summary");
          actual.id = "machine-log-summary";
          actual.innerHTML = `<div class="kv"><span class="k">真机日志</span><span class="v">${FXU.esc(M.log.name)} · ${FXU.esc(M.log.status)}</span></div>
            ${M.log.machineId ? `<div class="kv"><span class="k">设备 / 固件</span><span class="v">${FXU.esc(M.log.machineId)} · ${FXU.esc(M.log.firmware || "未声明")}</span></div>` : ""}
            ${rows || '<div class="kv"><span class="k">对比</span><span class="v">日志缺少可比较的任务汇总字段</span></div>'}
            ${M.observation ? `<div class="kv"><span class="k">单任务观测倍率</span><span class="v">${M.observation.rawRatio.toFixed(2)}× · ${M.observation.deltaSec >= 0 ? "+" : "−"}${FXGcodeParser.fmtSec(Math.abs(M.observation.deltaSec))}</span></div>` : ""}
            ${M.calibration ? `<div class="kv"><span class="k">作用域校准</span><span class="v hl">${FXU.esc(M.calibration.model.id)} r${M.calibration.model.bundleRevision} · ${FXGcodeParser.fmtSec(M.calibration.estimate.predictedTimeSec)}</span></div>
              <div class="kv"><span class="k">holdout 区间</span><span class="v">${FXGcodeParser.fmtSec(M.calibration.estimate.lowerTimeSec)} – ${FXGcodeParser.fmtSec(M.calibration.estimate.upperTimeSec)} · 漂移 ${FXU.esc(M.calibration.drift.status)}</span></div>` : ""}`;
          body.appendChild(actual);
          if (M.observation)
            body.appendChild(el("div", "note", M.observation.note));
          if (M.calibration) {
            body.appendChild(el(
              "div",
              "note",
              M.calibration.drift.note + " 校准值只适用于该模型声明的机型、固件和材料范围。"
            ));
          } else if (M.log.machineId && M.log.firmware) {
            body.appendChild(el(
              "div",
              "note",
              "未找到通过准入且未漂移的精确作用域校准模型；当前仍保留原始 G-code 估算与实测对比。"
            ));
          }
          for (const warning of M.log.warnings) body.appendChild(el("div", "note", `⚠ ${warning}`));
        }
      }

      body.appendChild(el("div", "sec-label", "图片 · 生成3D模型"));
      const zone = el("div", "upload-zone");
      zone.innerHTML = `<svg class="uz-ico" viewBox="0 0 24 24">${ICONS.upload}</svg>
        <div class="uz-t1">拖拽图片到此处，或点击选择</div>
        <div class="uz-t2">PNG / JPG / WebP · 亮度转浮雕高度，或按剪影轮廓挤出</div>`;
      zone.addEventListener("click", () => $("#file-input").click());
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); zone.classList.remove("drag");
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this._handleFile(f);
      });
      body.appendChild(zone);

      const S = this._imgState;
      if (S.img) {
        const pv = el("div", "img-preview");
        pv.innerHTML = `<img src="${S.img.src}"><div><div class="ip-name">${FXU.esc(S.name)}</div>
          <div class="ip-meta">${S.img.naturalWidth} × ${S.img.naturalHeight} px</div></div>`;
        body.appendChild(pv);

        const modeRow = el("div", "chip-row");
        [["relief", "浮雕模式"], ["silhouette", "剪影挤出"]].forEach(([v, lab]) => {
          const c = el("div", "chip" + (S.mode === v ? " on" : ""), lab);
          c.addEventListener("click", () => {
            S.mode = v;
            FXU.$$(".chip", modeRow).forEach((x) => x.classList.toggle("on", x.textContent === lab));
            this._regenImageModel();
          });
          modeRow.appendChild(c);
        });
        body.appendChild(modeRow);
        this._slider(body, { label: "成品宽度", min: 40, max: 140, step: 5, unit: "mm", dec: 0,
          get: () => S.widthMm, set: (v) => { S.widthMm = v; this._regenImageModelDebounced(); } });
        this._slider(body, { label: "最大高度", min: 3, max: 20, step: 0.5, unit: "mm", dec: 1,
          get: () => S.maxH, set: (v) => { S.maxH = v; this._regenImageModelDebounced(); } });
        const invRow = el("div", "prow");
        invRow.innerHTML = `<span class="p-lab">明暗反转</span>`;
        const sw = el("label", "sw");
        sw.innerHTML = `<input type="checkbox" ${S.invert ? "checked" : ""}><span class="tr"></span>`;
        sw.querySelector("input").addEventListener("change", (e) => { S.invert = e.target.checked; this._regenImageModel(); });
        invRow.appendChild(sw);
        invRow.appendChild(el("span", "p-val", ""));
        body.appendChild(invRow);
      }

      const sim = this.sim;
      if (!sim.model) return;

      /* 当前模型概要 */
      body.appendChild(el("div", "sec-label", "当前模型"));
      const s = sim.slice ? sim.slice.stats : null;
      const kv = el("div", "");
      kv.innerHTML = `
        <div class="kv"><span class="k">名称</span><span class="v">${FXU.esc(sim.model.name)}</span></div>
        ${s ? `<div class="kv"><span class="k">预估耗材</span><span class="v">${(s.volumeCm3 * sim.material.densityG).toFixed(1)} g · ${s.filamentM.toFixed(2)} m</span></div>
        <div class="kv"><span class="k">预估时长</span><span class="v hl">${FXU.fmtHuman(sim.estimateTotal())}</span></div>` : ""}`;
      body.appendChild(kv);

      /* 导出下载：STL / OBJ 来自模型三角网格，G-code 来自真实切片路径 */
      body.appendChild(el("div", "sec-label", "导出下载"));
      const exRow = el("div", "chip-row");
      [["stl", "STL 网格", "二进制 STL · 含缩放 · Z-up（可直接进 Cura/Prusa 切片）"],
       ["obj", "OBJ 网格", "ASCII OBJ · 通用三维格式（建模/渲染软件可开）"],
       ["gcode", "G-code", "由真实切片路径生成（与打印动画同源）· Marlin 风格"]].forEach(([fmt, lab, tip]) => {
        const c = el("div", "chip", lab);
        c.title = tip;
        c.addEventListener("click", () => this._exportModel(fmt));
        exRow.appendChild(c);
      });
      body.appendChild(exRow);
      if (sim.importedToolpath) {
        exRow.innerHTML = "";
        [["source-gcode", "原始 G-code", "下载未经改写的导入源文件"],
         ["gcode", "标准化副本", "按解析后的逐层路径重新生成 Marlin 风格 G-code"]].forEach(([fmt, lab, tip]) => {
          const c = el("div", "chip", lab);
          c.title = tip;
          c.addEventListener("click", () => this._exportModel(fmt));
          exRow.appendChild(c);
        });
        body.appendChild(el("div", "note", "导入任务可逐层预览和仿真回放；它不模拟固件宏、压力提前、输入整形或真实加速度，因此对账值是可解释估算，不冒充机台实测。"));
        return;
      }
      body.appendChild(el("div", "note", "STL / OBJ 为成品网格（应用当前缩放）；G-code 包含温度、调平、逐层路径与挤出量，参数改动后重新切片即生效。"));

      /* 摆放与变换（原独立页并入，减少跳转） */
      body.appendChild(el("div", "sec-label", "摆放与变换"));
      const tf = sim.tf;
      const warnBox = el("div", "");
      const resliceD = () => {
        clearTimeout(this._tfT);
        this._tfT = setTimeout(() => { if (!this._printLocked()) sim.reslice(); }, 320);
      };
      const updateWarn = () => {
        const r = sim.model.footprintR * tf.scale;
        const men = Math.max(Math.abs(tf.offX), Math.abs(tf.offY)) + r;
        const half = (sim.printer.BED_SIZE || 256) / 2;
        const buildZ = sim.printer.BUILD_VOLUME ? sim.printer.BUILD_VOLUME.z : 256;
        const over = men > half;
        const h = sim.model.height * tf.scale;
        warnBox.innerHTML = `
          <div class="kv"><span class="k">成品尺寸</span><span class="v">Ø${(r * 2).toFixed(0)} × 高 ${h.toFixed(1)} mm ${h > buildZ ? "⚠" : ""}</span></div>
          <div class="kv"><span class="k">平台边界</span><span class="v ${over ? "warn" : "hl"}">${over ? "超出打印区域" : "安全区内"}</span></div>`;
      };
      const mk = (label, min, max, step, unit, dec, get, set) =>
        this._slider(body, { label, min, max, step, unit, dec, geom: true, get, set: (v) => { set(v); resliceD(); updateWarn(); } });
      mk("缩放", 0.5, 2.2, 0.05, "×", 2, () => tf.scale, (v) => sim.updateTf({ scale: v }));
      mk("旋转 Z", -180, 180, 5, "°", 0, () => tf.rotZ, (v) => sim.updateTf({ rotZ: v }));
      mk("平移 X", -100, 100, 1, "mm", 0, () => tf.offX, (v) => sim.updateTf({ offX: v }));
      mk("平移 Y", -100, 100, 1, "mm", 0, () => tf.offY, (v) => sim.updateTf({ offY: v }));

      const btnRow = el("div", "prow");
      const center = el("button", "btn btn-ghost btn-block", "居中复位");
      center.addEventListener("click", () => {
        if (this._printLocked()) return this.toast("打印中不可调整摆放", "warn");
        sim.updateTf({ offX: 0, offY: 0, rotZ: 0 });
        this.renderCtx("import");
        resliceD();
      });
      btnRow.appendChild(center);
      body.appendChild(btnRow);
      body.appendChild(warnBox);
      updateWarn();
      if (this._printLocked()) body.appendChild(el("div", "note", "打印进行中，模型与摆放已锁定。"));
    }

    _builtins() {
      if (!this._builtinCache) this._builtinCache = FXModels.createBuiltins();
      return this._builtinCache;
    }

    /* 供宿主复用的导出入口：逻辑只依赖引擎与 toast，不碰面板 DOM。 */
    exportModel(fmt) {
      this._exportModel(fmt);
    }

    /* G-code 导入固化几何后，参数面板的锁定标签与控件状态需要立即刷新。 */
    refreshLocks() {
      this._applyLocks();
    }

    /* Profile 导入后参数面板需要按新机型/材料清单重建（面板仍属遗留层）。 */
    rebuildParamPanel() {
      $("#param-body").innerHTML = "";
      this._ctrls = [];
      this._lockables = [];
      this._buildParamPanel();
    }

    /* 成品导出：stl / obj（模型三角网格）· gcode（真实切片路径） */
    _exportModel(fmt) {
      const sim = this.sim;
      if (!sim.model) return this.toast("请先载入模型", "warn");
      const base = sim.model.name.replace(/\s+/g, "_");
      try {
        if (fmt === "source-gcode") {
          if (!sim.importedToolpath || !sim.importedToolpath.sourceText)
            return this.toast("原始 G-code 不在当前会话中", "warn");
          FXExport.download(base, sim.importedToolpath.sourceText, "text/plain;charset=utf-8");
          this.toast(`原始 G-code 已下载：${base}`, "ok");
          return;
        }
        if (fmt === "gcode") {
          if (!sim.slice) return this.toast("尚未切片，无法导出 G-code", "warn");
          const g = FXExport.gcode(sim.slice, sim.settings, {
            model: sim.model.name,
            printer: sim.printer.MODEL_NAME || "FORGE-X",
            densityG: sim.material.densityG,
            bedSize: sim.printer.BED_SIZE || 256,
          });
          FXExport.download(`${base}_${sim.settings.layerHeight.toFixed(2)}mm_${sim.settings.material}.gcode`, g, "text/plain;charset=utf-8");
          this.toast(`G-code 已导出：${sim.slice.totalLayers} 层 · ${(g.length / 1024).toFixed(0)} KB`, "ok");
          return;
        }
        const geo = FXModels.buildGeometry(sim.model);
        if (!geo) return this.toast("几何构建失败", "err");
        const tris = FXExport.trianglesFromGeometry(geo, sim.tf.scale || 1);
        geo.dispose();
        if (fmt === "stl") {
          FXExport.download(`${base}.stl`, FXExport.stlFromTriangles(tris, sim.model.name), "model/stl");
        } else {
          FXExport.download(`${base}.obj`, FXExport.objFromTriangles(tris, sim.model.name), "text/plain;charset=utf-8");
        }
        this.toast(`${fmt.toUpperCase()} 已导出：${tris.length.toLocaleString()} 三角面（含 ${sim.tf.scale.toFixed(2)}× 缩放）`, "ok");
      } catch (e) {
        console.error("[export]", e);
        this.toast("导出失败：" + (e && e.message || e), "err");
      }
    }

    _regenImageModelDebounced() {
      clearTimeout(this._imgT);
      this._imgT = setTimeout(() => this._regenImageModel(), 280);
    }
    _regenImageModel() {
      const S = this._imgState;
      if (!S.img) return;
      if (this._printLocked()) return this.toast("打印中不可更换模型", "warn");
      const model = FXModels.fromImage(S.img, {
        mode: S.mode, widthMm: S.widthMm, maxH: S.maxH, invert: S.invert,
        threshold: S.threshold, name: S.name.replace(/\.[^.]+$/, ""),
      });
      // 从其他模型切换到图片模型时重置摆放；仅调参数时保留
      const firstLoad = !this.sim.model || this.sim.model.id !== "image";
      this._gcodeState = null;
      this._machineLogState = null;
      this.sim.setModel(model, firstLoad);
      if (this.currentNav === "import") this.renderCtx("import");
    }

    _bindUpload() {
      if (this._isAdopted("uploads")) return; // 文件接入与上传状态由宿主管理（csv-input 仍归洞察面板）
      $("#file-input").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._handleFile(f);
        e.target.value = "";
      });
      $("#gcode-input").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._handleGcodeFile(f);
        e.target.value = "";
      });
      $("#machine-log-input").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._handleMachineLogFile(f);
        e.target.value = "";
      });
      $("#profile-input").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._handleProfileFile(f);
        e.target.value = "";
      });
      $("#calibration-input").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._handleCalibrationFile(f);
        e.target.value = "";
      });
    }

    _handleFile(f) {
      if (!/^image\//.test(f.type)) return this.toast("仅支持图片文件（PNG / JPG / WebP）", "err");
      if (f.size > 20 * 1024 * 1024) return this.toast("图片超过 20MB，请压缩后重试", "err");
      if (this._printLocked()) return this.toast("打印中不可更换模型", "warn");
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => {
          if (!img.naturalWidth || !img.naturalHeight) return this.toast("无法读取图片尺寸，请换一张图", "err");
          this._imgState.img = img;
          this._imgState.name = f.name;
          this._regenImageModel();
          this.toast(`「${f.name}」已转为3D模型并切片`, "ok");
          if (this.currentNav === "import") this.renderCtx("import");
        };
        img.onerror = () => this.toast("图片解析失败", "err");
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    }

    _handleGcodeFile(f) {
      if (!/\.(gcode|gco|gc)$/i.test(f.name || ""))
        return this.toast("请选择 .gcode / .gco / .gc 文件", "err");
      if (f.size > FXGcodeParser.MAX_BYTES)
        return this.toast(`G-code 超过 ${Math.round(FXGcodeParser.MAX_BYTES / 1024 / 1024)}MB`, "err");
      if (this._printLocked()) return this.toast("打印中不可导入 G-code", "warn");
      const rd = new FileReader();
      rd.onerror = () => this.toast("G-code 文件读取失败", "err");
      rd.onload = () => {
        FXGcodeParser.sha256(rd.result).then((sha256) => {
          const sourceText = new root.TextDecoder("utf-8").decode(new Uint8Array(rd.result));
          const origin = String(this.sim.printer.KIN_TAG || "").toLowerCase() === "delta" ? "center" : "corner";
          const parsed = FXGcodeParser.parse(sourceText, {
            densityG: this.sim.material.densityG,
            bedSize: this.sim.printer.BED_SIZE || 256,
            origin,
          });
          parsed.sha256 = sha256;
          const reconcile = FXGcodeParser.reconcile(parsed);
          this.sim.loadImportedToolpath(parsed, { name: f.name, sourceText });
          this._gcodeState = { name: f.name, parsed, reconcile, sha256 };
          this._machineLogState = null;
          this._applyLocks();
          if (this.currentNav === "import") this.renderCtx("import");
          this.toast(`已解析 ${parsed.totalLayers} 层真实 G-code · SHA-256 ${sha256.slice(0, 12)}…`, "ok");
        }).catch((e) => {
          console.error("[gcode-import]", e);
          this.toast("G-code 导入失败：" + (e && e.message || e), "err");
        });
      };
      rd.readAsArrayBuffer(f);
    }

    _handleMachineLogFile(f) {
      if (!this.sim.importedToolpath || !this._gcodeState)
        return this.toast("请先导入要复盘的 G-code", "warn");
      if (!/\.(json|csv)$/i.test(f.name || ""))
        return this.toast("真机日志仅支持 JSON / CSV", "err");
      if (f.size > FXMachineLog.MAX_BYTES)
        return this.toast(`真机日志超过 ${Math.round(FXMachineLog.MAX_BYTES / 1024 / 1024)}MB`, "err");
      const rd = new FileReader();
      rd.onerror = () => this.toast("真机日志读取失败", "err");
      rd.onload = () => {
        try {
          const log = FXMachineLog.parse(rd.result, { name: f.name });
          const binding = FXMachineLog.verifyGcodeBinding(this._gcodeState.parsed, log);
          if (binding.status === "invalid" || binding.status === "unavailable" || binding.status === "mismatch") {
            throw new Error(binding.message);
          }
          log.gcodeBinding = binding;
          if (!binding.verified) log.warnings.push(binding.message);
          const comparison = FXMachineLog.compare(this._gcodeState.parsed, log);
          const observation = FXTimeCalibration.observation(this._gcodeState.parsed, log);
          const calibration = this._calibrationFor(this._gcodeState.parsed, log, true);
          this._machineLogState = { log, comparison, observation, calibration, binding };
          if (this.currentNav === "import") this.renderCtx("import");
          this.toast(`真机日志已接入：生成 ${comparison.length} 项计划/实测对比`, "ok");
        } catch (e) {
          console.error("[machine-log]", e);
          this.toast("真机日志导入失败：" + (e && e.message || e), "err");
        }
      };
      rd.readAsText(f);
    }

    _calibrationFor(parsed, log, record) {
      const model = FXCalibrationRegistry.match({
        machineId: log.machineId,
        firmware: log.firmware,
        material: this.sim.settings.material,
      });
      if (!model) return null;
      const observation = FXTimeCalibration.fromPair(parsed, log, {
        id: log.jobId || log.name,
        machineId: log.machineId,
        firmware: log.firmware,
      });
      return {
        model,
        estimate: FXCalibrationRegistry.estimate(model, parsed.stats.timeSec),
        drift: record
          ? FXCalibrationRegistry.recordObservation(model, observation)
          : FXCalibrationRegistry.drift(model),
      };
    }

    _handleCalibrationFile(f) {
      if (!/\.json$/i.test(f.name || "")) return this.toast("校准包必须是 JSON 文件", "err");
      if (f.size > FXCalibrationRegistry.MAX_BYTES)
        return this.toast("校准包 JSON 超过 2MB", "err");
      const rd = new FileReader();
      rd.onerror = () => this.toast("校准包读取失败", "err");
      rd.onload = () => {
        try {
          const imported = FXCalibrationRegistry.importBundle(JSON.parse(rd.result));
          if (this._machineLogState && this._gcodeState) {
            this._machineLogState.calibration = this._calibrationFor(
              this._gcodeState.parsed,
              this._machineLogState.log,
              false
            );
          }
          if (this.currentNav === "import") this.renderCtx("import");
          this.toast(
            `校准包已导入：${imported.id} r${imported.revision} · ${imported.models.length} 个模型`,
            "ok"
          );
        } catch (e) {
          console.error("[calibration-import]", e);
          this.toast("校准包导入失败：" + (e && e.message || e), "err");
        }
      };
      rd.readAsText(f);
    }

    _handleProfileFile(f) {
      if (!/\.json$/i.test(f.name || "")) return this.toast("Profile 必须是 JSON 文件", "err");
      if (f.size > 2 * 1024 * 1024) return this.toast("Profile JSON 超过 2MB", "err");
      if (this._printLocked()) return this.toast("打印中不可导入 Profile", "warn");
      const rd = new FileReader();
      rd.onerror = () => this.toast("Profile 文件读取失败", "err");
      rd.onload = () => {
        try {
          const added = FXProfiles.importBundle(JSON.parse(rd.result));
          this.rebuildParamPanel();
          if (this.currentNav === "import") this.renderCtx("import");
          this.toast(`Profile 已导入：${added.machines.length} 个机型 · ${added.materials.length} 种材料`, "ok");
        } catch (e) {
          console.error("[profile-import]", e);
          this.toast("Profile 导入失败：" + (e && e.message || e), "err");
        }
      };
      rd.readAsText(f);
    }

    /* — 02 切片分析 — */
    _ctx_slice(body) {
      const sim = this.sim;
      if (!sim.slice) { body.appendChild(el("div", "note", "请先在「模型」中载入模型。")); return; }
      const sl = sim.slice;

      body.appendChild(el("div", "sec-label", "逐层路径预览"));
      const wrap = el("div", "layer-canvas-wrap");
      const cv = el("canvas");
      cv.width = 480; cv.height = 480;
      const tag = el("div", "lc-tag mono");
      wrap.append(cv, tag);
      body.appendChild(wrap);

      const row = el("div", "prow");
      const lab = el("span", "p-lab", "预览层");
      const rng = el("input", "range");
      rng.type = "range"; rng.min = 1; rng.max = sl.totalLayers; rng.step = 1;
      rng.value = Math.max(1, Math.min(sl.totalLayers, sim.layerIdx + 1));
      const val = el("span", "p-val mono");
      row.append(lab, rng, val);
      body.appendChild(row);

      const PATH_COLORS = { perimeter: "#eef1f6", solid: "#ff6a2b", infill: "#7c8698", support: "#4f83e0", skirt: "#4a5261" };
      const PATH_COLORS_3D = { perimeter: 0xeef1f6, solid: 0xff6a2b, infill: 0x7c8698, support: 0x4f83e0, skirt: 0x4a5261 };
      let link3d = true;
      const sync3d = () => {
        if (!link3d) { sim.printer.hideSlicePreview(); return; }
        const li = FXU.clamp(parseInt(rng.value, 10) - 1, 0, sl.totalLayers - 1);
        sim.printer.showSlicePreview(sl.layers[li], PATH_COLORS_3D);
      };
      const draw = () => {
        const li = FXU.clamp(parseInt(rng.value, 10) - 1, 0, sl.totalLayers - 1);
        const layer = sl.layers[li];
        val.innerHTML = `${li + 1}<small>/${sl.totalLayers}</small>`;
        tag.textContent = `LAYER ${li + 1} · Z ${layer.z.toFixed(2)} mm · ${layer.paths.length} paths`;
        rng.style.setProperty("--fill", ((li / Math.max(1, sl.totalLayers - 1)) * 100).toFixed(1) + "%");
        sync3d();
        const c = cv.getContext("2d");
        c.fillStyle = "#2c323e"; c.fillRect(0, 0, 480, 480);
        // 工程网格底纹
        c.strokeStyle = "rgba(196,210,232,0.06)"; c.lineWidth = 1;
        for (let g = 24; g < 480; g += 54) {
          c.beginPath(); c.moveTo(g, 0); c.lineTo(g, 480); c.stroke();
          c.beginPath(); c.moveTo(0, g); c.lineTo(480, g); c.stroke();
        }
        // 打印床边框
        c.strokeStyle = "rgba(238,241,246,0.22)"; c.lineWidth = 1.5;
        c.strokeRect(24, 24, 432, 432);
        const sc = 432 / (sim.printer.BED_SIZE || 256);
        const X = (x) => 240 + x * sc, Y = (y) => 240 - y * sc;
        for (const p of layer.paths) {
          c.strokeStyle = PATH_COLORS[p.type] || "#888";
          c.lineWidth = p.type === "perimeter" ? 1.7 : 1.1;
          c.globalAlpha = p.type === "support" ? 0.75 : 1;
          c.beginPath();
          p.pts.forEach((q, i) => (i ? c.lineTo(X(q.x), Y(q.y)) : c.moveTo(X(q.x), Y(q.y))));
          c.stroke();
        }
        c.globalAlpha = 1;
      };
      rng.addEventListener("input", draw);
      draw();

      const leg = el("div", "legend-row");
      leg.innerHTML = `<span><i style="background:#aeb6c4"></i>周界</span><span><i style="background:#ff6a2b"></i>实心</span>
        <span><i style="background:#7c8698"></i>填充</span><span><i style="background:#4f83e0"></i>支撑</span><span><i style="background:#4a5261"></i>裙边</span>`;
      const linkChk = el("label", "mini-check");
      linkChk.innerHTML = `<input type="checkbox" checked><span>3D 视口联动</span>`;
      linkChk.title = "在 3D 视口中按真实切片数据绘制当前预览层的挤出路径";
      linkChk.querySelector("input").addEventListener("change", (e) => { link3d = e.target.checked; sync3d(); });
      leg.appendChild(linkChk);
      body.appendChild(leg);
      // 面板销毁（切页/重渲染）时清掉视口中的路径预览
      this._disposers.push(() => sim.printer.hideSlicePreview());

      body.appendChild(el("div", "sec-label", "切片统计"));
      const kv = el("div", "");
      kv.innerHTML = `
        <div class="kv"><span class="k">总层数</span><span class="v hl">${sl.totalLayers}</span></div>
        <div class="kv"><span class="k">层高</span><span class="v">${sim.settings.layerHeight.toFixed(2)} mm</span></div>
        <div class="kv"><span class="k">挤出路径总长</span><span class="v">${(sl.stats.extLenMm / 1000).toFixed(1)} m</span></div>
        <div class="kv"><span class="k">空驶总长</span><span class="v">${(sl.stats.travelMm / 1000).toFixed(1)} m</span></div>
        <div class="kv"><span class="k">材料体积</span><span class="v">${sl.stats.volumeCm3.toFixed(1)} cm³</span></div>
        <div class="kv"><span class="k">预估时长</span><span class="v hl">${FXU.fmtHuman(sim.estimateTotal())}</span></div>`;
      body.appendChild(kv);

      if (sim.model.needSupport && !sim.settings.supportEnabled)
        body.appendChild(el("div", "note", "⚠ 该模型存在 >60° 悬垂面，当前未启用支撑，顶部法兰将无法成形。"));

      this._sub("layer", (d) => {
        if (this.currentNav !== "slice") return;
        rng.value = d.idx; draw();
      });
    }

    /* — 03 平台校准 — */
    _ctx_calib(body) {
      const sim = this.sim;
      body.appendChild(el("div", "sec-label", "自动调平"));
      const btn = el("button", "btn btn-primary btn-block", "运行 3×3 自动调平");
      btn.addEventListener("click", () => sim.runLeveling());
      body.appendChild(btn);
      body.appendChild(el("div", "note", "探针依次触碰平台 9 个采样点（实测本机床面误差场），9 点实测值拟合 5×5 补偿网格；打印时按喷头位置在网格上双线性插值实时补偿 Z（首层全量、6mm 内渐隐）。同一机台重复调平结果稳定一致，切换机型后需重新调平。"));

      body.appendChild(el("div", "sec-label", "补偿网格热力图"));
      const wrap = el("div", "bedmesh-wrap");
      const cv = el("canvas");
      cv.width = 460; cv.height = 300;
      wrap.appendChild(cv);
      body.appendChild(wrap);
      const info = el("div", "");
      body.appendChild(info);

      const draw = () => {
        const c = cv.getContext("2d");
        c.fillStyle = "#2c323e"; c.fillRect(0, 0, 460, 300);
        if (!sim.levelMesh) {
          c.fillStyle = "#7c8698"; c.font = "13px 'Segoe UI', sans-serif";
          c.textAlign = "center";
          c.fillText("尚未执行调平 — 运行后生成热力图", 230, 152);
          info.innerHTML = "";
          return;
        }
        const g = sim.levelMesh.grid;
        const cw = 380 / 4, chh = 232 / 4, ox = 40, oy = 20;
        // 双线性放大渲染
        const res = 46;
        for (let j = 0; j < res; j++) {
          for (let i = 0; i < res; i++) {
            const gx = (i / (res - 1)) * 4, gy = (j / (res - 1)) * 4;
            const i0 = Math.min(3, Math.floor(gx)), j0 = Math.min(3, Math.floor(gy));
            const fx = gx - i0, fy = gy - j0;
            const v = FXU.lerp(
              FXU.lerp(g[j0][i0], g[j0][i0 + 1], fx),
              FXU.lerp(g[j0 + 1][i0], g[j0 + 1][i0 + 1], fx), fy);
            const t = FXU.clamp((v + 0.15) / 0.3, 0, 1);
            const r = Math.round(FXU.lerp(38, 255, Math.max(0, t - 0.5) * 2));
            const b = Math.round(FXU.lerp(255, 40, Math.min(1, t * 2) * 0.9));
            const gg = Math.round(90 + Math.sin(t * Math.PI) * 90);
            c.fillStyle = `rgba(${r},${gg},${b},0.85)`;
            c.fillRect(ox + (i / res) * 380, oy + (j / res) * 232, 380 / res + 1, 232 / res + 1);
          }
        }
        c.strokeStyle = "rgba(255,248,234,0.35)";
        for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
          c.strokeRect(ox + i * cw - 2, oy + j * chh - 2, 4, 4);
          c.fillStyle = "rgba(255,248,234,0.9)";
          c.font = "9px Consolas";
          c.textAlign = "center";
          c.fillText(g[j][i].toFixed(2), ox + i * cw, oy + j * chh + 14);
        }
        const mx = sim.levelMesh.max;
        const smp = sim.levelMesh.samples || [];
        info.innerHTML = `
          <div class="kv"><span class="k">最大偏差</span><span class="v ${Math.abs(mx) > 0.15 ? "warn" : "hl"}">${mx >= 0 ? "+" : ""}${mx.toFixed(3)} mm</span></div>
          <div class="kv"><span class="k">探测样本</span><span class="v mono" style="font-size:11px">${smp.map((v) => (v >= 0 ? "+" : "") + v.toFixed(2)).join(" ")}</span></div>
          <div class="kv"><span class="k">校准时间</span><span class="v">${sim.levelMesh.at.toLocaleTimeString()}</span></div>
          <div class="kv"><span class="k">打印补偿</span><span class="v hl">首层全量 · 6mm 内渐隐</span></div>`;
      };
      draw();
      this._sub("levelmesh", draw);

      body.appendChild(el("div", "sec-label", "Z 轴微调"));
      this._slider(body, { label: "Z 偏移", min: -0.3, max: 0.3, step: 0.01, unit: "mm", dec: 2,
        get: () => sim.settings.zOffset, set: (v) => sim.updateSettings({ zOffset: v }) });
      body.appendChild(el("div", "note", "负值使喷嘴贴近平台（增强附着），正值抬升喷嘴（防刮擦）。"));
    }

    /* — 04 质量评估 — */
    _ctx_quality(body) {
      const sim = this.sim;

      /* 成品实测报告（打印完成后由运行遥测生成，每一分都来自本次真实采集） */
      const aq = sim.lastQuality;
      if (aq) {
        body.appendChild(el("div", "sec-label", "本次成品实测报告"));
        const gcol = aq.score >= 80 ? "var(--ok)" : aq.score >= 55 ? "var(--warn)" : "var(--err)";
        const sum = el("div", "note",
          `实测评级 <b class="mono" style="color:${gcol}">${aq.grade}</b> · 综合 <b class="mono" style="color:${gcol}">${aq.score}</b> / 100
           — 机时 ${FXU.fmtHuman(aq.elapsed)} · 耗材 ${aq.usedG.toFixed(1)} g · ${aq.at.toLocaleTimeString()} 完成。
           数据来源：打印全程遥测（温度曲线 / 调平网格 / 事件实录 / 速度轨迹）。`);
        body.appendChild(sum);
        for (const q of aq.checks) {
          const item = el("div", "qcheck");
          const col = q.level === "good" ? "var(--ok)" : q.level === "mid" ? "var(--warn)" : "var(--err)";
          item.innerHTML = `
            <div class="qc-head"><span class="qc-name">${q.name}</span>
            <span class="qc-score q-${q.level} mono">${q.score}</span></div>
            <div class="qc-bar"><div class="qc-fill" style="width:${q.score}%;background:${col}"></div></div>
            <div class="qc-tip">${q.tip}</div>`;
          body.appendChild(item);
        }
      } else {
        body.appendChild(el("div", "sec-label", "本次成品实测报告"));
        body.appendChild(el("div", "note", sim.state === "print" || sim.state === "pause" || sim.state === "fault"
          ? "打印进行中，正在采集运行遥测（温度偏差 / 事件 / 速度轨迹），完成后生成实测报告。"
          : "尚无成品。完成一次打印后，这里将基于全程运行遥测生成实测质量报告。"));
      }

      /* 打印前参数预估（随参数实时推导） */
      const checks = FXSim.computeQuality(sim.settings, sim.model);
      const avg = Math.round(checks.reduce((s, q) => s + q.score, 0) / checks.length);
      body.appendChild(el("div", "sec-label", "打印前参数预估"));
      const sum = el("div", "note", `综合工艺评分 <b class="mono" style="color:${avg >= 80 ? "var(--ok)" : avg >= 55 ? "var(--warn)" : "var(--err)"}">${avg}</b> / 100 — 随参数实时更新，开始打印前建议消除全部红色项。`);
      body.appendChild(sum);
      for (const q of checks) {
        const item = el("div", "qcheck");
        const col = q.level === "good" ? "var(--ok)" : q.level === "mid" ? "var(--warn)" : "var(--err)";
        item.innerHTML = `
          <div class="qc-head"><span class="qc-name">${q.name}</span>
          <span class="qc-score q-${q.level} mono">${q.score}</span></div>
          <div class="qc-bar"><div class="qc-fill" style="width:${q.score}%;background:${col}"></div></div>
          <div class="qc-tip">${q.tip}</div>`;
        body.appendChild(item);
      }
      this._sub("settings", () => { if (this.currentNav === "quality") this.renderCtx("quality"); });
      this._sub("quality-actual", () => { if (this.currentNav === "quality") this.renderCtx("quality"); });
    }

    /* ══ 监控浮层 ═══════════════════════════ */

    _bindMonitor() {
      if (this._isAdopted("overlays")) return; // 监控浮层的图表、日志与故障演练由宿主渲染
      this.chartCv = $("#chart-canvas");
      // 故障演练入口（原「打印监控」页并入监控浮层）
      const body = $("#monitor-pop .mon-body");
      const head = el("div", "log-head");
      head.innerHTML = `<span class="ch-lab">故障演练</span>`;
      body.appendChild(head);
      const row = el("div", "chip-row");
      [["runout", "断料", "料架传感器直报：耗材中断"],
       ["jam", "堵料", "挤出机负载异常直报"],
       ["thermal", "热失控", "物理注入：加热器失效 → 温度真实下跌 → 由热失控监测器凭实测偏差发现（约 3–10s）"]].forEach(([k, lab, tip]) => {
        const c = el("div", "chip sm", lab);
        c.title = tip;
        c.addEventListener("click", () => this.sim.injectFault(k));
        row.appendChild(c);
      });
      body.appendChild(row);
    }

    _bindBus() {
      this.bus.on("state", () => this._onState());
      this.bus.on("sliced", () => {
        if (this.currentNav === "slice") this.renderCtx("slice");
      });
      this.bus.on("settings", () => this._syncAllCtrls());
      if (this._isAdopted("overlays")) return; // 日志、故障提示与完成提示由宿主订阅
      this.bus.on("log", ({ lv, msg }) => this._appendLog(lv, msg));
      this.bus.on("fault", (f) => {
        this.toast(`故障：${f.name}`, "err");
        this._openPanel($("#monitor-pop"), $("#btn-monitor"));   // 故障时自动展开日志，便于排查
      });
      this.bus.on("done", () => this.toast("打印完成，成品已就绪 — 「质量」页查看实测报告，「模型」页可导出 STL / OBJ / G-code", "ok"));
    }

    _onState() {
      const s = this.sim.state;
      if (!this._isAdopted("cockpit")) {
        const pill = $("#status-pill");
        pill.className = "status-pill pill-card st-" + { idle: "idle", heat: "heat", level: "level", print: "print", pause: "pause", done: "done", fault: "err" }[s];
        $(".sp-text", pill).textContent = {
          idle: "系统就绪", heat: "预热中", level: "自动调平", print: "打印进行中",
          pause: "已暂停", done: "任务完成", fault: "故障暂停",
        }[s];
        const bs = $("#btn-start"), bp = $("#btn-pause"), bx = $("#btn-stop");
        bs.disabled = !(s === "idle" || s === "done");
        bs.innerHTML = `<span class="bi bi-play"></span>${s === "done" ? "再次打印" : "开始打印"}`;
        bp.disabled = !["print", "pause", "fault", "heat", "level"].includes(s);
        const resuming = s === "pause" || s === "fault";
        bp.innerHTML = `<span class="bi ${resuming ? "bi-play" : "bi-pause"}"></span>`;
        bp.title = s === "pause" ? "继续" : s === "fault" ? "排除故障并恢复" : "暂停";
        bx.disabled = ["idle", "done"].includes(s);
      }
      this._applyLocks();
      this.sim.printer.showGhost(s === "idle");
      if (this.currentNav === "import" && !$("#ctx-panel").hidden) this.renderCtx("import");
    }

    _appendLog(lv, msg) {
      const list = $("#log-list");
      const item = el("div", "log-item lv-" + lv, `<span class="lt">${FXU.nowHMS()}</span><span>${FXU.esc(msg)}</span>`);
      list.appendChild(item);
      while (list.children.length > 240) list.removeChild(list.firstChild);
      if ($("#log-autoscroll").checked) list.scrollTop = list.scrollHeight;
    }

    /* 周期 UI 刷新（低频文本 + 图表） */
    _startUiLoop() {
      if (!this._isAdopted("telemetry")) setInterval(() => {
        if (document.hidden) return;
        const sim = this.sim;
        // 进度环
        const pct = Math.round(sim.progress * 100);
        $("#ring-val").innerHTML = `${pct}<span>%</span>`;
        $("#ring-fg").style.strokeDashoffset = (257.6 * (1 - sim.progress)).toFixed(1);
        // Dock 统计
        $("#stat-layer").textContent = sim.slice && sim.state !== "idle"
          ? `${Math.min(sim.layerIdx + 1, sim.slice.totalLayers)} / ${sim.slice.totalLayers}`
          : sim.slice ? `— / ${sim.slice.totalLayers}` : "— / —";
        $("#stat-elapsed").textContent = FXU.fmtDuration(sim.machineElapsed);
        const rem = sim.estimateRemaining();
        $("#stat-remain").textContent = ["print", "heat", "level", "pause", "fault"].includes(sim.state) ? FXU.fmtDuration(rem) : sim.slice ? FXU.fmtDuration(sim.estimateTotal()) : "—";
        $("#stat-eta").textContent = ["print", "heat", "level"].includes(sim.state) ? FXU.fmtClockAfter(rem / sim.simMult) : "—";
        // 温度读数
        $("#noz-now").textContent = `${(sim.nozzleNow || 26).toFixed(0)}°/${sim.nozzleT.target.toFixed(0)}°`;
        $("#bed-now").textContent = `${(sim.bedNow || 26).toFixed(0)}°/${sim.bedT.target.toFixed(0)}°`;
        // 耗材
        const remainG = Math.max(0, sim.spoolTotalG - sim.usedG);
        $("#mat-grams").textContent = `${remainG.toFixed(0)} g`;
        $("#mat-bar").style.width = ((remainG / sim.spoolTotalG) * 100).toFixed(1) + "%";
        $("#mat-len").textContent = `已用 ${(sim.usedLenMm / 1000).toFixed(2)} m · ${sim.usedG.toFixed(1)} g`;
        // 负载
        const printing = sim.state === "print";
        const motor = printing ? 42 + (sim.settings.speed / 300) * 40 + Math.random() * 6 : sim.state === "level" || sim.state === "heat" ? 25 : 4;
        const mcu = 18 + (printing ? 26 : 6) + Math.random() * 5;
        const heatW = (sim.nozzleT.target > 50 ? 42 * (1 - Math.min(1, Math.abs(sim.nozzleNow - sim.nozzleT.target) < 4 ? 0.5 : 0)) : 0)
          + (sim.bedT.target > 40 ? (sim.bedNow < sim.bedT.target - 4 ? 210 : 65) : 0);
        $("#load-motor").style.width = Math.min(100, motor).toFixed(0) + "%";
        $("#load-mcu").style.width = Math.min(100, mcu).toFixed(0) + "%";
        $("#load-psu").textContent = `${Math.round(38 + heatW + motor * 1.4)} W`;
        // HUD
        $("#hud-action").textContent = sim.currentAction;
        const z = sim.slice && sim.state !== "idle" && sim.layerIdx < sim.slice.totalLayers
          ? sim.slice.layers[Math.min(sim.layerIdx, sim.slice.totalLayers - 1)].z : 0;
        const half = (sim.printer.BED_SIZE || 256) / 2;
        $("#hud-coords").textContent =
          `X ${(sim.headPos.x + half).toFixed(1)} · Y ${(sim.headPos.y + half).toFixed(1)} · Z ${z.toFixed(2)}`;
      }, 240);

      // 温度采样 + 绘图（overlays 接管时由宿主执行）
      if (this._isAdopted("overlays")) return;
      setInterval(() => {
        if (document.hidden) return;
        const sim = this.sim;
        const d = this._chart.data;
        d.push({ n: sim.nozzleNow || 26, b: sim.bedNow || 26, nt: sim.nozzleT.target, bt: sim.bedT.target });
        if (d.length > 150) d.shift();
        if (!$("#monitor-pop").hidden) this._drawChart();
      }, 600);
    }

    _drawChart() {
      const cv = this.chartCv;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const c = cv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      const d = this._chart.data;
      if (d.length < 2) return;
      let max = 80;
      for (const p of d) max = Math.max(max, p.n, p.b, p.nt, p.bt);
      max *= 1.15;
      const X = (i) => (i / (150 - 1)) * w;
      const Y = (v) => h - (v / max) * (h - 6) - 3;
      // 刻度线
      c.strokeStyle = "rgba(238,241,246,0.07)";
      c.lineWidth = 1;
      for (const t of [100, 200]) {
        if (t > max) continue;
        c.beginPath(); c.moveTo(0, Y(t)); c.lineTo(w, Y(t)); c.stroke();
      }
      // 目标虚线
      const last = d[d.length - 1];
      c.setLineDash([4, 4]);
      if (last.nt > 30) { c.strokeStyle = "rgba(255,106,43,0.45)"; c.beginPath(); c.moveTo(0, Y(last.nt)); c.lineTo(w, Y(last.nt)); c.stroke(); }
      if (last.bt > 30) { c.strokeStyle = "rgba(79,131,224,0.45)"; c.beginPath(); c.moveTo(0, Y(last.bt)); c.lineTo(w, Y(last.bt)); c.stroke(); }
      c.setLineDash([]);
      // 喷嘴曲线（带渐变填充）
      const off = 150 - d.length;
      const grad = c.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(255,106,43,0.22)");
      grad.addColorStop(1, "rgba(255,106,43,0)");
      c.beginPath();
      d.forEach((p, i) => (i ? c.lineTo(X(off + i), Y(p.n)) : c.moveTo(X(off + i), Y(p.n))));
      c.strokeStyle = "#ff6a2b"; c.lineWidth = 1.6; c.stroke();
      c.lineTo(X(149), h); c.lineTo(X(off), h); c.closePath();
      c.fillStyle = grad; c.fill();
      // 热床曲线
      c.beginPath();
      d.forEach((p, i) => (i ? c.lineTo(X(off + i), Y(p.b)) : c.moveTo(X(off + i), Y(p.b))));
      c.strokeStyle = "#4f83e0"; c.lineWidth = 1.4; c.stroke();
    }

    /* ══ 浮层 ═══════════════════════════════ */

    toast(msg, type) {
      /* 浮层接管时汇入宿主的 toast 队列：遗留内部调用（导出、上传等）与宿主提示走同一实现。 */
      if (this._isAdopted("overlays")) { this.bus.emit("toast", { msg, type }); return; }
      const box = $("#toasts");
      const t = el("div", "toast t-" + (type || "info"), FXU.esc(msg));
      box.appendChild(t);
      setTimeout(() => t.classList.add("out"), 2600);
      setTimeout(() => t.remove(), 3100);
      while (box.children.length > 4) box.removeChild(box.firstChild);
    }

    /* 供宿主复用的确认弹层：接管 Dock 的宿主仍需与旧入口一致的停止二次确认。 */
    confirmAction(title, text, onOk) {
      this._confirm(title, text, onOk);
    }

    _confirm(title, text, onOk) {
      if (this._isAdopted("overlays")) { this.bus.emit("confirm", { title, text, onOk }); return; }
      const mask = el("div", "modal-mask");
      mask.innerHTML = `<div class="modal"><h3><span class="ph-tick"></span>${title}</h3><p>${text}</p>
        <div class="m-btns"><button class="btn btn-ghost" data-a="no">取消</button>
        <button class="btn btn-danger-ghost" data-a="ok">确认停止</button></div></div>`;
      mask.addEventListener("click", (e) => {
        const a = e.target.dataset && e.target.dataset.a;
        if (a === "ok") { onOk(); mask.remove(); }
        else if (a === "no" || e.target === mask) mask.remove();
      });
      $("#modal-root").appendChild(mask);
    }

    _aboutModal() {
      const mask = el("div", "modal-mask");
      mask.innerHTML = `<div class="modal"><h3><span class="ph-tick"></span>FORGE·X 智造洞察</h3>
        <p>FORGE·X 工业 3D 打印仿真 × 生产数据分析：左手模拟四款可切换机型（CoreXY 封闭式 / i3 龙门 / Delta 并联臂 / 工业大幅面龙门）的完整打印流程，右手对生产数据做聚合分析。</p>
        <p><b>快速上手</b><br>
        ① 顶部「模型」：切换打印机型，选择内置零件或上传图片生成浮雕 / 剪影模型<br>
        ② 右上 <b>参数按钮</b>：调整工艺参数，「质量」页实时评估风险<br>
        ③ 底部 Dock「开始打印」，观察喷头沿切片路径逐层成形<br>
        ④ 右下 <b>波形按钮</b>：温度曲线、耗材、日志与故障演练<br>
        ⑤ 顶部「<b>洞察</b>」：对生产数据提问 — 故障归因、材料对比、成本趋势</p>
        <p><b>关于分析引擎</b>　默认引擎是<b>规则引擎，不是 AI</b>：关键词意图路由 + 确定性聚合统计，只覆盖 5 个分析维度，问题超出范围时它会明说没听懂。配置 InfiniSynapse 密钥后可切换到云端 AI。</p>
        <p><b>数据来源</b>　内置示例是<b>合成数据</b>（预埋了故事线，仅供演示，不可据此下真实结论，界面上有「合成」标记）；支持上传自己的 CSV；每次打印完成会自动采集为「仿真采集」数据集——那是真实的物理仿真结果。</p>
        <p><b>视口操作</b>　<span class="kbd">左键拖拽</span> 旋转 · <span class="kbd">右键拖拽</span> 平移 · <span class="kbd">滚轮</span> 缩放</p>
        <div class="m-btns"><button class="btn btn-primary" data-a="ok">开始使用</button></div></div>`;
      mask.addEventListener("click", (e) => {
        if ((e.target.dataset && e.target.dataset.a) || e.target === mask) mask.remove();
      });
      $("#modal-root").appendChild(mask);
    }
  }

  root.FXUI = FXUI;
})(typeof window !== "undefined" ? window : globalThis);
