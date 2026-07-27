/* FORGE·X — 社区 Profile 注册表（纯逻辑，可在 Node 与浏览器运行）
 *
 * Profile 的边界：
 *   - machine profile 选择现有运动学基座，并提供构建空间、机型标签与物理特征；
 *   - material profile 提供温度、密度、流量、收缩与速度参数；
 *   - JSON 不能注入代码。社区扩展只能使用白名单字段与四种已实现运动学。
 *
 * 浏览器通过文件选择导入 bundle；成功后保存到 localStorage，file:// 同样可用。
 */
(function (root) {
  "use strict";

  var P = {};
  var STORAGE_KEY = "forgex-community-profiles-v1";
  var KINEMATICS = ["corexy", "i3", "delta", "gantry"];
  var machines = {};
  var materials = {};
  var community = { format: "forgex-profile-bundle", version: 1, machines: [], materials: [] };

  var BUILTIN_MACHINES = [
    {
      id: "corexy", name: "FX-256 睿造", tag: "FX-256", kinematics: "corexy",
      description: "CoreXY · 封闭腔体", buildVolume: { x: 256, y: 256, z: 256 },
      enclosed: true, source: "FORGE·X built-in profile",
    },
    {
      id: "i3", name: "FX-220 轻锋", tag: "FX-220", kinematics: "i3",
      description: "i3 龙门 · 开放式", buildVolume: { x: 220, y: 220, z: 250 },
      enclosed: false, source: "FORGE·X built-in profile",
    },
    {
      id: "delta", name: "FX-Δ260 迅影", tag: "FX-Δ260", kinematics: "delta",
      description: "Delta · 并联臂", buildVolume: { x: 260, y: 260, z: 320 },
      enclosed: false, source: "FORGE·X built-in profile",
    },
    {
      id: "gantry", name: "FX-500 巨匠", tag: "FX-500", kinematics: "gantry",
      description: "工业龙门 · 大幅面", buildVolume: { x: 500, y: 500, z: 500 },
      enclosed: true, source: "FORGE·X built-in profile",
    },
  ];

  var BUILTIN_MATERIALS = [
    {
      id: "PLA", name: "PLA", nozzle: { default: 210, min: 195, max: 225 },
      bed: { default: 60, min: 55 }, fan: 100, densityG: 1.24, maxSpeed: 300,
      flowMm3s: 11, shrinkage: 0.25, priceCnyKg: 69, source: "FORGE·X engineering baseline",
    },
    {
      id: "PETG", name: "PETG", nozzle: { default: 240, min: 230, max: 255 },
      bed: { default: 80, min: 70 }, fan: 40, densityG: 1.27, maxSpeed: 200,
      flowMm3s: 9, shrinkage: 0.45, priceCnyKg: 89, source: "FORGE·X engineering baseline",
    },
    {
      id: "ABS", name: "ABS", nozzle: { default: 255, min: 245, max: 268 },
      bed: { default: 100, min: 95 }, fan: 15, densityG: 1.05, maxSpeed: 220,
      flowMm3s: 10, shrinkage: 1, priceCnyKg: 79, source: "FORGE·X engineering baseline",
    },
    {
      id: "TPU", name: "TPU", nozzle: { default: 225, min: 215, max: 240 },
      bed: { default: 50, min: 40 }, fan: 50, densityG: 1.21, maxSpeed: 60,
      flowMm3s: 3.5, shrinkage: 0.35, priceCnyKg: 159, source: "FORGE·X engineering baseline",
    },
  ];

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function plainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function finite(v, min, max) {
    return typeof v === "number" && isFinite(v) && v >= min && v <= max;
  }

  function safeId(v) {
    return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{1,47}$/.test(v);
  }

  function safeText(v, max) {
    return typeof v === "string" && v.trim().length > 0 && v.length <= max;
  }

  function rejectUnknown(obj, allowed, path, errors) {
    Object.keys(obj).forEach(function (key) {
      if (allowed.indexOf(key) < 0) errors.push(path + "." + key + " 不是允许的字段");
    });
  }

  function validatePhysics(obj, path, errors) {
    if (obj == null) return;
    if (!plainObject(obj)) {
      errors.push(path + " 必须是对象");
      return;
    }
    var ranges = {
      hotendFouling: [0, 1], feederGrip: [0.4, 1], spoolDrag: [0, 1],
      heaterHealth: [0.5, 1], beltWear: [0, 1], ambientC: [0, 60], draft: [0, 1],
    };
    Object.keys(obj).forEach(function (key) {
      if (!ranges[key]) errors.push(path + "." + key + " 不是允许的物理字段");
      else if (!finite(obj[key], ranges[key][0], ranges[key][1]))
        errors.push(path + "." + key + " 超出范围 " + ranges[key][0] + "–" + ranges[key][1]);
    });
  }

  P.validateMachine = function (m, path) {
    path = path || "machine";
    var errors = [];
    if (!plainObject(m)) return [path + " 必须是对象"];
    rejectUnknown(m, [
      "id", "name", "tag", "kinematics", "description", "buildVolume",
      "enclosed", "physics", "source",
    ], path, errors);
    if (!safeId(m.id)) errors.push(path + ".id 仅允许 2–48 位字母、数字、点、下划线或连字符");
    if (!safeText(m.name, 80)) errors.push(path + ".name 必填且不超过 80 字符");
    if (!safeText(m.tag, 40)) errors.push(path + ".tag 必填且不超过 40 字符");
    if (KINEMATICS.indexOf(m.kinematics) < 0)
      errors.push(path + ".kinematics 必须是 " + KINEMATICS.join(" / "));
    if (!safeText(m.description, 120)) errors.push(path + ".description 必填且不超过 120 字符");
    if (!plainObject(m.buildVolume)) errors.push(path + ".buildVolume 必须是对象");
    else {
      rejectUnknown(m.buildVolume, ["x", "y", "z"], path + ".buildVolume", errors);
      ["x", "y", "z"].forEach(function (axis) {
        if (!finite(m.buildVolume[axis], 50, 2000))
          errors.push(path + ".buildVolume." + axis + " 必须在 50–2000mm");
      });
    }
    if (typeof m.enclosed !== "boolean") errors.push(path + ".enclosed 必须是布尔值");
    if (!safeText(m.source, 240)) errors.push(path + ".source 必填，用于说明参数出处");
    validatePhysics(m.physics, path + ".physics", errors);
    return errors;
  };

  P.validateMaterial = function (m, path) {
    path = path || "material";
    var errors = [];
    if (!plainObject(m)) return [path + " 必须是对象"];
    rejectUnknown(m, [
      "id", "name", "nozzle", "bed", "fan", "densityG", "maxSpeed",
      "flowMm3s", "shrinkage", "priceCnyKg", "source",
    ], path, errors);
    if (!safeId(m.id)) errors.push(path + ".id 仅允许 2–48 位字母、数字、点、下划线或连字符");
    if (!safeText(m.name, 80)) errors.push(path + ".name 必填且不超过 80 字符");
    if (!plainObject(m.nozzle)) errors.push(path + ".nozzle 必须是对象");
    else {
      rejectUnknown(m.nozzle, ["default", "min", "max"], path + ".nozzle", errors);
      if (!finite(m.nozzle.default, 120, 450)) errors.push(path + ".nozzle.default 必须在 120–450°C");
      if (!finite(m.nozzle.min, 120, 450)) errors.push(path + ".nozzle.min 必须在 120–450°C");
      if (!finite(m.nozzle.max, 120, 450)) errors.push(path + ".nozzle.max 必须在 120–450°C");
      if (finite(m.nozzle.min, 120, 450) && finite(m.nozzle.max, 120, 450) &&
          (m.nozzle.default < m.nozzle.min || m.nozzle.default > m.nozzle.max))
        errors.push(path + ".nozzle.default 必须落在 min/max 内");
    }
    if (!plainObject(m.bed)) errors.push(path + ".bed 必须是对象");
    else {
      rejectUnknown(m.bed, ["default", "min"], path + ".bed", errors);
      if (!finite(m.bed.default, 0, 180)) errors.push(path + ".bed.default 必须在 0–180°C");
      if (!finite(m.bed.min, 0, 180)) errors.push(path + ".bed.min 必须在 0–180°C");
      if (finite(m.bed.default, 0, 180) && finite(m.bed.min, 0, 180) && m.bed.default < m.bed.min)
        errors.push(path + ".bed.default 不能低于 bed.min");
    }
    if (!finite(m.fan, 0, 100)) errors.push(path + ".fan 必须在 0–100%");
    if (!finite(m.densityG, 0.2, 5)) errors.push(path + ".densityG 必须在 0.2–5g/cm³");
    if (!finite(m.maxSpeed, 5, 1000)) errors.push(path + ".maxSpeed 必须在 5–1000mm/s");
    if (!finite(m.flowMm3s, 0.2, 100)) errors.push(path + ".flowMm3s 必须在 0.2–100mm³/s");
    if (!finite(m.shrinkage, 0, 3)) errors.push(path + ".shrinkage 必须在 0–3");
    if (!finite(m.priceCnyKg, 0, 5000)) errors.push(path + ".priceCnyKg 必须在 0–5000 元/kg");
    if (!safeText(m.source, 240)) errors.push(path + ".source 必填，用于说明参数出处");
    return errors;
  };

  P.validateBundle = function (bundle) {
    var errors = [];
    if (!plainObject(bundle)) return { ok: false, errors: ["Profile bundle 必须是 JSON 对象"] };
    rejectUnknown(bundle, ["$schema", "format", "version", "machines", "materials"], "bundle", errors);
    if (bundle.format !== "forgex-profile-bundle") errors.push("format 必须是 forgex-profile-bundle");
    if (bundle.version !== 1) errors.push("version 必须是 1");
    if (!Array.isArray(bundle.machines)) errors.push("machines 必须是数组");
    if (!Array.isArray(bundle.materials)) errors.push("materials 必须是数组");
    var ids = {};
    (bundle.machines || []).forEach(function (m, i) {
      errors.push.apply(errors, P.validateMachine(m, "machines[" + i + "]"));
      if (m && ids["machine:" + m.id]) errors.push("machine id 重复：" + m.id);
      if (m) ids["machine:" + m.id] = true;
    });
    (bundle.materials || []).forEach(function (m, i) {
      errors.push.apply(errors, P.validateMaterial(m, "materials[" + i + "]"));
      if (m && ids["material:" + m.id]) errors.push("material id 重复：" + m.id);
      if (m) ids["material:" + m.id] = true;
    });
    if (!(bundle.machines || []).length && !(bundle.materials || []).length)
      errors.push("bundle 至少要包含一个 machine 或 material");
    return { ok: errors.length === 0, errors: errors };
  };

  function normalizeMaterial(m) {
    var x = clone(m);
    x.nozzleTemp = x.nozzle.default;
    x.nozzleRange = [x.nozzle.min, x.nozzle.max];
    x.bedTemp = x.bed.default;
    x.bedMin = x.bed.min;
    x.community = !!x.community;
    return x;
  }

  P.registerMaterial = function (m, isCommunity) {
    var errors = P.validateMaterial(m);
    if (errors.length) throw new Error(errors.join("；"));
    var x = normalizeMaterial(m);
    x.community = !!isCommunity;
    if (isCommunity && materials[x.id] && !materials[x.id].community)
      throw new Error("社区材料不能覆盖内置 Profile：" + x.id);
    materials[x.id] = x;
    if (isCommunity) P.syncCostProfile();
    return x;
  };

  P.registerMachine = function (m, isCommunity) {
    var errors = P.validateMachine(m);
    if (errors.length) throw new Error(errors.join("；"));
    var x = clone(m);
    x.community = !!isCommunity;
    if (isCommunity && machines[x.id] && !machines[x.id].community)
      throw new Error("社区机型不能覆盖内置 Profile：" + x.id);
    machines[x.id] = x;
    if (root.FXMachineProfile && root.FXMachineProfile.registerModelTrait) {
      root.FXMachineProfile.registerModelTrait(x.tag, {
        enclosed: x.enclosed,
        buildMm: Math.max(x.buildVolume.x, x.buildVolume.y),
        label: x.description,
      });
    }
    if (root.FXPrinters && root.FXPrinters.registerProfile) root.FXPrinters.registerProfile(x);
    return x;
  };

  P.importBundle = function (bundle, opt) {
    var check = P.validateBundle(bundle);
    if (!check.ok) throw new Error(check.errors.join("；"));
    (bundle.machines || []).forEach(function (m) {
      if (machines[m.id] && !machines[m.id].community)
        throw new Error("社区机型不能覆盖内置 Profile：" + m.id);
    });
    (bundle.materials || []).forEach(function (m) {
      if (materials[m.id] && !materials[m.id].community)
        throw new Error("社区材料不能覆盖内置 Profile：" + m.id);
    });
    var added = { machines: [], materials: [] };
    (bundle.machines || []).forEach(function (m) {
      added.machines.push(P.registerMachine(m, true));
    });
    (bundle.materials || []).forEach(function (m) {
      added.materials.push(P.registerMaterial(m, true));
    });
    if (!opt || opt.persist !== false) {
      (bundle.machines || []).forEach(function (m) {
        var i = community.machines.findIndex(function (x) { return x.id === m.id; });
        if (i >= 0) community.machines[i] = clone(m);
        else community.machines.push(clone(m));
      });
      (bundle.materials || []).forEach(function (m) {
        var i = community.materials.findIndex(function (x) { return x.id === m.id; });
        if (i >= 0) community.materials[i] = clone(m);
        else community.materials.push(clone(m));
      });
      P.persist();
    }
    return added;
  };

  P.persist = function () {
    try {
      if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(community));
      return true;
    } catch (e) {
      return false;
    }
  };

  P.loadStored = function () {
    try {
      if (!root.localStorage) return null;
      var raw = root.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var bundle = JSON.parse(raw);
      var loaded = P.importBundle(bundle, { persist: false });
      community = clone(bundle);
      return loaded;
    } catch (e) {
      try { root.localStorage.removeItem(STORAGE_KEY); } catch (ignored) {}
      return null;
    }
  };

  P.clearStored = function () {
    try { if (root.localStorage) root.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  };

  P.machine = function (id) { return machines[id] || null; };
  P.material = function (id) { return materials[id] || null; };
  P.listMachines = function () { return Object.keys(machines).map(function (id) { return machines[id]; }); };
  P.listMaterials = function () { return Object.keys(materials).map(function (id) { return materials[id]; }); };
  P.machines = machines;
  P.materials = materials;
  P.syncCostProfile = function () {
    if (!root.FXInsightData || !root.FXInsightData.COST_PROFILE ||
        !root.FXInsightData.setCostProfile) return false;
    var current = root.FXInsightData.COST_PROFILE;
    if (!P._baseCostSource) P._baseCostSource = current.source;
    var prices = clone(current.material || {});
    var sources = [];
    Object.keys(materials).forEach(function (id) {
      var m = materials[id];
      if (!m.community || !finite(m.priceCnyKg, 0, 5000)) return;
      prices[id] = Math.round(m.priceCnyKg * 100);
      sources.push(id + "：" + m.source);
    });
    root.FXInsightData.setCostProfile({
      material: prices,
      source: P._baseCostSource + (sources.length ? "；社区 Profile：" + sources.join("；") : ""),
    });
    return true;
  };
  P.kinematics = KINEMATICS.slice();
  P.builtinBundle = function () {
    return {
      format: "forgex-profile-bundle",
      version: 1,
      machines: clone(BUILTIN_MACHINES),
      materials: clone(BUILTIN_MATERIALS),
    };
  };

  BUILTIN_MATERIALS.forEach(function (m) { P.registerMaterial(m, false); });
  BUILTIN_MACHINES.forEach(function (m) { P.registerMachine(m, false); });
  P.loadStored();

  root.FXProfiles = P;
})(typeof window !== "undefined" ? window : globalThis);
