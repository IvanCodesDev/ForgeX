/* FORGE·X — 打印时间校准（纯逻辑，浏览器与 Node 共用）
 *
 * 输入是至少三组“G-code 匀速估算 + 同一任务真机时长”，输出：
 *   actualSec = fixedOverheadSec + motionScale × plannedSec
 *
 * 使用 Theil–Sen 中位斜率而不是普通最小二乘，降低单个暂停、换料或日志异常
 * 对模型的破坏。校准结果仍然只对采样机型、固件和工艺范围负责；模块不会把
 * 合成兼容性夹具训练出的模型自动应用到用户任务。
 */
(function (root) {
  "use strict";

  var C = {};
  C.MIN_SAMPLES = 3;

  function finite(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function normalize(samples) {
    if (!Array.isArray(samples)) throw new Error("校准样本必须是数组");
    return samples.map(function (sample, i) {
      var planned = finite(sample && (sample.plannedTimeSec != null ? sample.plannedTimeSec : sample.plannedSec));
      var actual = finite(sample && (sample.actualTimeSec != null ? sample.actualTimeSec : sample.actualSec));
      if (planned == null || planned <= 0 || actual == null || actual <= 0)
        throw new Error("校准样本 " + (i + 1) + " 缺少正数 plannedTimeSec / actualTimeSec");
      return {
        id: String(sample.id || "sample-" + (i + 1)),
        plannedTimeSec: planned,
        actualTimeSec: actual,
        machineId: sample.machineId ? String(sample.machineId) : "",
        firmware: sample.firmware ? String(sample.firmware) : "",
      };
    });
  }

  function fitLine(rows) {
    if (rows.length < C.MIN_SAMPLES)
      throw new Error("至少需要 " + C.MIN_SAMPLES + " 个配对任务才能校准时间模型");
    var distinct = {};
    rows.forEach(function (row) { distinct[row.plannedTimeSec] = true; });
    if (Object.keys(distinct).length < C.MIN_SAMPLES)
      throw new Error("校准样本至少需要 " + C.MIN_SAMPLES + " 个不同的计划时长");

    var slopes = [];
    for (var i = 0; i < rows.length; i++) {
      for (var j = i + 1; j < rows.length; j++) {
        var dx = rows[j].plannedTimeSec - rows[i].plannedTimeSec;
        if (Math.abs(dx) > 1e-9)
          slopes.push((rows[j].actualTimeSec - rows[i].actualTimeSec) / dx);
      }
    }
    var slope = median(slopes);
    if (slope == null || !isFinite(slope) || slope <= 0)
      throw new Error("校准样本无法得到正数时间倍率");
    var intercept = median(rows.map(function (row) {
      return row.actualTimeSec - slope * row.plannedTimeSec;
    }));

    // 负固定开销没有物理意义。约束到 0 后，用中位倍率重新估计剩余项。
    if (intercept < 0) {
      intercept = 0;
      slope = median(rows.map(function (row) {
        return row.actualTimeSec / row.plannedTimeSec;
      }));
    }
    return { motionScale: slope, fixedOverheadSec: intercept };
  }

  function metrics(rows, predict) {
    var abs = [];
    var ape = [];
    var sq = [];
    var mean = rows.reduce(function (sum, row) { return sum + row.actualTimeSec; }, 0) / rows.length;
    var ssRes = 0;
    var ssTot = 0;
    rows.forEach(function (row) {
      var predicted = row.predictedTimeSec != null
        ? row.predictedTimeSec
        : predict(row.plannedTimeSec);
      var err = predicted - row.actualTimeSec;
      abs.push(Math.abs(err));
      ape.push(Math.abs(err) / row.actualTimeSec);
      sq.push(err * err);
      ssRes += err * err;
      ssTot += Math.pow(row.actualTimeSec - mean, 2);
    });
    return {
      sampleCount: rows.length,
      maeSec: abs.reduce(function (a, b) { return a + b; }, 0) / rows.length,
      mape: ape.reduce(function (a, b) { return a + b; }, 0) / rows.length,
      rmseSec: Math.sqrt(sq.reduce(function (a, b) { return a + b; }, 0) / rows.length),
      maxApe: Math.max.apply(Math, ape),
      r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
    };
  }

  C.predict = function (model, plannedTimeSec) {
    var planned = finite(plannedTimeSec);
    if (!model || planned == null || planned < 0) throw new Error("需要有效校准模型与计划时长");
    return Math.max(0, Number(model.fixedOverheadSec) + Number(model.motionScale) * planned);
  };

  C.evaluate = function (model, samples) {
    var rows = normalize(samples);
    if (!rows.length) throw new Error("评估样本不能为空");
    return metrics(rows, function (planned) { return C.predict(model, planned); });
  };

  C.fit = function (samples, opt) {
    opt = opt || {};
    var rows = normalize(samples);
    var line = fitLine(rows);
    var model = {
      format: "forgex-time-calibration",
      version: 1,
      method: "theil-sen",
      scope: {
        machineId: String(opt.machineId || ""),
        firmware: String(opt.firmware || ""),
      },
      sampleCount: rows.length,
      motionScale: line.motionScale,
      fixedOverheadSec: line.fixedOverheadSec,
    };
    model.trainingMetrics = C.evaluate(model, rows);

    if (rows.length >= 4) {
      var predictions = [];
      for (var i = 0; i < rows.length; i++) {
        var training = rows.filter(function (_row, idx) { return idx !== i; });
        var fold = fitLine(training);
        predictions.push({
          id: rows[i].id,
          plannedTimeSec: rows[i].plannedTimeSec,
          actualTimeSec: rows[i].actualTimeSec,
          predictedTimeSec: Math.max(
            0,
            fold.fixedOverheadSec + fold.motionScale * rows[i].plannedTimeSec
          ),
        });
      }
      model.crossValidation = metrics(predictions, null);
    } else {
      model.crossValidation = null;
    }
    return model;
  };

  C.fromPair = function (gcode, log, meta) {
    if (!gcode || !gcode.stats || !log)
      throw new Error("需要 G-code 解析结果与对应真机日志");
    if (!(gcode.stats.timeSec > 0) || !(log.actualTimeSec > 0))
      throw new Error("配对任务缺少有效计划时长或实测时长");
    meta = meta || {};
    return {
      id: String(meta.id || log.name || "paired-job"),
      plannedTimeSec: gcode.stats.timeSec,
      actualTimeSec: log.actualTimeSec,
      machineId: String(meta.machineId || log.machineId || ""),
      firmware: String(meta.firmware || log.firmware || ""),
    };
  };

  C.observation = function (gcode, log) {
    var row = C.fromPair(gcode, log);
    return {
      plannedTimeSec: row.plannedTimeSec,
      actualTimeSec: row.actualTimeSec,
      deltaSec: row.actualTimeSec - row.plannedTimeSec,
      rawRatio: row.actualTimeSec / row.plannedTimeSec,
      eligibleForCalibration: true,
      note: "单个任务只能形成观测倍率；至少三个不同时长的配对任务才能拟合固定开销与运动倍率。",
    };
  };

  /**
   * 用后续生产观测检查已发布模型是否漂移。
   * 少于 minSamples 只返回 insufficient，不用一两次偶然暂停宣布模型失效。
   */
  C.detectDrift = function (model, samples, opt) {
    opt = opt || {};
    var rows = normalize(samples);
    var minSamples = Math.max(3, Math.floor(finite(opt.minSamples) || 5));
    var maxMape = finite(opt.maxMape);
    var maxBias = finite(opt.maxBias);
    if (maxMape == null) maxMape = 0.2;
    if (maxBias == null) maxBias = 0.12;
    if (rows.length < minSamples) {
      return {
        status: "insufficient",
        sampleCount: rows.length,
        requiredSamples: minSamples,
        medianApe: null,
        medianBias: null,
        p90Ape: null,
        note: "观测不足，继续收集同一机型与固件的配对任务。",
      };
    }

    var signed = [];
    var absolute = [];
    rows.forEach(function (row) {
      var predicted = C.predict(model, row.plannedTimeSec);
      var err = predicted > 0 ? (row.actualTimeSec - predicted) / predicted : 0;
      signed.push(err);
      absolute.push(Math.abs(err));
    });
    var sortedAbs = absolute.slice().sort(function (a, b) { return a - b; });
    var p90Index = Math.min(sortedAbs.length - 1, Math.ceil(sortedAbs.length * 0.9) - 1);
    var medianApe = median(absolute);
    var medianBias = median(signed);
    var warning = medianApe > maxMape * 0.8 || Math.abs(medianBias) > maxBias * 0.8;
    var drift = medianApe > maxMape || Math.abs(medianBias) > maxBias;
    return {
      status: drift ? "drift" : warning ? "warning" : "stable",
      sampleCount: rows.length,
      requiredSamples: minSamples,
      medianApe: medianApe,
      medianBias: medianBias,
      p90Ape: sortedAbs[p90Index],
      thresholds: { maxMape: maxMape, maxBias: maxBias },
      note: drift
        ? "后续观测已超过模型阈值，应停止自动应用并重新审查训练集。"
        : warning
          ? "误差接近阈值，建议增加 holdout 并检查固件或工艺变更。"
          : "后续观测仍在声明阈值内。",
    };
  };

  root.FXTimeCalibration = C;
})(typeof window !== "undefined" ? window : globalThis);
