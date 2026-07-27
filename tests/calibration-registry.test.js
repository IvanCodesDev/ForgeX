/* P7 校准包注册、作用域匹配与漂移生命周期 */
"use strict";

const path = require("path");
const fs = require("fs");
const store = {};
globalThis.localStorage = {
  getItem: (key) => store[key] || null,
  setItem: (key, value) => { store[key] = value; },
  removeItem: (key) => { delete store[key]; },
};
require(path.join(__dirname, "..", "js", "time-calibration.js"));
require(path.join(__dirname, "..", "js", "calibration-registry.js"));
const Registry = globalThis.FXCalibrationRegistry;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function activeBundle(overrides) {
  const bundle = {
    format: "forgex-calibration-bundle",
    version: 1,
    id: "factory-calibration",
    revision: 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized paired production observations collected with authorization.",
    },
    models: [
      {
        id: "fx01-klipper-pla",
        status: "active",
        scope: { machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-27T00:00:00Z",
        coefficients: { motionScale: 1.2, fixedOverheadSec: 90, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.18,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "a".repeat(64),
      },
    ],
  };
  return Object.assign(bundle, overrides || {});
}

console.log("\n[1] 示例与安全边界");
Registry.clear();
const example = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "calibration", "example-bundle.json"), "utf8")
);
const exampleCheck = Registry.validateBundle(example);
check("仓库示例通过运行时白名单", exampleCheck.ok, exampleCheck.errors.join("|"));
Registry.importBundle(example);
check("合成 demonstration 模型可登记", Registry.list().length === 1);
check(
  "合成模型默认不参与自动匹配",
  Registry.match({ machineId: "FX-VALIDATION-01", firmware: "mixed compatibility fixture" }) === null
);
check(
  "显式预览时才可选择 demonstration 模型",
  Registry.match(
    { machineId: "FX-VALIDATION-01", firmware: "mixed compatibility fixture" },
    { includeDemonstration: true }
  ).status === "demonstration-only"
);

console.log("\n[2] active 准入门槛");
let invalid = activeBundle({ provenance: "synthetic-conformance" });
check("合成数据不能启用 active", !Registry.validateBundle(invalid).ok);
invalid = activeBundle();
invalid.models[0].validation.holdoutSamples = 4;
check("少于五个 holdout 不能启用", !Registry.validateBundle(invalid).ok);
invalid = activeBundle();
invalid.models[0].validation.mape = 0.25;
check("holdout MAPE 超阈值不能启用", !Registry.validateBundle(invalid).ok);
invalid = activeBundle();
invalid.models[0].onload = "alert(1)";
check("未知字段与脚本载荷被拒绝", !Registry.validateBundle(invalid).ok);

console.log("\n[3] 作用域、版本和持久化");
Registry.clear();
const imported = Registry.importBundle(activeBundle());
check("真实 active bundle 导入成功", imported.models[0] === "fx01-klipper-pla");
check(
  "机型/固件/材料完全匹配",
  Registry.match({ machineId: "fx-01", firmware: "klipper 0.12", material: "pla" }).id === "fx01-klipper-pla"
);
check(
  "固件不同不误用模型",
  Registry.match({ machineId: "FX-01", firmware: "Marlin 2.1", material: "PLA" }) === null
);
check(
  "材料不同不误用模型",
  Registry.match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PETG" }) === null
);
let err = null;
try {
  Registry.importBundle(activeBundle());
} catch (e) {
  err = e;
}
check("同 revision 不允许覆盖", !!err && /revision/.test(err.message));
const revision2 = activeBundle({ revision: 2 });
revision2.models[0].coefficients.motionScale = 1.3;
Registry.importBundle(revision2);
check("更高 revision 原子替换", Registry.list().length === 1 && Registry.list()[0].coefficients.motionScale === 1.3);
Registry.reload();
check("刷新后从 localStorage 恢复", Registry.list().length === 1 && Registry.list()[0].bundleRevision === 2);

console.log("\n[4] 区间估算与漂移");
const model = Registry.match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" });
const estimate = Registry.estimate(model, 100);
check("校准估算应用固定开销与倍率", estimate.predictedTimeSec === 220);
check("估算携带 holdout 不确定区间", estimate.lowerTimeSec < 220 && estimate.upperTimeSec > 220);
let drift = null;
for (let i = 0; i < 4; i++) {
  drift = Registry.recordObservation(model, {
    id: `stable-${i}`,
    plannedTimeSec: 100 + i * 10,
    actualTimeSec: 90 + 1.3 * (100 + i * 10),
  });
}
check("少量观测不提前宣布稳定或漂移", drift.status === "insufficient" && drift.sampleCount === 4);
drift = Registry.recordObservation(model, {
  id: "stable-5",
  plannedTimeSec: 150,
  actualTimeSec: 90 + 1.3 * 150,
});
check("五个吻合观测判为 stable", drift.status === "stable", JSON.stringify(drift));
drift = Registry.recordObservation(model, {
  id: "stable-5",
  plannedTimeSec: 150,
  actualTimeSec: 90 + 1.3 * 150,
});
check("重复任务不会被累计为多个漂移样本", drift.sampleCount === 5);
for (let i = 0; i < 8; i++) {
  drift = Registry.recordObservation(model, {
    id: `drift-${i}`,
    plannedTimeSec: 200 + i * 10,
    actualTimeSec: (90 + 1.3 * (200 + i * 10)) * 1.5,
  });
}
check("持续偏差触发 drift", drift.status === "drift", JSON.stringify(drift));
check("漂移报告保留中位偏差与 P90", drift.medianBias != null && drift.p90Ape != null);
check(
  "已漂移 active 模型停止后续自动匹配",
  Registry.match({ machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" }) === null
);

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
