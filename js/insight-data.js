/* FORGE·X 智造洞察 — 数据层：示例生产数据生成 / CSV 解析与导出 / 模拟器运行数据采集
   字段模型见 doc/开发文档.md §6.1；金额以「分」为最小单位整数存储，展示层转元。
   纯逻辑（除 DOM 下载函数），node 可测。 */
(function (root) {
  "use strict";

  var D = {};

  /* ── 常量口径 ─────────────────────────────── */

  D.FIELDS = [
    "job_id", "date", "machine_id", "model_name", "material",
    "layer_height_mm", "duration_min", "filament_g", "cost_fen",
    "status", "fail_reason", "energy_kwh",
  ];

  /** 材料单价（分/kg）· 电价（分/kWh）· 机时折旧（分/小时）——演示口径 */
  D.PRICE = {
    material: { PLA: 6900, PETG: 8900, ABS: 7900, TPU: 15900 },
    powerFenPerKwh: 60,
    machineFenPerHour: 12,
  };

  D.MACHINES = ["FX-256-01", "FX-256-02", "FX-256-03", "FX-256-04"];
  D.FAIL_REASONS = ["翘边", "堵料", "断料", "热失控", "悬垂塌陷"];

  D.costFen = function (material, filamentG, energyKwh, durationMin) {
    var price = D.PRICE.material[material] || 8000;
    return Math.round(
      (filamentG / 1000) * price +
      energyKwh * D.PRICE.powerFenPerKwh +
      (durationMin / 60) * D.PRICE.machineFenPerHour
    );
  };

  /* ── 示例数据生成（确定性，种子固定） ───────── */

  /**
   * 生成三周 96 条真实感生产记录。内置「故事线」保证分析结论有意义：
   * - FX-256-03 故障率显著偏高（送料系统老化 → 堵料/断料多）
   * - ABS × 传感器支架（悬垂件）翘边/塌陷失败率高
   * - 层高越大时长越短、TPU 明显慢
   */
  D.generateSample = function (count) {
    var rnd = FXU.mulberry32(20260721);
    var n = count || 96;
    var rows = [];

    var models = [
      { name: "行星齿轮",   baseMin: 95,  baseG: 34, difficulty: 0.03 },
      { name: "涡轮叶轮",   baseMin: 150, baseG: 52, difficulty: 0.07 },
      { name: "传感器支架", baseMin: 120, baseG: 41, difficulty: 0.12 },
    ];
    var materials = ["PLA", "PLA", "PETG", "PETG", "ABS", "TPU"]; // 权重分布
    var layerHs = [0.12, 0.2, 0.2, 0.2, 0.28];
    var machineFailBase = { "FX-256-01": 0.04, "FX-256-02": 0.06, "FX-256-03": 0.2, "FX-256-04": 0.05 };
    var speedFactor = { PLA: 1, PETG: 1.18, ABS: 1.12, TPU: 2.1 };

    var startDay = Date.UTC(2026, 5, 29); // 2026-06-29，三周
    for (var i = 0; i < n; i++) {
      var machine = D.MACHINES[Math.floor(rnd() * 4)];
      var model = models[Math.floor(rnd() * models.length)];
      var material = materials[Math.floor(rnd() * materials.length)];
      var lh = layerHs[Math.floor(rnd() * layerHs.length)];

      var dayOff = Math.floor(rnd() * 21);
      var date = new Date(startDay + dayOff * 86400000);
      var dateStr = date.toISOString().slice(0, 10);

      // 失败概率：机台基线 + 模型难度 + 危险组合（ABS/PETG × 悬垂件）
      var pFail = machineFailBase[machine] + model.difficulty;
      var risky = model.name === "传感器支架" && (material === "ABS" || material === "PETG");
      if (risky) pFail += material === "ABS" ? 0.22 : 0.1;
      var failed = rnd() < pFail;

      var reason = "";
      if (failed) {
        var r = rnd();
        if (machine === "FX-256-03") reason = r < 0.42 ? "堵料" : r < 0.75 ? "断料" : "热失控";
        else if (risky) reason = r < 0.55 ? "翘边" : "悬垂塌陷";
        else reason = D.FAIL_REASONS[Math.floor(r * D.FAIL_REASONS.length)];
      }

      var lhFactor = 0.2 / lh;
      var dur = model.baseMin * lhFactor * speedFactor[material] * (0.9 + rnd() * 0.22);
      var g = model.baseG * (0.94 + rnd() * 0.14);
      if (failed) { var cut = 0.15 + rnd() * 0.6; dur *= cut; g *= cut; } // 中途失败
      dur = Math.round(dur);
      g = Math.round(g * 10) / 10;
      var kwh = Math.round((dur / 60) * (material === "ABS" ? 0.34 : 0.24) * 100) / 100;

      rows.push({
        job_id: "J202607-" + String(1000 + i + 1).slice(1),
        date: dateStr,
        machine_id: machine,
        model_name: model.name,
        material: material,
        layer_height_mm: lh,
        duration_min: dur,
        filament_g: g,
        cost_fen: D.costFen(material, g, kwh, dur),
        status: failed ? "fail" : "success",
        fail_reason: reason,
        energy_kwh: kwh,
      });
    }
    return rows;
  };

  /* ── CSV 解析 / 导出 ─────────────────────── */

  var HEADER_ALIAS = {
    job_id: ["job_id", "任务id", "任务编号", "job"],
    date: ["date", "日期", "打印日期"],
    machine_id: ["machine_id", "机台", "机台编号", "设备", "machine"],
    model_name: ["model_name", "模型", "模型名称", "model"],
    material: ["material", "材料", "耗材类型"],
    layer_height_mm: ["layer_height_mm", "层高", "layer_height"],
    duration_min: ["duration_min", "耗时", "时长", "duration", "耗时分钟"],
    filament_g: ["filament_g", "耗材克重", "耗材", "克重"],
    cost_fen: ["cost_fen", "成本分", "cost"],
    cost_cny: ["cost_cny", "成本", "成本元", "单件成本"],
    status: ["status", "状态", "结果"],
    fail_reason: ["fail_reason", "故障类型", "失败原因", "故障"],
    energy_kwh: ["energy_kwh", "能耗", "电量"],
  };
  var NUM_FIELDS = { layer_height_mm: 1, duration_min: 1, filament_g: 1, cost_fen: 1, energy_kwh: 1 };

  /** 单行 CSV 切分（支持双引号包裹与转义），无引号时按逗号直切 */
  D.splitCsvLine = function (line) {
    if (line.indexOf('"') < 0) return line.split(",");
    var out = [], cur = "", inQ = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };

  /**
   * 解析 CSV 文本 → { rows, errors[] }。表头中英文宽松匹配；
   * status 归一化为 success/fail；cost_cny（元）自动转 cost_fen（分）。
   */
  D.parseCsv = function (text) {
    var errors = [];
    var lines = String(text).replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).filter(function (l) { return l.trim() !== ""; });
    if (lines.length < 2) return { rows: [], errors: ["CSV 至少需要表头 + 1 行数据"] };

    var heads = D.splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
    var map = {};   // 列下标 → 标准字段
    for (var c = 0; c < heads.length; c++) {
      for (var field in HEADER_ALIAS) {
        if (HEADER_ALIAS[field].indexOf(heads[c]) >= 0) { map[c] = field; break; }
      }
    }
    var mapped = [];
    for (var mc in map) mapped.push(map[mc]);
    if (mapped.indexOf("status") < 0) errors.push("缺少必需列：status（状态）");
    if (mapped.indexOf("machine_id") < 0 && mapped.indexOf("material") < 0)
      errors.push("machine_id（机台）与 material（材料）至少需其一");
    if (errors.length) return { rows: [], errors: errors };

    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cells = D.splitCsvLine(lines[i]);
      var row = {};
      for (var ci = 0; ci < cells.length; ci++) {
        var f = map[ci];
        if (!f) continue;
        var v = cells[ci].trim();
        if (f === "cost_cny") { row.cost_fen = Math.round(parseFloat(v || "0") * 100) || 0; continue; }
        if (NUM_FIELDS[f]) { row[f] = parseFloat(v || "0") || 0; continue; }
        row[f] = v;
      }
      // 状态归一化
      var st = String(row.status || "").toLowerCase();
      row.status = (st === "fail" || st === "failed" || st === "失败" || st === "故障") ? "fail" : "success";
      if (row.status !== "fail") row.fail_reason = "";
      rows.push(row);
    }
    if (rows.length > 5000) { rows = rows.slice(0, 5000); errors.push("数据超过 5000 行，已截取前 5000 行"); }
    return { rows: rows, errors: errors };
  };

  /** rows → CSV 文本（标准字段序） */
  D.toCsv = function (rows) {
    var esc = function (v) {
      var s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [D.FIELDS.join(",")];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], line = [];
      for (var f = 0; f < D.FIELDS.length; f++) line.push(esc(r[D.FIELDS[f]]));
      out.push(line.join(","));
    }
    return out.join("\n");
  };

  /* ── 数据集管理（浏览器态） ───────────────── */

  /**
   * 三个数据集槽位：sample（内置示例）/ upload（用户 CSV）/ sim（模拟器采集）。
   * bus 事件：insight-data（数据集变更）。
   */
  D.Store = function (bus) {
    this.bus = bus;
    this.sets = {
      sample: { label: "示例数据", rows: D.generateSample() },
      upload: { label: "我的上传", rows: [] },
      sim:    { label: "模拟采集", rows: [] },
    };
    this.active = "sample";
  };
  D.Store.prototype.rows = function () { return this.sets[this.active].rows; };
  D.Store.prototype.use = function (key) {
    if (!this.sets[key]) return;
    this.active = key;
    if (this.bus) this.bus.emit("insight-data", { set: key });
  };
  D.Store.prototype.setUpload = function (rows) {
    this.sets.upload.rows = rows;
    this.active = "upload";
    if (this.bus) this.bus.emit("insight-data", { set: "upload" });
  };
  D.Store.prototype.addSimRecord = function (rec) {
    this.sets.sim.rows.push(rec);
    if (this.bus) this.bus.emit("insight-data", { set: "sim", appended: true });
  };

  /** 由模拟器状态构造一条生产记录（sim 完成/中止/故障时调用） */
  D.recordFromSim = function (sim, status, failReason) {
    var mat = sim.settings.material;
    var dur = Math.round(sim.machineElapsed / 60) || 1;   // 机时（分钟）
    var g = Math.round(sim.usedG * 10) / 10;
    var kwh = Math.round((dur / 60) * (mat === "ABS" ? 0.34 : 0.24) * 100) / 100;
    return {
      job_id: "SIM-" + String(Date.now()).slice(-6),
      date: new Date().toISOString().slice(0, 10),
      machine_id: "FX-256-01",
      model_name: sim.model ? sim.model.name : "未知模型",
      material: mat,
      layer_height_mm: sim.settings.layerHeight,
      duration_min: dur,
      filament_g: g,
      cost_fen: D.costFen(mat, g, kwh, dur),
      status: status,
      fail_reason: failReason || "",
      energy_kwh: kwh,
    };
  };

  /** 浏览器下载 CSV（data URI，file:// 直开可用） */
  D.downloadCsv = function (rows, filename) {
    var a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8,\uFEFF" + encodeURIComponent(D.toCsv(rows));
    a.download = filename || "print_jobs.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  root.FXInsightData = D;
})(typeof window !== "undefined" ? window : globalThis);
