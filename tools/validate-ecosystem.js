/* 校验仓库中的 Profile bundle 与数据集 manifest。
 * 不引入运行时依赖：结构边界复用浏览器注册表，文件完整性使用 Node crypto。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
require(path.join(ROOT, "js", "profile-registry.js"));
const Profiles = globalThis.FXProfiles;
let passed = 0;
let failed = 0;

function report(ok, message, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.error(`  FAIL  ${message}${detail ? " — " + detail : ""}`);
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function insideRoot(rel) {
  const full = path.resolve(ROOT, rel);
  return full === ROOT || full.startsWith(ROOT + path.sep) ? full : null;
}

function sha256(full) {
  return crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
}

console.log("\n[ecosystem] Profile bundle");
for (const rel of ["contracts/profiles/profile-bundle.schema.json", "contracts/profiles/example-bundle.json"]) {
  try {
    const json = readJson(rel);
    report(!!json && typeof json === "object", `${rel} 是有效 JSON`);
    if (/bundle\.json$/.test(rel)) {
      const checked = Profiles.validateBundle(json);
      report(checked.ok, `${rel} 通过运行时白名单校验`, checked.errors.join("；"));
    }
  } catch (e) {
    report(false, `${rel} 可读取`, e.message);
  }
}

console.log("\n[ecosystem] Machine log contract");
for (const rel of ["contracts/logs/machine-log.schema.json", "contracts/logs/example-machine-log.json"]) {
  try {
    const json = readJson(rel);
    report(!!json && typeof json === "object", `${rel} 是有效 JSON`);
    if (/example-machine-log/.test(rel))
      report(
        json.format === "forgex-machine-log" && json.version === 1 && json.job && Array.isArray(json.telemetry),
        `${rel} 满足 v1 最小契约`
      );
  } catch (e) {
    report(false, `${rel} 可读取`, e.message);
  }
}

console.log("\n[ecosystem] Dataset manifests");
try {
  report(!!readJson("contracts/datasets/dataset-manifest.schema.json"), "数据集 manifest schema 是有效 JSON");
} catch (e) {
  report(false, "数据集 manifest schema 是有效 JSON", e.message);
}
const datasetDir = path.join(ROOT, "contracts", "datasets");
const manifests = fs
  .readdirSync(datasetDir)
  .filter((name) => /\.manifest\.json$/i.test(name))
  .sort();
report(manifests.length > 0, "至少存在一个数据集 manifest");

for (const name of manifests) {
  const rel = path.posix.join("contracts", "datasets", name);
  let manifest;
  try {
    manifest = readJson(rel);
  } catch (e) {
    report(false, `${rel} 是有效 JSON`, e.message);
    continue;
  }
  const baseOk =
    manifest.format === "forgex-dataset-manifest" &&
    manifest.version === 1 &&
    ["real-anonymized", "simulation", "synthetic"].includes(manifest.provenance) &&
    manifest.privacy &&
    typeof manifest.privacy.containsPersonalData === "boolean" &&
    typeof manifest.privacy.anonymized === "boolean" &&
    typeof manifest.privacy.note === "string" &&
    Array.isArray(manifest.files) &&
    manifest.files.length > 0;
  report(baseOk, `${rel} 元数据、来源与隐私声明完整`);

  const sourcePath = manifest.source && insideRoot(manifest.source.path);
  report(!!sourcePath && fs.existsSync(sourcePath), `${rel} 的生成来源存在`);

  for (const entry of manifest.files || []) {
    const full = insideRoot(entry.path);
    if (!full || !fs.existsSync(full)) {
      report(false, `${entry.path} 存在且位于仓库内`);
      continue;
    }
    report(true, `${entry.path} 存在且位于仓库内`);
    report(/^[a-f0-9]{64}$/.test(entry.sha256 || "") && sha256(full) === entry.sha256, `${entry.path} SHA-256 匹配`);

    if (entry.role === "table") {
      const text = fs.readFileSync(full, "utf8").replace(/^\uFEFF/, "");
      const lines = text.trimEnd().split(/\r\n|\n|\r/);
      const header = lines[0].split(",");
      report(
        Array.isArray(entry.columns) &&
          entry.columns.length === header.length &&
          entry.columns.every((col, i) => col === header[i]),
        `${entry.path} 表头契约匹配`
      );
      report(lines.length - 1 === entry.rows, `${entry.path} 行数匹配`, `${lines.length - 1} != ${entry.rows}`);
    } else if (entry.mediaType === "application/json") {
      try {
        JSON.parse(fs.readFileSync(full, "utf8"));
        report(true, `${entry.path} 是有效 JSON`);
      } catch (e) {
        report(false, `${entry.path} 是有效 JSON`, e.message);
      }
    }
  }
}

console.log(`\n═══ 生态校验：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
