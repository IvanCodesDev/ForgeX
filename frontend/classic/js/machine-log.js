/* FORGE·X — 真机任务日志解析与 G-code 计划/实测对比（纯逻辑）
 *
 * 支持：
 *   1. forgex-machine-log v1 JSON（完整契约见 contracts/logs/machine-log.schema.json）；
 *   2. 常见列名的 CSV 遥测：time_s / nozzle_c / bed_c，并可附带任务汇总字段。
 *
 * 这里只做数据归一和差异计算，不把运动时间估算包装成真值。
 */
(function (root) {
  "use strict";

  var L = {};
  L.MAX_BYTES = 20 * 1024 * 1024;
  L.MAX_ROWS = 1000000;

  function finite(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function firstFinite() {
    for (var i = 0; i < arguments.length; i++) {
      var n = finite(arguments[i]);
      if (n != null) return n;
    }
    return null;
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] != null && String(arguments[i]).trim()) return String(arguments[i]).trim();
    }
    return "";
  }

  function csvRows(text) {
    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        if (row.some(function (x) { return x.trim(); })) rows.push(row);
        row = [];
        field = "";
        if (rows.length > L.MAX_ROWS) throw new Error("真机日志行数超过上限");
      } else {
        field += ch;
      }
    }
    row.push(field);
    if (row.some(function (x) { return x.trim(); })) rows.push(row);
    return rows;
  }

  function key(v) {
    return String(v || "").trim().toLowerCase().replace(/[\s.-]+/g, "_");
  }

  function at(obj, names) {
    for (var i = 0; i < names.length; i++) {
      if (obj[names[i]] != null && obj[names[i]] !== "") return obj[names[i]];
    }
    return null;
  }

  function normalizeSample(raw) {
    return {
      timeSec: firstFinite(
        at(raw, ["timeSec", "time_s", "elapsed_s", "elapsedSec", "timestamp_sec", "timestamp_s"])
      ),
      nozzleC: firstFinite(at(raw, ["nozzleC", "nozzle_c", "hotend_c", "tool0_c", "extruder_c"])),
      bedC: firstFinite(at(raw, ["bedC", "bed_c", "bed_temp_c"])),
    };
  }

  function durationFromSamples(samples) {
    var times = samples.map(function (s) { return s.timeSec; }).filter(function (v) { return v != null; });
    if (!times.length) return null;
    return Math.max.apply(Math, times) - Math.min.apply(Math, times);
  }

  function normalize(data, name) {
    var job = data.job || data.summary || data;
    var rawSamples = data.telemetry || data.samples || [];
    var samples = Array.isArray(rawSamples) ? rawSamples.map(normalizeSample) : [];
    var duration = firstFinite(
      job.durationSec, job.duration_s, job.elapsedSec, job.elapsed_s,
      job.durationMin != null ? Number(job.durationMin) * 60 : null,
      job.duration_min != null ? Number(job.duration_min) * 60 : null
    );
    if (duration == null) duration = durationFromSamples(samples);
    var result = {
      name: name || firstText(data.id, job.jobId, job.job_id, "machine-log"),
      format: data.format || "generic-machine-log",
      jobId: firstText(job.jobId, job.job_id),
      machineId: firstText(job.machineId, job.machine_id),
      firmware: firstText(job.firmware, data.firmware),
      slicer: firstText(job.slicer, data.slicer),
      gcodeSha256: firstText(job.gcodeSha256, job.gcode_sha256).toLowerCase(),
      actualTimeSec: duration,
      filamentMm: firstFinite(job.filamentMm, job.filament_mm),
      filamentG: firstFinite(job.filamentG, job.filament_g),
      completedLayers: firstFinite(job.completedLayers, job.completed_layers, job.layers),
      status: firstText(job.status, data.status, "unknown"),
      samples: samples,
      warnings: [],
      source: "machine-log",
    };
    if (result.actualTimeSec == null) result.warnings.push("日志没有任务时长，无法比较打印时间");
    if (result.filamentMm == null && result.filamentG == null)
      result.warnings.push("日志没有耗材汇总，无法比较用料");
    if (!samples.length) result.warnings.push("日志没有温度遥测样本");
    return result;
  }

  function parseCsv(text, name) {
    var rows = csvRows(text);
    if (rows.length < 2) throw new Error("CSV 真机日志至少需要表头和一行数据");
    var headers = rows[0].map(key);
    var objects = rows.slice(1).map(function (cells) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = cells[i] == null ? "" : cells[i].trim(); });
      return obj;
    });
    var samples = objects.map(normalizeSample);
    var last = objects[objects.length - 1];
    var declaredDigests = [];
    objects.forEach(function (obj) {
      var declared = firstText(at(obj, ["gcode_sha256", "gcode_sha", "gcode_hash"])).toLowerCase();
      if (declared && declaredDigests.indexOf(declared) < 0) declaredDigests.push(declared);
    });
    if (declaredDigests.length > 1)
      throw new Error("CSV 真机日志中的 gcode_sha256 在不同行之间不一致");
    return normalize({
      format: "generic-machine-log-csv",
      job: {
        job_id: at(last, ["job_id", "job"]),
        machine_id: at(last, ["machine_id", "machine", "device_id"]),
        firmware: at(last, ["firmware", "firmware_version"]),
        slicer: at(last, ["slicer", "slicer_version"]),
        gcode_sha256: declaredDigests[0] || "",
        duration_s: at(last, ["duration_s", "duration_sec", "elapsed_s", "time_s"]),
        filament_mm: at(last, ["filament_mm", "filament_used_mm"]),
        filament_g: at(last, ["filament_g", "filament_used_g"]),
        completed_layers: at(last, ["completed_layers", "layer", "layers"]),
        status: at(last, ["status", "state", "result"]),
      },
      samples: samples,
    }, name);
  }

  L.parse = function (text, opt) {
    opt = opt || {};
    var src = String(text || "");
    if (!src.trim()) throw new Error("真机日志为空");
    if (src.length > L.MAX_BYTES)
      throw new Error("真机日志超过 " + Math.round(L.MAX_BYTES / 1024 / 1024) + "MB");
    var name = opt.name || "machine-log";
    var first = src.replace(/^\uFEFF/, "").trim()[0];
    if (first === "{" || first === "[") {
      var data;
      try {
        data = JSON.parse(src);
      } catch (e) {
        var parseError = new Error("真机日志 JSON 无效：" + e.message);
        parseError.cause = e;
        throw parseError;
      }
      if (Array.isArray(data)) data = { samples: data };
      if (!data || typeof data !== "object") throw new Error("真机日志 JSON 必须是对象");
      if (data.format && data.format !== "forgex-machine-log")
        throw new Error("不支持的真机日志 format：" + data.format);
      if (data.version != null && data.version !== 1) throw new Error("不支持的真机日志 version");
      return normalize(data, name);
    }
    return parseCsv(src, name);
  };

  /** 核对当前导入 G-code 的原始字节摘要与真机日志声明。 */
  L.verifyGcodeBinding = function (gcode, log) {
    var expected = String(log && log.gcodeSha256 || "").trim().toLowerCase();
    var actual = String(gcode && gcode.sha256 || "").trim().toLowerCase();
    if (!expected) {
      return { verified: false, status: "missing", expected: "", actual: actual,
        message: "真机日志未声明 gcodeSha256，本次对账未建立文件级绑定" };
    }
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      return { verified: false, status: "invalid", expected: expected, actual: actual,
        message: "真机日志中的 gcodeSha256 格式无效" };
    }
    if (!/^[a-f0-9]{64}$/.test(actual)) {
      return { verified: false, status: "unavailable", expected: expected, actual: actual,
        message: "当前 G-code 尚未完成 SHA-256 计算" };
    }
    if (expected !== actual) {
      return { verified: false, status: "mismatch", expected: expected, actual: actual,
        message: "真机日志绑定的 G-code SHA-256 与当前文件不匹配" };
    }
    return { verified: true, status: "verified", expected: expected, actual: actual,
      message: "真机日志与当前 G-code 的 SHA-256 已验证一致" };
  };

  function comparison(name, planned, actual, unit, tolerance, note) {
    var rel = planned > 0 ? Math.abs(actual - planned) / planned : 0;
    return {
      name: name,
      planned: planned,
      actual: actual,
      unit: unit,
      relDiff: rel,
      agrees: rel <= tolerance,
      note: note,
    };
  }

  L.compare = function (gcode, log) {
    if (!gcode || !gcode.stats || !log) throw new Error("需要 G-code 解析结果与真机日志");
    var out = [];
    if (log.actualTimeSec != null)
      out.push(comparison(
        "任务时长", gcode.stats.timeSec, log.actualTimeSec, "秒", 0.15,
        "G-code 侧是匀速运动估算；真机包含加速度、预热、换层、暂停与固件宏"
      ));
    if (log.filamentMm != null)
      out.push(comparison(
        "耗材长度", gcode.stats.filamentM * 1000, log.filamentMm, "mm", 0.05,
        "计划值来自 G-code E 增量；实测值取自日志，传感器或固件口径可能不同"
      ));
    if (log.filamentG != null)
      out.push(comparison(
        "耗材克重", gcode.stats.filamentG, log.filamentG, "g", 0.08,
        "两侧材料密度或称量方式不同会直接造成偏差"
      ));
    if (log.completedLayers != null)
      out.push(comparison(
        "完成层数", gcode.totalLayers, log.completedLayers, "层", 0,
        "层数不足通常表示任务中止；日志层号起点不同也可能产生 1 层偏差"
      ));
    return out;
  };

  root.FXMachineLog = L;
})(typeof window !== "undefined" ? window : globalThis);
