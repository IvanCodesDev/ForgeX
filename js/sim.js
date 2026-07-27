/* FORGE·X — 打印仿真核心：状态机 / 运动执行 / 温控惯性 / 耗材消耗 / 质量推导 / 故障注入 */
(function (root) {
  "use strict";

  const FALLBACK_MATERIALS = {
    PLA:  { id: "PLA", name: "PLA",  nozzleTemp: 210, bedTemp: 60,  fan: 100, densityG: 1.24, nozzleRange: [195, 225], bedMin: 55,  maxSpeed: 300, flowMm3s: 11, shrinkage: 0.25 },
    PETG: { id: "PETG", name: "PETG", nozzleTemp: 240, bedTemp: 80,  fan: 40,  densityG: 1.27, nozzleRange: [230, 255], bedMin: 70,  maxSpeed: 200, flowMm3s: 9, shrinkage: 0.45 },
    ABS:  { id: "ABS", name: "ABS",  nozzleTemp: 255, bedTemp: 100, fan: 15,  densityG: 1.05, nozzleRange: [245, 268], bedMin: 95,  maxSpeed: 220, flowMm3s: 10, shrinkage: 1 },
    TPU:  { id: "TPU", name: "TPU",  nozzleTemp: 225, bedTemp: 50,  fan: 50,  densityG: 1.21, nozzleRange: [215, 240], bedMin: 40,  maxSpeed: 60, flowMm3s: 3.5, shrinkage: 0.35 },
  };
  const MATERIALS = root.FXProfiles ? root.FXProfiles.materials : FALLBACK_MATERIALS;

  const COLORS = [
    { name: "石墨黑", hex: 0x2c313a },
    { name: "钛灰",   hex: 0x8d97a8 },
    { name: "工业蓝", hex: 0x3d6fd6 },
    { name: "冷白",   hex: 0xdde4ee },
    { name: "青瓷",   hex: 0x53c3c8 },
  ];

  const TYPE_LABEL = { perimeter: "轮廓周界", infill: "稀疏填充", solid: "实心填充", support: "支撑结构", skirt: "裙边预挤出" };

  /** 机构负载超阈值需持续多久（机时秒）才判为故障。瞬时尖峰不报警，与真实固件一致。 */
  const MECH_HOLD_S = 6;
  /** 预热多久仍够不到目标温度即判加热失败（机时秒，参考 Marlin 的 heating-failed 保护） */
  const HEAT_TIMEOUT_S = 240;

  class FXSim {
    constructor(fx, bus) {
      this.fx = fx;                    // FXScene
      this.printer = fx.printer;
      this.bus = bus;

      this.settings = {
        material: "PLA",
        colorIdx: 2,
        layerHeight: 0.2,
        extrusionWidth: 0.45,
        perimeters: 2,
        solidLayers: 3,
        infillDensity: 0.18,
        infillPattern: "斜线网格",
        nozzleTemp: 210,
        bedTemp: 60,
        speed: 120,
        travelSpeed: 260,
        retraction: 1.2,
        fanSpeed: 100,
        supportEnabled: true,
        supportSpacing: 4.5,
        skirtLoops: 2,
        skirtGap: 5,
        autoLevel: true,
        zOffset: 0.0,
      };
      this.tf = { scale: 1, rotZ: 0, offX: 0, offY: 0 };

      this.state = "idle";
      this.simMult = 4;
      this.model = null;
      this.slice = null;
      this.importedToolpath = null;
      this._slicedSpeed = this.settings.speed;

      // 机台身份：机型标签 + 实例号 → 决定这台机器的固有物理特征
      this.machineInstance = 1;

      // 温控
      // 固定噪声相位：喷嘴与热床各用一个，互不相关但完全确定
      this.nozzleT = new FXU.ThermalSim(26, 11, 3.6, 0);
      this.bedT = new FXU.ThermalSim(26, 30, 1.0, 4.13);

      // 耗材（1kg 料盘）
      this.spoolTotalG = 1000;
      this.usedG = 0;
      this.usedLenMm = 0;

      // 运行时
      this.machineElapsed = 0;
      this.layerIdx = 0;
      this.progress = 0;
      this.currentAction = "待机";
      this.headPos = { x: 0, y: 0 };
      this.bedTargetY = this.printer.NOZZLE_Y - 150;
      this.printer.setBedTopY(this.bedTargetY);
      this.levelMesh = null;             // 5×5 调平数据（由 9 点实测拟合）
      this.leveledOnce = false;
      this.faultInfo = null;
      this.lastQuality = null;           // 最近一次打印的实测质量报告
      this._telemetry = null;            // 本次打印运行遥测（质量实测数据源）
      this._bedErr = null;               // 当前机台的床面误差场（确定性，机台固有）
      this._bedErrId = "";

      this._layer = null;
      this._doneExtBefore = 0;
      this._doneTimeBefore = 0;
      this._milestone = 0;
      this._lowMatWarned = 0;
    }

    log(lv, msg) { this.bus.emit("log", { lv, msg }); }
    setState(s) {
      this.state = s;
      this.bus.emit("state", s);
      const led = { idle: 0xeef1f6, heat: 0xe59a3a, level: 0x4f83e0, print: 0xff6a2b, pause: 0xe59a3a, done: 0x2ca878, fault: 0xe0484d }[s];
      if (led) this.printer.setStateLED(led);
    }

    get material() { return MATERIALS[this.settings.material] || MATERIALS.PLA || FALLBACK_MATERIALS.PLA; }
    get partColor() { return COLORS[this.settings.colorIdx].hex; }

    /* ── 机台身份与固有物理特征 ──────────────
       故障不是抽出来的：每台机器有确定性的磨损/加热器健康度/环境参数，
       仿真过程按这些特征真实演化，故障是因果链的结果。见 js/machine-profile.js。 */

    /** 机台编号，如 "FX-256-03"。取自仿真器实际装载的机型 + 实例号 */
    get machineId() {
      const tag = (this.printer && (this.printer.MODEL_TAG || this.printer.MODEL_NAME)) || "UNKNOWN";
      return String(tag) + "-" + String(this.machineInstance).padStart(2, "0");
    }

    /** 本机台的固有物理特征（确定性，同一 machineId 恒定） */
    get machineProfile() {
      const id = this.machineId;
      if (!this._profCache || this._profCache.id !== id) {
        const profilePhysics = this.printer && this.printer.PROFILE && this.printer.PROFILE.physics;
        const overrides = Object.assign({}, profilePhysics || {}, this._profOverride || {});
        this._profCache = FXMachineProfile.of(id, Object.keys(overrides).length ? overrides : null);
        // 加热器健康度直接落到热模型：功率不足 → 够不到高温目标 → 热失控监测器发现
        this.nozzleT.ceilingC = FXMachineProfile.heaterCeilingC(this._profCache, this._profCache.ambientC);
        this.nozzleT.ambient = this._profCache.ambientC;
        this.bedT.ambient = this._profCache.ambientC;
      }
      return this._profCache;
    }

    /** 切换机台实例（虚拟机群用）。overrides 仅供测试注入极端特征。 */
    setMachineInstance(n, overrides) {
      this.machineInstance = Math.max(1, n | 0);
      this._profOverride = overrides || null;
      this._profCache = null;
      this._bedErr = null;          // 床面误差场随机台变化
      this._bedErrId = "";
      this.levelMesh = null;        // 换机台后旧调平数据作废
      this.leveledOnce = false;
      return this.machineProfile;
    }

    /* ── 模型与切片 ─────────────────────── */

    setModel(model, resetTf) {
      this.importedToolpath = null;
      this.model = model;
      if (resetTf) this.tf = { scale: 1, rotZ: 0, offX: 0, offY: 0 };
      this.reslice();
      this.log("info", `模型已载入：${model.name}（${model.dims}）`);
    }

    reslice() {
      if (!this.model || this.importedToolpath) return;
      const t0 = performance.now();
      this.slice = FXSlicer.slice(this.model, this.tf, this.settings);
      this._slicedSpeed = this.settings.speed;
      this.printer.attachPart(this.model, this.tf, this.partColor, this.settings.layerHeight);
      this.printer.showGhost(this.state === "idle" || this.state === "done");
      this.bus.emit("sliced", { ms: performance.now() - t0 });
    }

    updateTf(patch) {
      Object.assign(this.tf, patch);
      // 限制在打印平台内
      const r = (this.model ? this.model.footprintR : 30) * this.tf.scale;
      const half = Math.max(25, (this.printer.BED_SIZE || 256) / 2);
      const lim = half - Math.min(half - 8, r);
      this.tf.offX = FXU.clamp(this.tf.offX, -lim, lim);
      this.tf.offY = FXU.clamp(this.tf.offY, -lim, lim);
      this.printer.updatePartTf(this.tf);
    }

    updateSettings(patch) {
      const geomKeys = ["layerHeight", "perimeters", "solidLayers", "infillDensity", "infillPattern", "supportEnabled", "supportSpacing", "skirtLoops"];
      const busy = ["print", "pause", "heat", "level", "fault"].includes(this.state);
      if (busy || this.importedToolpath) {
        // 打印链路中几何参数与切片数据必须保持一致：拒绝几何类改动
        for (const k of geomKeys) if (k in patch) delete patch[k];
      }
      Object.assign(this.settings, patch);
      let needSlice = false;
      for (const k of Object.keys(patch)) if (geomKeys.includes(k)) needSlice = true;

      if (busy) {
        // 温度/风扇/速度实时生效
        if (patch.nozzleTemp != null) { this.nozzleT.setTarget(patch.nozzleTemp); this.log("info", `喷嘴目标温度调整 → ${patch.nozzleTemp}°C`); }
        if (patch.bedTemp != null) { this.bedT.setTarget(patch.bedTemp); this.log("info", `热床目标温度调整 → ${patch.bedTemp}°C`); }
        if (patch.speed != null) this.log("info", `打印速度调整 → ${patch.speed} mm/s`);
        if (patch.fanSpeed != null) this.log("info", `风扇转速调整 → ${patch.fanSpeed}%`);
        if (this._telemetry && this.state === "print" &&
            ["nozzleTemp", "bedTemp", "speed", "fanSpeed"].some((k) => patch[k] != null))
          this._telemetry.tunes++;
        return;
      }
      if (needSlice) this.reslice();
    }

    /* ── 机型切换（仅待机/完成态；重挂部件并重放会话状态） ── */

    setPrinterModel(id) {
      if (!["idle", "done"].includes(this.state)) { this.log("warn", "打印进行中，不可切换机型"); return false; }
      if (this.printer.ID === id) return false;
      const p = this.fx.swapPrinter(id);
      this.printer = p;
      // 会话状态重放：耗材颜色/余量、平台待机位、喷头归位
      p.setFilamentColor(this.partColor);
      p.setSpoolFrac((this.spoolTotalG - this.usedG) / this.spoolTotalG);
      this.bedTargetY = p.NOZZLE_Y - 150;
      p.setBedTopY(this.bedTargetY);
      this.headPos = { x: 0, y: 0 };
      p.setHeadXY(0, 0);
      // 新机台需要重新调平；上一台的成品/进度不带入
      this.levelMesh = null;
      this.leveledOnce = false;
      this.bus.emit("levelmesh");
      this.progress = 0;
      this.currentAction = "待机";
      this.setState("idle");               // 重驱 LED 与 UI 状态（含新机 stateLED）
      if (this.importedToolpath && this.slice) {
        p.attachToolpath(this.slice, this.partColor);
        p.showGhost(true);
      } else if (this.model) {
        this.reslice();
      }
      this.log("ok", `机型切换 → ${p.MODEL_NAME}（${p.KIN_TAG} 运动学）· 请重新调平`);
      return true;
    }

    applyMaterial(key) {
      const m = MATERIALS[key];
      if (!m) return;
      this.settings.material = key;
      this.settings.nozzleTemp = m.nozzleTemp;
      this.settings.bedTemp = m.bedTemp;
      this.settings.fanSpeed = m.fan;
      if (this.settings.speed > m.maxSpeed) this.settings.speed = m.maxSpeed;
      if (this.importedToolpath && this.slice && this.slice.stats)
        this.slice.stats.filamentG = this.slice.stats.volumeCm3 * m.densityG;
      this.log("info", `材料切换 → ${m.name || key}（喷嘴 ${m.nozzleTemp}°C / 热床 ${m.bedTemp}°C / 风扇 ${m.fan}%）`);
      this.bus.emit("settings");
    }

    /** 载入真实 G-code 解析结果。路径结构与切片器同构，直接复用预览和状态机。 */
    loadImportedToolpath(parsed, meta) {
      if (!parsed || !parsed.layers || !parsed.layers.length) throw new Error("G-code 路径为空");
      if (!["idle", "done"].includes(this.state)) throw new Error("打印进行中，无法导入 G-code");
      meta = meta || {};
      const b = parsed.bounds || { minX: -20, maxX: 20, minY: -20, maxY: 20 };
      const w = Math.max(0, b.maxX - b.minX), d = Math.max(0, b.maxY - b.minY);
      const diffs = [];
      for (let i = 1; i < parsed.layers.length; i++) {
        const dz = parsed.layers[i].z - parsed.layers[i - 1].z;
        if (dz > 0.01 && dz < 2) diffs.push(dz);
      }
      diffs.sort((a, b2) => a - b2);
      const layerH = diffs.length ? diffs[Math.floor(diffs.length / 2)] : Math.max(0.05, parsed.height || 0.2);
      this.importedToolpath = { name: meta.name || "Imported G-code", sourceText: meta.sourceText || "", parsed };
      this.model = {
        id: "gcode-import",
        name: meta.name || "Imported G-code",
        dims: `${w.toFixed(1)} × ${d.toFixed(1)} × ${parsed.height.toFixed(1)} mm`,
        height: parsed.height,
        footprintR: Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY)),
        needSupport: false,
        source: "gcode-import",
      };
      this.tf = { scale: 1, rotZ: 0, offX: 0, offY: 0 };
      this.slice = parsed;
      this.settings.layerHeight = Math.max(0.05, Math.min(1, layerH));
      if (parsed.claims && parsed.claims.nozzleTemp != null) this.settings.nozzleTemp = parsed.claims.nozzleTemp;
      if (parsed.claims && parsed.claims.bedTemp != null) this.settings.bedTemp = parsed.claims.bedTemp;
      this._slicedSpeed = this.settings.speed;
      this.printer.attachToolpath(parsed, this.partColor);
      this.printer.showGhost(true);
      this.progress = 0;
      this.layerIdx = 0;
      this.bus.emit("sliced", { ms: 0, source: "gcode-import" });
      this.bus.emit("settings");
      this.log("ok", `真实 G-code 已载入：${this.model.name} · ${parsed.totalLayers} 层 · ${parsed.stats.filamentM.toFixed(2)} m 耗材`);
      return this.model;
    }

    /* ── 控制 ───────────────────────────── */

    start() {
      if (!this.slice) { this.log("warn", "未载入模型，无法开始打印"); return; }
      if (this.state === "done" || this.state === "idle") {
        this.printer.setGrownHeight(0);
        this.printer.showPart(false);
        this.printer.showGhost(false);
        this.machineElapsed = 0;
        this.layerIdx = 0;
        this.progress = 0;
        this._doneExtBefore = 0;
        this._doneTimeBefore = 0;
        this._milestone = 0;
        this._layer = null;
        this._beginTelemetry();
        this.nozzleT.setTarget(this.settings.nozzleTemp);
        this.bedT.setTarget(this.settings.bedTemp);
        this.setState("heat");
        this.currentAction = "预热中";
        this._heatMinTimer = 4;
        this._heatElapsed = 0;
        this.log("info", `任务开始：${this.model.name} · ${this.slice.totalLayers} 层 · 预计 ${FXU.fmtHuman(this.estimateTotal())}`);
        this.log("info", `预热：喷嘴 → ${this.settings.nozzleTemp}°C，热床 → ${this.settings.bedTemp}°C`);
        this.bedTargetY = this.printer.NOZZLE_Y - 60;
      }
    }

    /* ── 运行遥测（成品实测质量的数据源，随打印过程真实采集） ── */

    _beginTelemetry() {
      // 首层接触区的床面真实不均匀度（未调平时无补偿，直接决定首层成形）
      const l0 = this.slice.layers[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of l0.paths) for (const q of p.pts) {
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      let eMin = Infinity, eMax = -Infinity;
      for (const [sx, sy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2]]) {
        const e = this.bedErrorAt(sx, sy);
        if (e < eMin) eMin = e; if (e > eMax) eMax = e;
      }
      // 首层投影面积（翘边风险的输入：大平面翘得厉害）
      const firstLayerAreaMm2 = Math.max(0, (x1 - x0) * (y1 - y0));

      this._telemetry = {
        printTime: 0, tempTime: 0, tempDevSum: 0, tempDevMax: 0,
        offSpeedTime: 0, faults: [], pauses: 0, tunes: 0,
        leveled: !!this.levelMesh,
        levelMax: this.levelMesh ? this.levelMesh.max : null,
        firstLayerUneven: eMax - eMin,
        firstLayerAreaMm2: firstLayerAreaMm2,
        usedG0: this.usedG,
        settings0: Object.assign({}, this.settings),
        // 机构负载峰值（堵料/断料的涌现证据，随打印过程真实采集）
        clogLoadMax: 0, slipRiskMax: 0,
        machineId: this.machineId,
        machineProfile: this.machineProfile,
      };
      this.lastQuality = null;
      // autoLevel 开启时预热后会自动调平，无需告警；仅「关掉自动调平且从未调平」才是真裸奔
      if (!this.levelMesh && !this.settings.autoLevel)
        this.log("warn", `未执行调平：首层接触区床面不均匀度实测 ${(eMax - eMin).toFixed(3)} mm，无补偿直接打印`);
    }

    pause(byFault) {
      if (this.state !== "print" && this.state !== "heat" && this.state !== "level") return;
      this._resumeState = this.state;
      this.setState(byFault ? "fault" : "pause");
      this.currentAction = byFault ? "故障暂停" : "已暂停";
      if (!byFault) {
        if (this._telemetry) this._telemetry.pauses++;
        this.log("warn", "打印已暂停");
      }
    }

    resume() {
      if (this.state !== "pause" && this.state !== "fault") return;
      if (this.faultInfo) {
        this.log("ok", `故障已排除：${this.faultInfo.name}`);
        this.faultInfo = null;
        // 排障即修复物理层（加热器失效演练由此复原）
        if (this.nozzleT.heaterBroken) { this.nozzleT.heaterBroken = false; this.log("info", "加热器供电已恢复，重新升温"); }
      }
      // 恢复温度目标（热失控保护会切断加热）
      this.nozzleT.setTarget(this.settings.nozzleTemp);
      this.bedT.setTarget(this.settings.bedTemp);
      this.setState(this._resumeState || "print");
      this.currentAction = "恢复运行";
      this.log("info", "任务恢复");
    }

    stop() {
      if (this.state === "idle" || this.state === "done") return;
      // 故障未排除即中止 → 记为失败任务（供智造洞察采集）；人工取消不计入
      if (this.state === "fault" && this.faultInfo)
        this.bus.emit("job-record", { status: "fail", fault: this.faultInfo.name });
      this.printer.endLayer();
      this.printer.setGrownHeight(0);
      this.printer.showPart(false);
      this.printer.showGhost(true);
      this.nozzleT.setTarget(26);
      this.bedT.setTarget(26);
      this.nozzleT.heaterBroken = false;   // 复位物理层演练状态
      this.faultInfo = null;
      this._layer = null;
      this._telemetry = null;       // 中止无成品，不产出实测报告
      this.setState("idle");
      this.currentAction = "待机";
      this.progress = 0;
      this.bedTargetY = this.printer.NOZZLE_Y - 150;
      this.log("err", "任务已中止，平台已复位");
    }

    injectFault(type) {
      if (this.state !== "print") { this.log("warn", "仅打印中可注入演示故障"); return; }
      if (type === "thermal") {
        // 物理层注入：加热器失效 → 温度按热惯性真实下跌 → 由热失控监测器凭实测偏差发现。
        // 注入本身不报警：报警是监测器的事，检测链路是真实的。
        if (this.nozzleT.heaterBroken) return;
        this.nozzleT.heaterBroken = true;
        this.log("warn", "演练注入：喷嘴加热器供电异常（物理层），温度开始下跌 — 等待热失控监测器发现…");
        return;
      }
      const F = {
        runout: { name: "断料检测触发", msg: "料架传感器：耗材中断，等待换料" },
        jam: { name: "喷嘴堵塞预警", msg: "挤出机负载异常升高（+142%），疑似堵料" },
      }[type];
      if (!F) return;
      this._raiseFault(F);
    }

    /** 拉响故障警报（监测器 / 传感器触发的统一入口） */
    _raiseFault(F) {
      if (this.faultInfo) return;
      this.faultInfo = F;
      if (this._telemetry) this._telemetry.faults.push(F.name);
      this.log("err", `【故障】${F.name} — ${F.msg}`);
      this.pause(true);
      this.bus.emit("fault", F);
    }

    /* ── 机构负载监测（堵料 / 断料的涌现路径） ──────────────
       与热失控监测器同构：不注入故障，只持续观测真实物理量，
       超阈值且持续足够久才报警。所有输入都来自本次打印的实际状态，无概率抽样。 */

    /** 当前挤出状态快照，喂给 FXMachineProfile 的机理模型 */
    _mechState() {
      const st = this.settings;
      const mat = this.material;
      const L = this._layer;
      // 体积流量 mm³/s = 线速度 × 挤出宽度 × 层高
      const v = L && L.phase === "extrude" ? L.curSpeed || 0 : 0;
      const T = this._telemetry;
      return {
        nozzleNow: this.nozzleNow || 0,
        nozzleTarget: this.nozzleT.target,
        materialNominalC: mat.nozzleTemp,
        materialFlowMm3s: this.material.flowMm3s || FXMachineProfile.FLOW_MM3S[st.material] || 9,
        flowMm3s: v * st.extrusionWidth * st.layerHeight,
        extrudedMm3: (this.usedG - (T ? T.usedG0 : 0)) * 1000 / mat.densityG,
        spoolRemainFrac: FXU.clamp((this.spoolTotalG - this.usedG) / this.spoolTotalG, 0, 1),
      };
    }

    /**
     * 送料/热端负载监测器。
     * 堵料：热端阻力（积碳 × 温度不足 × 流量过大）持续超限 → 挤出机负载报警。
     * 断料：送料侧打滑（齿轮咬合力不足 × 料架阻力 × 料盘将空）持续超限 → 断料检测。
     * 两者都是真实机理的结果，同一台机器跑同样的活会稳定复现。
     */
    _mechWatch(dt) {
      if (this.state !== "print" || this.faultInfo) { this._clogT = 0; this._slipT = 0; return; }
      const L = this._layer;
      if (!L || L.phase !== "extrude") return;      // 只在真正挤出时承载

      // 回温期不计负载：排障后喷嘴正从低温爬回目标，此时的高阻力是暂态而非堵料。
      // 与 _thermalWatch 同一条规则（rate > 0.3°C/s 视为正在有效升温），避免两个监测器
      // 对同一个恢复过程给出矛盾结论。
      if ((this._nozzleRate || 0) > 0.3) { this._clogT = 0; return; }

      const mdt = dt * this.simMult;
      const prof = this.machineProfile;
      const s = this._mechState();
      const clog = FXMachineProfile.hotendLoad(prof, s);
      const slip = FXMachineProfile.feedSlipRisk(prof, s);

      const T = this._telemetry;
      if (T) {
        if (clog > T.clogLoadMax) T.clogLoadMax = clog;
        if (slip > T.slipRiskMax) T.slipRiskMax = slip;
      }

      // 超限需持续 MECH_HOLD_S 机时秒才报警——瞬时尖峰不算故障（与真实固件一致）
      this._clogT = clog > 1 ? (this._clogT || 0) + mdt : 0;
      this._slipT = slip > 1 ? (this._slipT || 0) + mdt : 0;

      if (this._clogT >= MECH_HOLD_S) {
        this._clogT = 0;
        this._raiseFault({
          name: "喷嘴堵塞预警",
          msg: `挤出机负载 ${(clog * 100).toFixed(0)}% 于阈值，持续 ${MECH_HOLD_S}s` +
            `（热端积碳 ${(prof.hotendFouling * 100).toFixed(0)}%，喷嘴 ${s.nozzleNow.toFixed(0)}/${s.materialNominalC}°C，` +
            `流量 ${s.flowMm3s.toFixed(1)}/${s.materialFlowMm3s} mm³/s）`,
        });
        return;
      }
      if (this._slipT >= MECH_HOLD_S) {
        this._slipT = 0;
        this._raiseFault({
          name: "断料检测触发",
          msg: `送料齿轮打滑（咬合力 ${(prof.feederGrip * 100).toFixed(0)}%，料架阻力 ${(prof.spoolDrag * 100).toFixed(0)}%，` +
            `料盘余量 ${(s.spoolRemainFrac * 100).toFixed(0)}%），持续 ${MECH_HOLD_S}s`,
        });
      }
    }

    /** 热失控监测器：打印态持续比对「实测 vs 目标」，偏差 >15°C、温度无回升趋势且持续 >3s（机时）→ 保护。
        参考真实固件（Marlin thermal runaway protection）：偏差大但正在有效升温（排障回温）不算失控。
        对任何原因的温度失守都有效（演练注入的加热失效同样由它发现，而非注入直报）。 */
    _thermalWatch(dt) {
      const mdt = dt * this.simMult;
      const rate = this._lastNozzleNow != null && mdt > 0 ? (this.nozzleNow - this._lastNozzleNow) / mdt : 0;
      this._lastNozzleNow = this.nozzleNow;
      this._nozzleRate = rate;      // 供 _mechWatch 复用：回温期不把暂态高阻力算作堵料
      if (this.state !== "print" || this.faultInfo || this.nozzleT.target <= 100) {
        this._thermalT = 0;
        return;
      }
      const dev = this.nozzleT.target - this.nozzleNow;
      if (dev > 15 && rate < 0.3) {          // 偏差大且没有有效升温（>0.3°C/s 视为回温中）
        this._thermalT = (this._thermalT || 0) + mdt;
        if (this._thermalT >= 3) {
          this._raiseFault({
            name: "热失控保护",
            msg: `喷嘴实测 ${this.nozzleNow.toFixed(0)}°C，低于目标 ${this.nozzleT.target.toFixed(0)}°C 达 ${dev.toFixed(0)}°C 且无回升（持续 ${this._thermalT.toFixed(1)}s），加热已切断`,
          });
          this._thermalT = 0;
        }
      } else {
        this._thermalT = 0;
      }
    }

    /* ── 床面误差场与调平（真实数据链：误差场 → 探测采样 → 拟合网格 → 打印补偿） ── */

    /** 机台固有床面误差场（按**机台编号**确定性生成 → 同一台机器重复调平结果一致，
        不同实例的床面各不相同，这是虚拟机群里机台差异的来源之一） */
    _bedErrField() {
      const id = this.machineId;
      if (this._bedErr && this._bedErrId === id) return this._bedErr;
      let seed = 0x9e3779b9;
      for (let i = 0; i < id.length; i++) seed = (Math.imul(seed ^ id.charCodeAt(i), 0x01000193)) >>> 0;
      const noise = FXU.valueNoise2D(seed);
      const rnd = FXU.mulberry32(seed ^ 0x5f356495);
      // 整体倾斜（真实热床最常见的误差成分）+ 平滑起伏（局部凹凸）
      const tiltX = (rnd() - 0.5) * 0.0009;   // mm / mm，边缘最大约 ±0.06
      const tiltY = (rnd() - 0.5) * 0.0009;
      const half = Math.max(25, (this.printer.BED_SIZE || 256) / 2);
      this._bedErr = (x, y) =>
        tiltX * x + tiltY * y +
        (noise(x / half * 1.5 + 3.7, y / half * 1.5 + 8.2) - 0.5) * 0.18;
      this._bedErrId = id;
      this._bedErrSeed = seed;      // 供探针噪声派生，保证同机台探测可复现
      this._probeRnd = null;
      return this._bedErr;
    }

    /** 床面某点的真实高度误差（mm）——探测与首层补偿共用同一数据源 */
    bedErrorAt(x, y) { return this._bedErrField()(x, y); }

    /** 探针重复性误差（±3μm 量级）。按机台 + 探测点确定性生成：
        同一台机器、同一个点，每次探测得到同样的读数——真实探针的重复精度就是这样，
        而且这保证了整条调平数据链可复现。 */
    _probeNoise(x, y) {
      if (!this._probeRnd || this._probeRndId !== this.machineId) {
        this._probeRndId = this.machineId;
        this._probeNoiseFn = FXU.valueNoise2D((this._bedErrSeed || 1) ^ 0x2545f491);
        this._probeRnd = true;
      }
      return (this._probeNoiseFn(x / 17.3 + 11.1, y / 17.3 + 5.5) - 0.5) * 0.006;
    }

    /** 调平补偿：按喷头位置在 5×5 网格上双线性插值（未调平返回 0） */
    meshCompAt(x, y) {
      if (!this.levelMesh) return 0;
      const g = this.levelMesh.grid;
      const half = this.levelMesh.half || Math.max(25, (this.printer.BED_SIZE || 256) / 2);
      const step = half / 2;
      const u = FXU.clamp((x + half) / step, 0, 4);
      const v = FXU.clamp((half - y) / step, 0, 4);
      const i0 = Math.min(3, Math.floor(u)), j0 = Math.min(3, Math.floor(v));
      const fx = u - i0, fy = v - j0;
      return FXU.lerp(
        FXU.lerp(g[j0][i0], g[j0][i0 + 1], fx),
        FXU.lerp(g[j0 + 1][i0], g[j0 + 1][i0 + 1], fx), fy);
    }

    runLeveling() {
      if (this.state !== "idle" && this.state !== "done") { this.log("warn", "仅待机状态可执行手动调平"); return; }
      if (this.state === "done") {           // 清除上一件成品再校准
        this.printer.setGrownHeight(0);
        this.printer.showPart(false);
        this.progress = 0;
      }
      this.setState("level");
      this._setupLeveling();
      this.log("info", "自动调平开始：3×3 探测阵列");
    }

    _setupLeveling() {
      const pts = [];
      const half = Math.max(25, (this.printer.BED_SIZE || 256) / 2);
      const probeR = Math.max(20, half * 0.78);
      for (const y of [probeR, 0, -probeR]) for (const x of [-probeR, 0, probeR]) pts.push({ x, y });
      this._level = { pts, idx: -1, phase: "move", t: 0, samples: [], half, probeR };
      this.currentAction = "自动调平";
    }

    _finishLeveling() {
      // 9 个实测探测值（3×3）拟合当前机器构建平台的 5×5 补偿网格
      const S = this._level.samples;
      const half = this._level.half;
      const probeR = this._level.probeR;
      const probeAt = (x, y) => {
        const u = FXU.clamp((x + probeR) / probeR, 0, 2);   // 0..2 列
        const v = FXU.clamp((probeR - y) / probeR, 0, 2);   // 0..2 行
        const i0 = Math.min(1, Math.floor(u)), j0 = Math.min(1, Math.floor(v));
        const fx = u - i0, fy = v - j0;
        return FXU.lerp(
          FXU.lerp(S[j0 * 3 + i0], S[j0 * 3 + i0 + 1], fx),
          FXU.lerp(S[(j0 + 1) * 3 + i0], S[(j0 + 1) * 3 + i0 + 1], fx), fy);
      };
      const mesh = [];
      let mx = 0;
      for (let j = 0; j < 5; j++) {
        const row = [];
        for (let i = 0; i < 5; i++) {
          const v = probeAt(-half + i * half / 2, half - j * half / 2);
          row.push(v);
          if (Math.abs(v) > Math.abs(mx)) mx = v;
        }
        mesh.push(row);
      }
      this.levelMesh = { grid: mesh, max: mx, samples: S.slice(), half, at: new Date() };
      this.leveledOnce = true;
      this.bus.emit("levelmesh");
      this.log("ok", `调平完成：最大偏差 ${mx >= 0 ? "+" : ""}${mx.toFixed(3)} mm，9 点实测已拟合为 5×5 补偿网格`);
    }

    /* ── 时间与进度 ─────────────────────── */

    estimateTotal() {
      if (!this.slice) return 0;
      const f = this._slicedSpeed / Math.max(1, this.settings.speed);
      return this.slice.stats.timeSec * f + 95; // 预热 + 调平开销
    }
    estimateRemaining() {
      if (!this.slice) return 0;
      if (this.state === "idle") return this.estimateTotal();
      const f = this._slicedSpeed / Math.max(1, this.settings.speed);
      let done = this._doneTimeBefore;
      if (this._layer) done += this._layer.timeInLayer || 0;
      const heatLeft = this.state === "heat" ? 30 : 0;
      return Math.max(0, (this.slice.stats.timeSec - done) * f + heatLeft);
    }

    /* ── 主循环 ─────────────────────────── */

    tick(dt, _t) {   // _t：场景传入的累计时间，仿真核不需要（保留形参以对齐 onTick 签名）
      const P = this.printer;
      // 温度总是演化
      const nActual = this.nozzleT.step(dt * (this.state === "idle" ? 1 : this.simMult * 0.55));
      const bActual = this.bedT.step(dt * (this.state === "idle" ? 1 : this.simMult * 0.55));
      this.nozzleNow = nActual;
      this.bedNow = bActual;
      P.nozzleHotFrac = FXU.clamp((nActual - 40) / 220, 0, 1);
      P.bedHotFrac = FXU.clamp((bActual - 35) / 80, 0, 1);
      const fanEff = this.state === "print" && this.layerIdx < 2 ? 0 : this.settings.fanSpeed / 100;
      P.fanFrac = this.state === "print" || this.state === "pause" ? fanEff : 0;

      // 监测器：只观测真实物理量，不注入故障
      this._thermalWatch(dt);   // 温度失守（加热器老化 / 演练注入的失效都由它发现）
      this._mechWatch(dt);      // 热端阻力与送料打滑（堵料 / 断料的涌现路径）
      // 热失控保护动作：切断加热（固件保护行为）
      if (this.faultInfo && this.faultInfo.name.includes("热失控")) this.nozzleT.setTarget(26);

      // 床身平滑运动（打印中收敛更快并做微差吸附，保证沉积层顶面精确贴合喷嘴高度）
      const rate = this.state === "print" ? 16 : 6;
      let bedY = P.bedTopY + (this.bedTargetY - P.bedTopY) * (1 - Math.exp(-dt * rate));
      if (Math.abs(this.bedTargetY - bedY) < 0.05) bedY = this.bedTargetY;
      P.setBedTopY(bedY);

      if (this.state === "heat") this._tickHeat(dt);
      else if (this.state === "level") this._tickLevel(dt);
      else if (this.state === "print") this._tickPrint(dt);

      if (this.state === "heat" || this.state === "level" || this.state === "print")
        this.machineElapsed += dt * this.simMult;

      // 遥测采集：温度过程偏差 / 变速时间（打印态，按机时累计）
      if (this.state === "print" && this._telemetry) {
        const T = this._telemetry, mdt = dt * this.simMult;
        T.printTime += mdt;
        if (this.nozzleT.target > 100) {
          const dev = Math.abs(nActual - this.nozzleT.target);
          T.tempTime += mdt;
          T.tempDevSum += dev * mdt;
          if (dev > T.tempDevMax) T.tempDevMax = dev;
        }
        if (Math.abs(this.settings.speed - this._slicedSpeed) > 1) T.offSpeedTime += mdt;
      }

      P.extrudeRate = this.state === "print" && this._layer && this._layer.phase === "extrude"
        ? (this._layer.curSpeed || 0) : 0;
      P.setSpoolFrac((this.spoolTotalG - this.usedG) / this.spoolTotalG);
    }

    _tickHeat(dt) {
      const mdt = dt * this.simMult;
      this._heatMinTimer -= mdt;
      this._heatElapsed = (this._heatElapsed || 0) + mdt;
      // 归位动作
      this.headPos.x = FXU.lerp(this.headPos.x, -110, 1 - Math.exp(-dt * 2));
      this.headPos.y = FXU.lerp(this.headPos.y, 110, 1 - Math.exp(-dt * 2));
      this.printer.setHeadXY(this.headPos.x, this.headPos.y);
      this.currentAction = `预热中 · 喷嘴 ${this.nozzleNow.toFixed(0)}/${this.settings.nozzleTemp}°C`;

      // 加热失败保护（参考 Marlin "Heating failed"）：加热器功率不足时温度会
      // 停在稳态上限达不到目标，若不设超时预热会永远卡住。
      // 这是「加热器老化 → 跑不了高温材料」这条涌现路径的落地点。
      if (!this.faultInfo && this._heatElapsed > HEAT_TIMEOUT_S && !this.nozzleT.reached(3)) {
        const prof = this.machineProfile;
        this._raiseFault({
          name: "加热失败",
          msg: `预热 ${Math.round(this._heatElapsed)}s 后喷嘴仍停在 ${this.nozzleNow.toFixed(0)}°C，` +
            `达不到目标 ${this.settings.nozzleTemp}°C —— 加热器有效功率 ${(prof.heaterHealth * 100).toFixed(0)}%，` +
            `稳态上限约 ${FXMachineProfile.heaterCeilingC(prof, prof.ambientC).toFixed(0)}°C`,
        });
        return;
      }

      if (this._heatMinTimer <= 0 && this.nozzleT.reached(3) && this.bedT.reached(3)) {
        this.log("ok", `预热完成：喷嘴 ${this.nozzleNow.toFixed(1)}°C / 热床 ${this.bedNow.toFixed(1)}°C`);
        if (this.settings.autoLevel && !this.leveledOnce) {
          this.setState("level");
          this._setupLeveling();
          this.log("info", "打印前自动调平：3×3 探测阵列");
        } else {
          this._beginPrinting();
        }
      }
    }

    _tickLevel(dt) {
      const L = this._level;
      const mdt = dt * this.simMult;
      if (L.idx < 0) { L.idx = 0; L.phase = "move"; L.t = 0; this.bedTargetY = this.printer.NOZZLE_Y - 10; }
      const target = L.pts[L.idx];
      if (L.phase === "move") {
        const dx = target.x - this.headPos.x, dy = target.y - this.headPos.y;
        const d = Math.hypot(dx, dy);
        const step = 190 * mdt;
        if (d <= step) {
          this.headPos.x = target.x; this.headPos.y = target.y;
          L.phase = "probe"; L.t = 0;
        } else {
          this.headPos.x += (dx / d) * step;
          this.headPos.y += (dy / d) * step;
        }
      } else {
        L.t += mdt;
        // 探测下压动画（床身微升再落）
        const ph = Math.min(1, L.t / 0.9);
        const dip = Math.sin(ph * Math.PI) * 8.5;
        this.bedTargetY = this.printer.NOZZLE_Y - 10 + dip;
        if (L.t >= 0.95) {
          // 真实采样：床面误差场 + 探针读数噪声（±3µm），该值直接参与网格拟合
          // 探针重复性误差：确定性噪声（同一台机器同一点，每次探测结果一致），
          // 用 Math.random 会让调平数据链失去可复现性
          const z = this.bedErrorAt(target.x, target.y) + this._probeNoise(target.x, target.y);
          L.samples.push(z);
          this.log("info", `探测点 ${L.idx + 1}/9（X${target.x} Y${target.y}）：Z = ${z >= 0 ? "+" : ""}${z.toFixed(3)} mm`);
          L.idx++;
          if (L.idx >= L.pts.length) {
            this._finishLeveling();
            this.bedTargetY = this.printer.NOZZLE_Y - 30;
            // 由「打印前调平」进入打印；手动调平则回待机
            if (this.nozzleT.target > 100) this._beginPrinting();
            else { this.setState("idle"); this.currentAction = "待机"; }
            return;
          }
          L.phase = "move";
        }
      }
      this.printer.setHeadXY(this.headPos.x, this.headPos.y);
      this.currentAction = `自动调平 · ${Math.min(L.idx + 1, 9)}/9`;
    }

    _beginPrinting() {
      // 调平可能发生在预热之后（autoLevel），进入打印前刷新遥测中的调平快照
      if (this._telemetry) {
        this._telemetry.leveled = !!this.levelMesh;
        this._telemetry.levelMax = this.levelMesh ? this.levelMesh.max : null;
      }
      this.setState("print");
      this.layerIdx = 0;
      this._startLayer(0);
      this.log("ok", "开始逐层打印");
    }

    /** 调平网格 Z 补偿：首层全量、随高度线性衰减（真实固件 fade 行为） */
    _zCompAt(x, y, z) {
      const FADE_H = 6;
      if (!this.levelMesh || z >= FADE_H) return 0;
      return this.meshCompAt(x, y) * (1 - z / FADE_H);
    }

    _startLayer(idx) {
      const layer = this.slice.layers[idx];
      this.layerIdx = idx;
      this._layerBaseY = this.printer.NOZZLE_Y - layer.z - this.settings.zOffset;
      this.bedTargetY = this._layerBaseY - this._zCompAt(this.headPos.x, this.headPos.y, layer.z);
      const colors = {
        perimeter: this.partColor, solid: this.partColor,
        infill: this._dimColor(this.partColor, 0.82),
        skirt: this._dimColor(this.partColor, 0.6),
        support: 0x7d86a8,
      };
      const usable = layer.paths.filter((p) => p.pts.length >= 2 && p.len > 0.4);
      this.printer.beginLayer(usable, layer.z, this.settings.layerHeight, colors);
      this._layer = {
        idx, data: layer, paths: usable,
        pathIdx: -1, phase: "travel",
        travel: null, distInPath: 0, extAccum: 0, timeInLayer: 0, curSpeed: 0,
      };
      this._setupTravelTo(0);
      this.bus.emit("layer", { idx: idx + 1, total: this.slice.totalLayers, z: layer.z });
      if ((idx + 1) % 25 === 0 || idx === 0)
        this.log("info", `第 ${idx + 1}/${this.slice.totalLayers} 层 · Z=${layer.z.toFixed(2)} mm`);
    }

    _dimColor(hex, f) {
      const r = ((hex >> 16) & 255) * f, g = ((hex >> 8) & 255) * f, b = (hex & 255) * f;
      return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
    }

    _setupTravelTo(pathIdx) {
      const L = this._layer;
      if (pathIdx >= L.paths.length) { L.phase = "layerEnd"; return; }
      const dest = L.paths[pathIdx].pts[0];
      const from = { x: this.headPos.x, y: this.headPos.y };
      const len = Math.hypot(dest.x - from.x, dest.y - from.y);
      L.phase = "travel";
      L.travel = { from, to: dest, len, done: 0, nextPath: pathIdx };
      L.curSpeed = 0;
      this.currentAction = this.settings.retraction > 0.05 && len > 2 ? "空驶（回抽）" : "空驶";
    }

    _tickPrint(dt) {
      const L = this._layer;
      if (!L) return;
      let budget = dt * this.simMult;
      const speedFactor = this.settings.speed / Math.max(1, this._slicedSpeed);
      let guard = 400;

      while (budget > 1e-6 && guard-- > 0) {
        if (L.phase === "travel") {
          const v = this.settings.travelSpeed;
          const remain = L.travel.len - L.travel.done;
          const adv = Math.min(remain, v * budget);
          L.travel.done += adv;
          budget -= adv / v;
          L.timeInLayer += adv / v;
          const t = L.travel.len > 0 ? L.travel.done / L.travel.len : 1;
          this.headPos.x = FXU.lerp(L.travel.from.x, L.travel.to.x, t);
          this.headPos.y = FXU.lerp(L.travel.from.y, L.travel.to.y, t);
          if (L.travel.done >= L.travel.len - 1e-6) {
            L.pathIdx = L.travel.nextPath;
            L.phase = "extrude";
            L.distInPath = 0;
            const p = L.paths[L.pathIdx];
            this.currentAction = TYPE_LABEL[p.type] || "挤出";
          }
        } else if (L.phase === "extrude") {
          const p = L.paths[L.pathIdx];
          const v = p.speed * speedFactor;
          L.curSpeed = v;
          const remain = p.len - L.distInPath;
          const adv = Math.min(remain, v * budget);
          L.distInPath += adv;
          L.extAccum += adv;
          budget -= adv / v;
          L.timeInLayer += adv / p.speed;   // 以切片基准速度计时，保证进度与总估时一致
          this._consumeFilament(adv, p);
          const pos = this._pointAt(p, L.distInPath);
          this.headPos.x = pos.x; this.headPos.y = pos.y;
          if (L.distInPath >= p.len - 1e-6) this._setupTravelTo(L.pathIdx + 1);
        } else { // layerEnd
          L.timeInLayer += 1.1;
          this._completeLayer();
          break;    // 新层的管束已重建，本 tick 不再消费预算（故此处无需再扣 budget）
        }
      }
      // 注意：_completeLayer 可能已切换/清空当前层，必须取最新引用
      const CL = this._layer;
      if (!CL || this.state !== "print") return;
      this.printer.setHeadXY(this.headPos.x, this.headPos.y);
      this.printer.setLayerProgress(CL.extAccum);
      // 调平网格实时 Z 补偿：喷头移动时按当前位置微调「喷嘴-床面」间距（fade 高度内）
      if (this.levelMesh && CL.data.z < 6)
        this.bedTargetY = this._layerBaseY - this._zCompAt(this.headPos.x, this.headPos.y, CL.data.z);

      // 进度（按机时占比）
      const doneT = this._doneTimeBefore + CL.timeInLayer;
      this.progress = FXU.clamp(doneT / this.slice.stats.timeSec, 0, 1);
      const pct = Math.floor(this.progress * 10) * 10;
      if (pct >= this._milestone + 10 && pct < 100) {
        this._milestone = pct;
        this.log("info", `打印进度 ${pct}% · 剩余约 ${FXU.fmtHuman(this.estimateRemaining())}`);
      }
      // 耗材预警
      const remainG = this.spoolTotalG - this.usedG;
      if (remainG < 150 && this._lowMatWarned < 1) { this._lowMatWarned = 1; this.log("warn", "耗材余量低于 15%，请准备备用料盘"); }
      if (remainG <= 0.5 && !this.faultInfo) this.injectFault("runout");
    }

    _pointAt(path, dist) {
      if (!path._cum) {
        path._cum = [0];
        for (let i = 1; i < path.pts.length; i++) {
          const a = path.pts[i - 1], b = path.pts[i];
          path._cum.push(path._cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
        }
      }
      const cum = path._cum;
      if (dist <= 0) return path.pts[0];
      if (dist >= cum[cum.length - 1]) return path.pts[path.pts.length - 1];
      let lo = 0, hi = cum.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= dist) lo = mid; else hi = mid;
      }
      const segLen = cum[lo + 1] - cum[lo] || 1e-9;
      const t = (dist - cum[lo]) / segLen;
      const a = path.pts[lo], b = path.pts[lo + 1];
      return { x: FXU.lerp(a.x, b.x, t), y: FXU.lerp(a.y, b.y, t) };
    }

    _consumeFilament(extMm, path) {
      let filamentMm, mm3;
      if (this.importedToolpath && path && path.filamentMm > 0 && path.len > 0) {
        filamentMm = (extMm / path.len) * path.filamentMm;
        mm3 = filamentMm * (Math.PI * 0.875 * 0.875);
      } else {
        const area = this.settings.extrusionWidth * this.settings.layerHeight;
        mm3 = extMm * area;
        filamentMm = mm3 / (Math.PI * 0.875 * 0.875);
      }
      this.usedG += (mm3 / 1000) * this.material.densityG;
      this.usedLenMm += filamentMm;
    }

    _completeLayer() {
      const L = this._layer;
      this._doneExtBefore += L.extAccum;
      this._doneTimeBefore += L.timeInLayer;
      this.printer.endLayer();
      this.printer.setGrownHeight(L.data.z);
      const next = L.idx + 1;
      if (next >= this.slice.totalLayers) {
        this._finishPrint();
      } else {
        this._startLayer(next);
      }
    }

    _finishPrint() {
      this._layer = null;
      this.progress = 1;
      this.setState("done");
      this.currentAction = "打印完成";
      this.nozzleT.setTarget(26);
      this.bedT.setTarget(26);
      this.bedTargetY = this.printer.NOZZLE_Y - Math.max(120, this.slice.height + 40);
      this.log("ok", `打印完成：${this.model.name} · 用时 ${FXU.fmtHuman(this.machineElapsed)}（机时）· 耗材 ${(this.usedG - (this._telemetry ? this._telemetry.usedG0 : 0)).toFixed(1)} g`);
      if (this._telemetry) {
        this.lastQuality = FXSim.computeActualQuality(this._telemetry, this.settings, this.model, {
          elapsed: this.machineElapsed,
          usedG: this.usedG - this._telemetry.usedG0,
        });
        this.bus.emit("quality-actual", this.lastQuality);
        this.log("info", `成品实测质量评级 ${this.lastQuality.grade}（综合 ${this.lastQuality.score} 分）· 详见「质量」面板`);
      }

      // 成品判废：翘边与悬垂塌陷不是「打印中断」，而是机械上跑完了但零件报废——
      // 真实产线正是这样记录的。风险由本次打印的真实条件推出，不做概率抽样。
      const scrap = this._evaluateScrap();
      this.bus.emit("done");
      if (scrap) {
        this.log("err", `【成品判废】${scrap.reason} — ${scrap.msg}`);
        if (this._telemetry) this._telemetry.faults.push(scrap.reason);
        this.bus.emit("job-record", { status: "fail", fault: scrap.reason, scrap: scrap });
      } else {
        this.bus.emit("job-record", { status: "success", fault: null });
      }
    }

    /**
     * 打印完成时的成品判废评估（翘边 / 悬垂塌陷的涌现路径）。
     * 输入全部来自本次打印的真实条件：床温、环境、材料收缩率、首层面积与不均匀度、
     * 风扇、层高、速度、是否开支撑。返回 null 表示合格。
     */
    _evaluateScrap() {
      const T = this._telemetry;
      if (!T || !this.model) return null;
      const st = this.settings;
      const mat = this.material;
      const prof = this.machineProfile;

      const warp = FXMachineProfile.warpRisk(prof, {
        bedMinC: mat.bedMin,
        bedNow: T.settings0.bedTemp,          // 设定床温（打印全程维持）
        shrinkage: mat.shrinkage != null ? mat.shrinkage : (FXMachineProfile.SHRINKAGE[st.material] || 0.4),
        firstLayerAreaMm2: T.firstLayerAreaMm2,
        firstLayerUnevenMm: T.leveled ? Math.min(T.firstLayerUneven, 0.04) : T.firstLayerUneven,
        fanFrac: (T.settings0.fanSpeed || 0) / 100,
      });
      const overhang = FXMachineProfile.overhangRisk(prof, {
        needSupport: !!this.model.needSupport,
        supportEnabled: !!T.settings0.supportEnabled,
        fanFrac: (T.settings0.fanSpeed || 0) / 100,
        layerHeightMm: T.settings0.layerHeight,
        speedMmS: T.settings0.speed,
      });
      T.warpRisk = Math.round(warp * 100) / 100;
      T.overhangRisk = Math.round(overhang * 100) / 100;

      if (overhang >= 1 && overhang >= warp) {
        return {
          reason: "悬垂塌陷",
          risk: T.overhangRisk,
          msg: !T.settings0.supportEnabled
            ? "模型存在 >60° 悬垂面但未启用支撑，顶部结构无支承"
            : `支撑已开但冷却/层高/速度组合不足以成形桥接段（风险指数 ${T.overhangRisk}）`,
        };
      }
      if (warp >= 1) {
        return {
          reason: "翘边",
          risk: T.warpRisk,
          msg: `床温 ${T.settings0.bedTemp}°C（${st.material} 下限 ${mat.bedMin}°C）· ` +
            `环境 ${prof.ambientC}°C ${prof.enclosed ? "封闭" : "开放"}腔体 · 风扰 ${(prof.draft * 100).toFixed(0)}% · ` +
            `首层面积 ${Math.round(T.firstLayerAreaMm2)} mm²（风险指数 ${T.warpRisk}）`,
        };
      }
      return null;
    }
  }

  /* ── 质量推导（参数 → 风险评估，纯函数） ── */

  FXSim.computeQuality = function (st, model) {
    const m = MATERIALS[st.material];
    const out = [];
    const push = (name, score, tip) => {
      score = Math.round(FXU.clamp(score, 4, 99));
      out.push({ name, score, level: score >= 80 ? "good" : score >= 55 ? "mid" : "bad", tip });
    };

    // 层间结合强度
    let s = 100;
    const [tLo, tHi] = m.nozzleRange;
    const ideal = (tLo + tHi) / 2;
    if (st.nozzleTemp < tLo) s -= (tLo - st.nozzleTemp) * 3.2;
    if (st.nozzleTemp > tHi) s -= (st.nozzleTemp - tHi) * 2.0;
    s -= Math.max(0, st.speed - m.maxSpeed * 0.7) * 0.25;
    if (st.material === "ABS" && st.fanSpeed > 40) s -= (st.fanSpeed - 40) * 0.5;
    push("层间结合强度", s,
      st.nozzleTemp < tLo ? `喷嘴温度低于 ${m.name} 推荐区间（${tLo}–${tHi}°C），层间熔合不足` :
      st.nozzleTemp > tHi ? "温度偏高，边缘易塌陷、拉丝增多" : `温度处于 ${m.name} 理想窗口（理想值约 ${ideal}°C）`);

    // 首层附着 / 翘边
    s = 100;
    if (st.bedTemp < m.bedMin) s -= (m.bedMin - st.bedTemp) * 2.8;
    if (st.material === "ABS") s -= 6;
    s -= Math.max(0, st.speed - 150) * 0.1;
    if (st.skirtLoops < 1) s -= 8;
    push("首层附着可靠性", s,
      st.bedTemp < m.bedMin ? `热床低于 ${m.name} 最低要求 ${m.bedMin}°C，存在翘边风险` : "热床温度满足附着要求，封闭腔体进一步降低翘边概率");

    // 表面质量
    s = 100 - (st.layerHeight - 0.08) * 130;
    s -= Math.max(0, st.speed - 120) * 0.22;
    if (st.material === "PLA" && st.fanSpeed < 60) s -= (60 - st.fanSpeed) * 0.45;
    push("表面质量预估", s,
      st.layerHeight <= 0.12 ? "精细层高，表面纹理细腻" :
      st.layerHeight >= 0.28 ? "大层高追求效率，层纹明显" : "层高均衡，兼顾效率与观感");

    // 拉丝控制
    s = 100 - Math.abs(st.retraction - 1.2) * 26;
    if (st.nozzleTemp > ideal + 10) s -= (st.nozzleTemp - ideal - 10) * 1.4;
    if (st.material === "TPU" && st.retraction > 2) s = Math.min(s, 45);
    push("回抽与拉丝控制", s,
      st.retraction < 0.6 ? "回抽距离偏小，跨越空隙时易产生拉丝" :
      st.retraction > 2.4 ? "回抽过大，软料/高温料存在堵料风险" : "回抽参数处于直驱挤出机理想区间");

    // 尺寸精度
    s = 98 - Math.max(0, st.speed - 100) * 0.16 - (st.layerHeight > 0.24 ? 6 : 0);
    if (st.material === "ABS") s -= 5; // 收缩率
    push("尺寸精度预估", s, st.material === "ABS" ? "ABS 收缩率较高（约 0.6%），关键配合面建议预留补偿" : "冷却均匀，收缩可控");

    // 悬垂与支撑
    if (model && model.needSupport) {
      s = st.supportEnabled ? 92 : 22;
      push("悬垂结构成形", s, st.supportEnabled
        ? "检测到 >60° 悬垂面，支撑已启用，悬空区域可靠成形"
        : "检测到 >60° 悬垂面但未启用支撑，法兰区域将坍塌！");
    } else {
      push("悬垂结构成形", 95, "模型无显著悬垂面，免支撑打印");
    }
    return out;
  };

  /* ── 成品实测质量（打印过程遥测 → 实测报告，纯函数）
     与 computeQuality（打印前参数预估）互补：这里的每一分都来自本次打印真实采集的数据 ── */

  FXSim.computeActualQuality = function (tel, st, model, run) {
    const checks = [];
    const push = (name, score, tip) => {
      score = Math.round(FXU.clamp(score, 4, 99));
      checks.push({ name, score, level: score >= 80 ? "good" : score >= 55 ? "mid" : "bad", tip });
    };

    // 1. 温度过程稳定性（实测偏差积分）
    const devAvg = tel.tempTime > 0 ? tel.tempDevSum / tel.tempTime : 0;
    let s = 100 - devAvg * 14 - Math.max(0, tel.tempDevMax - 8) * 1.6;
    push("温度过程稳定性", s,
      `全程实测：平均偏差 ${devAvg.toFixed(2)}°C · 峰值偏差 ${tel.tempDevMax.toFixed(1)}°C` +
      (tel.tempDevMax > 12 ? "，存在明显温度扰动（故障或大幅调参）" : "，温控收敛良好"));

    // 2. 首层成形（调平补偿链实测）
    if (tel.leveled) {
      const mx = Math.abs(tel.levelMax || 0);
      s = 97 - Math.max(0, mx - 0.15) * 60;
      push("首层成形与调平", s,
        `已按 9 点实测网格补偿（床面最大偏差 ${tel.levelMax >= 0 ? "+" : ""}${(tel.levelMax || 0).toFixed(3)} mm）` +
        (mx > 0.15 ? "，床面偏差偏大，建议检查平台" : "，首层厚度均匀"));
    } else {
      s = 90 - tel.firstLayerUneven * 300;
      push("首层成形与调平", s,
        `未调平直接打印：接触区实测不均匀度 ${tel.firstLayerUneven.toFixed(3)} mm` +
        (tel.firstLayerUneven > 0.1 ? "，存在局部过压/脱粘风险，建议先运行自动调平" : "（本机床面较平整，侥幸过关）"));
    }

    // 3. 过程扰动（故障 / 暂停 / 调参实录）
    s = 98 - tel.faults.length * 25 - tel.pauses * 8 - tel.tunes * 4;
    const evts = [];
    if (tel.faults.length) evts.push(`故障 ${tel.faults.length} 次（${tel.faults.join("、")}）`);
    if (tel.pauses) evts.push(`人工暂停 ${tel.pauses} 次`);
    if (tel.tunes) evts.push(`打印中调参 ${tel.tunes} 次`);
    push("过程扰动与恢复", s, evts.length
      ? `本次实录：${evts.join("；")}——每次中断都会在表面留下接缝痕`
      : "全程无故障、无暂停、无中途调参，成形连续性最佳");

    // 4. 速度一致性（变速时间占比实测）
    const offFrac = tel.printTime > 0 ? tel.offSpeedTime / tel.printTime : 0;
    s = 98 - offFrac * 45;
    push("速度一致性", s, offFrac > 0.02
      ? `实测 ${(offFrac * 100).toFixed(0)}% 的打印时间偏离切片基准速度，挤出量波动会体现在侧壁纹理`
      : "全程按切片基准速度执行，挤出均匀");

    const score = Math.round(checks.reduce((a, q) => a + q.score, 0) / checks.length);
    const grade = score >= 90 ? "A" : score >= 78 ? "B" : score >= 60 ? "C" : "D";
    return {
      kind: "actual",
      score, grade, checks,
      elapsed: run ? run.elapsed : 0,
      usedG: run ? run.usedG : 0,
      at: new Date(),
      leveled: tel.leveled,
    };
  };

  FXSim.MATERIALS = MATERIALS;
  FXSim.COLORS = COLORS;
  root.FXSim = FXSim;
})(typeof window !== "undefined" ? window : globalThis);
