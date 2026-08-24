"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

// Stage 8.1 起「零外部 NuGet 包」规则收敛为逐个评审并锁定版本的允许清单
// （当前仅 Npgsql，见 backend/NuGet.Config 注释与 V2.0 手册 §4.2）；
// 清单（config/dependency-policy.json allowedDotnetPackages）之外的任何引用仍然失败。
function collectDotnetPackageViolations() {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "dependency-policy.json"), "utf8"));
  const allowedByProject = policy.allowedDotnetPackages || {};
  const projectFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.csproj"],
    { cwd: root, encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
  const violations = [];
  for (const file of projectFiles) {
    const body = fs.readFileSync(path.join(root, file), "utf8");
    const references = [...body.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"\s*\/>/g)];
    const rawCount = (body.match(/<PackageReference/g) || []).length;
    if (rawCount !== references.length) {
      violations.push({ file, issue: "unparseable PackageReference" });
    }
    const allowed = allowedByProject[file] || {};
    for (const [, id, version] of references) {
      if (allowed[id] !== version) violations.push({ file, id, version });
    }
  }
  return violations;
}

module.exports = { collectDotnetPackageViolations };

if (require.main === module) {
  const violations = collectDotnetPackageViolations();
  if (violations.length > 0) {
    console.error(`NuGet PackageReference 允许清单校验失败：\n${JSON.stringify(violations, null, 2)}`);
    process.exit(1);
  }
  console.log("OK: 所有 NuGet PackageReference 均命中 config/dependency-policy.json 允许清单");
}
