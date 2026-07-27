/* P7 校准运营门禁：bundle 契约、来源边界、训练集指纹和自动匹配策略。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

const storage = new Map();
global.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
};
require(path.join(ROOT, "js", "time-calibration.js"));
require(path.join(ROOT, "js", "calibration-registry.js"));

const Registry = global.FXCalibrationRegistry;
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "calibration", "example-bundle.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "calibration", "calibration-bundle.schema.json"), "utf8"));
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const serverIndex = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
const serverService = fs.readFileSync(path.join(ROOT, "server", "services", "calibration.js"), "utf8");
const serverRoute = fs.readFileSync(path.join(ROOT, "server", "routes", "calibration.js"), "utf8");
const apiClient = fs.readFileSync(path.join(ROOT, "js", "api-client.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "js", "main.js"), "utf8");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[P7 calibration] Bundle contract");
const validation = Registry.validateBundle(example);
check("仓库示例通过运行时严格校验", validation.ok, validation.errors.join("；"));
check("schema 禁止 bundle 顶层未知字段", schema.additionalProperties === false);
check("schema 禁止模型未知字段", schema.$defs.model.additionalProperties === false);
check(
  "schema 与运行时声明相同生命周期",
  ["candidate", "active", "retired", "demonstration-only"].every((status) =>
    schema.$defs.model.properties.status.enum.includes(status)
  )
);
check("校准算法固定为当前已实现的 Theil–Sen", schema.$defs.model.properties.algorithm.const === "theil-sen");
check("示例明确标为合成兼容性数据", example.provenance === "synthetic-conformance");
check(
  "示例模型只能用于演示",
  example.models.every((model) => model.status === "demonstration-only")
);
check("示例说明不冒充生产模型", /not a production|不是生产/i.test(example.source.note));

console.log("\n[P7 calibration] Provenance and integrity");
const manifestBytes = fs.readFileSync(path.join(ROOT, "validation", "fixture-manifest.json"));
const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
check(
  "示例训练集指纹绑定 P6 fixture manifest",
  example.models.every((model) => model.trainingSetSha256 === manifestSha),
  manifestSha
);
check(
  "active 来源只允许匿名化或明确同意的真实数据",
  schema.properties.provenance.enum.includes("real-anonymized") &&
    schema.properties.provenance.enum.includes("real-consented")
);
Registry.clear();
Registry.importBundle(example);
check(
  "合成 demonstration 模型不会被默认自动匹配",
  Registry.match({
    machineId: example.models[0].scope.machineId,
    firmware: example.models[0].scope.firmware,
  }) === null
);
check(
  "演示模型仅能显式预览",
  Registry.match(
    {
      machineId: example.models[0].scope.machineId,
      firmware: example.models[0].scope.firmware,
    },
    { includeDemonstration: true }
  ).id === example.models[0].id
);

console.log("\n[P7 calibration] Browser integration");
check("浏览器提供校准包文件入口", /id="calibration-input"/.test(html));
check("注册表先于 UI 加载", html.indexOf("calibration-registry.js") < html.indexOf("ui.js"));
check(
  "示例 bundle 从界面可访问",
  /calibration\/example-bundle\.json/.test(fs.readFileSync(path.join(ROOT, "js", "ui.js"), "utf8"))
);
check(
  "npm 主测试链包含校准运营门禁",
  require(path.join(ROOT, "package.json")).scripts.test.includes("tools/validate-calibrations.js")
);

console.log("\n[P8 calibration] Review and distribution");
check("服务端注册校准发布路由", /routes\/calibration/.test(serverIndex));
check("写接口要求已配置 API Key", /auth\.enabled/.test(serverRoute) && /校准审批需要有效 API Key/.test(serverRoute));
check("候选审批执行四眼原则", /提交者不能审批自己/.test(serverService));
check(
  "批准时重新执行 active 准入校验",
  /model\.status = "active"/.test(serverService) && /validateBundle\(published\)/.test(serverService)
);
check("浏览器只拉取公开已审核目录", /\/api\/calibrations/.test(apiClient) && /pullCalibrations/.test(main));
check("P8 浏览器回归覆盖提交审核与同步", fs.existsSync(path.join(ROOT, "tests", "e2e", "p8.spec.js")));

console.log(`\n═══ P7/P8 校准门禁：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
