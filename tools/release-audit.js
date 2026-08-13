/* 发布一致性门禁：版本、缓存、文档、校准生命周期和跨浏览器 CI 必须同频。 */
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

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
function text(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
function json(rel) {
  return JSON.parse(text(rel));
}

console.log("\n[release] Version and metadata");
const pkg = json("package.json");
const lock = json("package-lock.json");
const version = pkg.version;
const cacheVersion = String(Number(version.split(".")[1]));
check("package 与 lock 根版本一致", lock.version === version && lock.packages[""].version === version);
check("版本采用稳定 semver", /^0\.\d+\.\d+$/.test(version), version);
for (const rel of ["README.md", ".github/README.en.md"]) {
  check(`${rel} 徽章版本一致`, text(rel).includes(`version-${version}-`));
}
check("CHANGELOG 含当前版本", text("CHANGELOG.md").includes(`## [${version}]`));

console.log("\n[release] Browser cache contract");
const html = text("index.html");
const localAssets = Array.from(html.matchAll(/(?:href|src)="(frontend\/classic\/(?:css|js)\/[^"]+)\?v=(\d+)"/g));
const appAssets = localAssets.filter((match) => !match[1].includes("vendor/"));
check("发现应用 CSS/JS 缓存键", appAssets.length >= 15, String(appAssets.length));
check(
  "应用 CSS/JS 缓存键全部跟随小版本",
  appAssets.every((match) => match[2] === cacheVersion),
  appAssets
    .filter((match) => match[2] !== cacheVersion)
    .map((match) => match[1])
    .join(",")
);

console.log("\n[release] P6 validation contract");
const manifest = json("contracts/validation/fixture-manifest.json");
const calibration = json("contracts/validation/time-calibration-report.json");
check("校准报告绑定 fixture manifest", calibration.sourceManifest === "contracts/validation/fixture-manifest.json");
check("报告保留 provenance", calibration.provenance === manifest.provenance);
check(
  "合成兼容性夹具不冒充真机精度",
  manifest.provenance !== "synthetic-conformance" || /not.*production|不是.*生产/i.test(manifest.disclaimer)
);
check("发布脚本包含完整验证入口", pkg.scripts["release:check"] === "npm run check && npm run test:e2e");

console.log("\n[release] P7 calibration lifecycle");
const bundle = json("contracts/calibration/example-bundle.json");
const bundleSchema = json("contracts/calibration/calibration-bundle.schema.json");
check("校准示例使用受控 bundle 格式", bundle.format === "forgex-calibration-bundle" && bundle.version === 1);
check(
  "合成模型只能作为 demonstration",
  bundle.provenance !== "synthetic-conformance" || bundle.models.every((model) => model.status === "demonstration-only")
);
check("bundle schema 默认拒绝未知字段", bundleSchema.additionalProperties === false);
check(
  "主测试链包含校准注册表与运营门禁",
  pkg.scripts.test.includes("tests/calibration-registry.test.js") &&
    pkg.scripts.test.includes("tools/validate-calibrations.js")
);
check(
  "注册表在 UI 之前加载",
  html.indexOf("classic/js/calibration-registry.js") > -1 &&
    html.indexOf("classic/js/calibration-registry.js") < html.indexOf("classic/js/ui.js")
);
check("浏览器回归覆盖 P7 校准生命周期", fs.existsSync(path.join(ROOT, "tests/e2e/p7.spec.js")));

console.log("\n[release] P8 reviewed distribution");
const calibrationService = text("server/services/calibration.js");
const calibrationRoute = text("server/routes/calibration.js");
check("主测试链包含服务端校准审批契约", pkg.scripts.test.includes("tests/calibration-service.test.js"));
check("服务端组装公开校准目录", text("server/index.js").includes("routes/calibration"));
check("审批写接口强制 API Key", /auth\.enabled/.test(calibrationRoute));
check("审批禁止提交者自批", /提交者不能审批自己/.test(calibrationService));
check("浏览器启动时同步审核目录", /pullCalibrations/.test(text("frontend/classic/js/main.js")));
check("浏览器回归覆盖服务端发布", fs.existsSync(path.join(ROOT, "tests/e2e/p8.spec.js")));

const workflow = text(".github/workflows/ci.yml");
check("CI 安装 Chromium、Firefox 与 WebKit", /playwright install --with-deps chromium firefox webkit/.test(workflow));
check(
  "Playwright 配置声明三浏览器",
  ["chromium", "firefox", "webkit"].every((name) =>
    new RegExp(`name:\\s*["']${name}["']`).test(text("config/playwright.config.js"))
  )
);

console.log(`\n═══ 发布门禁：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
