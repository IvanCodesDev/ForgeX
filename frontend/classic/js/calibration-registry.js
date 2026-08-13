/* FORGE·X — 版本化时间校准包注册表（声明式 JSON，不执行社区代码）
 *
 * 只有满足真实来源 + holdout 门槛的 active 模型会被自动匹配。
 * synthetic-conformance 只能以 demonstration-only 导入，默认永不参与用户估算。
 */
(function (root) {
  "use strict";

  var R = {};
  var STORAGE_KEY = "forgex-calibration-bundles-v1";
  var MAX_BYTES = 2 * 1024 * 1024;
  var MAX_OBSERVATIONS = 50;
  var bundles = [];
  var models = [];
  var observations = {};

  R.MAX_BYTES = MAX_BYTES;

  function text(v) {
    return typeof v === "string" ? v.trim() : "";
  }
  function finite(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function ownKeys(obj, allowed, at, errors) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      errors.push(at + " 必须是对象");
      return false;
    }
    Object.keys(obj).forEach(function (key) {
      if (allowed.indexOf(key) < 0) errors.push(at + " 含未知字段 " + key);
    });
    return true;
  }
  function idOk(v) {
    return /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(text(v));
  }
  function dateOk(v) {
    return text(v) && isFinite(Date.parse(v));
  }
  function inRange(v, min, max) {
    var n = finite(v);
    return n != null && n >= min && n <= max;
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }
  function provenanceReal(v) {
    return v === "real-anonymized" || v === "real-consented";
  }
  function key(v) {
    return text(v).toLowerCase();
  }

  R.validateBundle = function (raw) {
    var errors = [];
    if (!ownKeys(
      raw,
      ["$schema", "format", "version", "id", "revision", "createdAt", "provenance", "source", "models"],
      "bundle",
      errors
    )) return { ok: false, errors: errors };
    if (raw.format !== "forgex-calibration-bundle") errors.push("format 必须是 forgex-calibration-bundle");
    if (raw.version !== 1) errors.push("version 必须是 1");
    if (!idOk(raw.id)) errors.push("bundle.id 格式无效");
    if (!Number.isInteger(raw.revision) || raw.revision < 1) errors.push("revision 必须是正整数");
    if (!dateOk(raw.createdAt)) errors.push("createdAt 必须是 ISO 日期");
    if (["synthetic-conformance", "real-anonymized", "real-consented"].indexOf(raw.provenance) < 0)
      errors.push("provenance 不受支持");
    if (ownKeys(raw.source, ["license", "note"], "source", errors)) {
      if (!text(raw.source.license)) errors.push("source.license 必填");
      if (text(raw.source.note).length < 20) errors.push("source.note 至少 20 个字符");
    }
    if (!Array.isArray(raw.models) || !raw.models.length) {
      errors.push("models 至少需要一项");
      return { ok: false, errors: errors };
    }

    var ids = {};
    raw.models.forEach(function (model, i) {
      var at = "models[" + i + "]";
      if (!ownKeys(
        model,
        ["id", "status", "scope", "algorithm", "trainedAt", "coefficients", "validation", "thresholds", "trainingSetSha256"],
        at,
        errors
      )) return;
      if (!idOk(model.id)) errors.push(at + ".id 格式无效");
      if (ids[model.id]) errors.push(at + ".id 重复");
      ids[model.id] = true;
      if (["candidate", "active", "retired", "demonstration-only"].indexOf(model.status) < 0)
        errors.push(at + ".status 不受支持");
      if (model.algorithm !== "theil-sen") errors.push(at + ".algorithm 仅支持 theil-sen");
      if (!dateOk(model.trainedAt)) errors.push(at + ".trainedAt 必须是 ISO 日期");
      if (!/^[a-f0-9]{64}$/.test(text(model.trainingSetSha256)))
        errors.push(at + ".trainingSetSha256 必须是 SHA-256");

      if (ownKeys(model.scope, ["machineId", "firmware", "material"], at + ".scope", errors)) {
        if (!text(model.scope.machineId)) errors.push(at + ".scope.machineId 必填");
        if (!text(model.scope.firmware)) errors.push(at + ".scope.firmware 必填");
        if (model.scope.material != null && !text(model.scope.material))
          errors.push(at + ".scope.material 不能为空");
      }
      if (ownKeys(
        model.coefficients,
        ["motionScale", "fixedOverheadSec", "sampleCount"],
        at + ".coefficients",
        errors
      )) {
        if (!inRange(model.coefficients.motionScale, 0.1, 10))
          errors.push(at + ".coefficients.motionScale 超出 0.1–10");
        if (!inRange(model.coefficients.fixedOverheadSec, 0, 7200))
          errors.push(at + ".coefficients.fixedOverheadSec 超出 0–7200");
        if (!Number.isInteger(model.coefficients.sampleCount) || model.coefficients.sampleCount < 3)
          errors.push(at + ".coefficients.sampleCount 至少为 3");
      }
      if (ownKeys(
        model.validation,
        ["holdoutSamples", "mape", "maxApe", "medianBias", "evaluatedAt"],
        at + ".validation",
        errors
      )) {
        if (!Number.isInteger(model.validation.holdoutSamples) || model.validation.holdoutSamples < 0)
          errors.push(at + ".validation.holdoutSamples 必须是非负整数");
        if (!inRange(model.validation.mape, 0, 1)) errors.push(at + ".validation.mape 超出 0–1");
        if (!inRange(model.validation.maxApe, 0, 5)) errors.push(at + ".validation.maxApe 超出 0–5");
        if (!inRange(model.validation.medianBias, -1, 1))
          errors.push(at + ".validation.medianBias 超出 -1–1");
        if (!dateOk(model.validation.evaluatedAt))
          errors.push(at + ".validation.evaluatedAt 必须是 ISO 日期");
      }
      if (ownKeys(model.thresholds, ["maxMape", "maxBias", "minDriftSamples"], at + ".thresholds", errors)) {
        if (!inRange(model.thresholds.maxMape, 0.01, 0.5))
          errors.push(at + ".thresholds.maxMape 超出 0.01–0.5");
        if (!inRange(model.thresholds.maxBias, 0.01, 0.5))
          errors.push(at + ".thresholds.maxBias 超出 0.01–0.5");
        if (!Number.isInteger(model.thresholds.minDriftSamples) || model.thresholds.minDriftSamples < 3)
          errors.push(at + ".thresholds.minDriftSamples 至少为 3");
      }

      if (model.status === "active") {
        if (!provenanceReal(raw.provenance)) errors.push(at + " active 模型必须来自真实数据");
        if (model.validation && model.validation.holdoutSamples < 5)
          errors.push(at + " active 模型至少需要 5 个 holdout");
        if (
          model.validation &&
          model.thresholds &&
          (model.validation.mape > model.thresholds.maxMape ||
            Math.abs(model.validation.medianBias) > model.thresholds.maxBias)
        ) errors.push(at + " holdout 指标未通过启用阈值");
      }
      if (model.status === "demonstration-only" && raw.provenance !== "synthetic-conformance")
        errors.push(at + " demonstration-only 必须使用 synthetic-conformance");
      if (raw.provenance === "synthetic-conformance" && model.status !== "demonstration-only")
        errors.push(at + " 合成校准只能是 demonstration-only");
    });
    return { ok: errors.length === 0, errors: errors };
  };

  function rebuild() {
    models = [];
    bundles.forEach(function (bundle) {
      bundle.models.forEach(function (model) {
        var item = clone(model);
        item.bundleId = bundle.id;
        item.bundleRevision = bundle.revision;
        item.provenance = bundle.provenance;
        item.source = clone(bundle.source);
        models.push(item);
      });
    });
  }

  function save() {
    if (!root.localStorage) return;
    try {
      root.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ bundles: bundles, observations: observations })
      );
    } catch (e) {
      // 隐私模式或配额不足时保持当前会话可用。
    }
  }

  R.reload = function () {
    bundles = [];
    observations = {};
    if (root.localStorage) {
      try {
        var saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || "{}");
        if (Array.isArray(saved.bundles)) {
          saved.bundles.forEach(function (bundle) {
            if (R.validateBundle(bundle).ok) bundles.push(bundle);
          });
        }
        if (saved.observations && typeof saved.observations === "object")
          observations = saved.observations;
      } catch (e) {
        bundles = [];
        observations = {};
      }
    }
    rebuild();
    return R.list();
  };

  R.importBundle = function (raw) {
    var size = JSON.stringify(raw || {}).length;
    if (size > MAX_BYTES) throw new Error("校准包超过 2MB");
    var checked = R.validateBundle(raw);
    if (!checked.ok) throw new Error(checked.errors.join("；"));
    var next = clone(raw);
    var existingIndex = -1;
    for (var i = 0; i < bundles.length; i++) {
      if (bundles[i].id === next.id) existingIndex = i;
      if (bundles[i].id !== next.id) {
        var otherIds = {};
        bundles[i].models.forEach(function (m) { otherIds[m.id] = true; });
        next.models.forEach(function (m) {
          if (otherIds[m.id]) throw new Error("模型 ID 已由其他 bundle 使用：" + m.id);
        });
      }
    }
    if (existingIndex >= 0) {
      if (next.revision <= bundles[existingIndex].revision)
        throw new Error("校准包 revision 必须高于已导入版本");
      bundles[existingIndex] = next;
    } else {
      bundles.push(next);
    }
    rebuild();
    save();
    return {
      id: next.id,
      revision: next.revision,
      models: next.models.map(function (m) { return m.id; }),
    };
  };

  R.list = function () {
    return models.map(clone);
  };

  R.match = function (context, opt) {
    context = context || {};
    opt = opt || {};
    var machineId = key(context.machineId);
    var firmware = key(context.firmware);
    var material = key(context.material);
    if (!machineId || !firmware) return null;
    var candidates = models.filter(function (model) {
      if (model.status !== "active" && !(opt.includeDemonstration && model.status === "demonstration-only"))
        return false;
      if (key(model.scope.machineId) !== machineId || key(model.scope.firmware) !== firmware)
        return false;
      if (model.scope.material && model.scope.material !== "*" && key(model.scope.material) !== material)
        return false;
      return opt.includeDrifted || model.status !== "active" || R.drift(model).status !== "drift";
    });
    candidates.sort(function (a, b) {
      var materialA = a.scope.material && a.scope.material !== "*" ? 1 : 0;
      var materialB = b.scope.material && b.scope.material !== "*" ? 1 : 0;
      return materialB - materialA || b.bundleRevision - a.bundleRevision;
    });
    return candidates.length ? clone(candidates[0]) : null;
  };

  R.estimate = function (model, plannedTimeSec) {
    if (!model || !model.coefficients) throw new Error("缺少可用校准模型");
    var core = {
      motionScale: model.coefficients.motionScale,
      fixedOverheadSec: model.coefficients.fixedOverheadSec,
    };
    var predicted = root.FXTimeCalibration.predict(core, plannedTimeSec);
    var uncertainty = Math.max(0.03, model.validation.mape, Math.abs(model.validation.medianBias));
    return {
      predictedTimeSec: predicted,
      lowerTimeSec: Math.max(0, predicted * (1 - uncertainty)),
      upperTimeSec: predicted * (1 + uncertainty),
      uncertainty: uncertainty,
      modelId: model.id,
      provenance: model.provenance,
    };
  };

  R.recordObservation = function (model, observation) {
    if (!model || !model.id) throw new Error("缺少模型 ID");
    var row = {
      id: String(observation.id || "observation-" + Date.now()),
      plannedTimeSec: Number(observation.plannedTimeSec),
      actualTimeSec: Number(observation.actualTimeSec),
      machineId: model.scope.machineId,
      firmware: model.scope.firmware,
    };
    var list = Array.isArray(observations[model.id]) ? observations[model.id] : [];
    list = list.filter(function (item) {
      return item.id !== row.id;
    });
    list.push(row);
    if (list.length > MAX_OBSERVATIONS) list = list.slice(list.length - MAX_OBSERVATIONS);
    observations[model.id] = list;
    save();
    return R.drift(model);
  };

  R.drift = function (model) {
    var list = Array.isArray(observations[model.id]) ? observations[model.id] : [];
    return root.FXTimeCalibration.detectDrift(
      model.coefficients,
      list,
      {
        minSamples: model.thresholds.minDriftSamples,
        maxMape: model.thresholds.maxMape,
        maxBias: model.thresholds.maxBias,
      }
    );
  };

  R.clear = function () {
    bundles = [];
    models = [];
    observations = {};
    if (root.localStorage) {
      try { root.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }
  };

  R.reload();
  root.FXCalibrationRegistry = R;
})(typeof window !== "undefined" ? window : globalThis);
