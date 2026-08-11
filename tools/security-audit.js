"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "dependency-policy.json"), "utf8"));
const checks = [];

function check(name, pass, actual) {
  checks.push({ name, pass, actual });
  if (!pass) throw new Error(`${name} failed: ${JSON.stringify(actual)}`);
}

function repoFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith("optimization/") && !file.startsWith(".claude/"));
}

const files = repoFiles();
const forbiddenEnv = files.filter((file) => /(^|\/)\.env$/i.test(file));
check("tracked-env-files", forbiddenEnv.length === 0, forbiddenEnv);

const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/],
  ["credential-url", /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
];
const secretFindings = [];
for (const file of files) {
  const absolute = path.join(root, file);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const body = fs.readFileSync(absolute);
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  for (const [kind, pattern] of secretPatterns) {
    if (pattern.test(text)) secretFindings.push({ file: file.replaceAll("\\", "/"), kind });
  }
}
const unexpectedSecretFindings = secretFindings.filter(
  (finding) =>
    !(policy.allowedSecretFixtures || []).some(
      (allowed) => allowed.file === finding.file && allowed.kind === finding.kind
    )
);
check("secret-pattern-scan", unexpectedSecretFindings.length === 0, {
  auditedFixtures: secretFindings.filter((finding) => !unexpectedSecretFindings.includes(finding)),
  unexpected: unexpectedSecretFindings,
});

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
check("npm-lockfile-v3", lock.lockfileVersion === 3, lock.lockfileVersion);
const packages = lock.packages || {};
const registryViolations = [];
const integrityViolations = [];
const observedRegistries = new Set();
for (const [name, entry] of Object.entries(packages)) {
  if (!entry.resolved || !/^https?:/i.test(entry.resolved)) continue;
  const resolved = new URL(entry.resolved);
  observedRegistries.add(resolved.hostname);
  if (resolved.protocol !== "https:" || !policy.allowedNpmRegistries.includes(resolved.hostname)) {
    registryViolations.push({ name, resolved: entry.resolved });
  }
  if (!entry.integrity) integrityViolations.push(name);
}
check("npm-approved-registries", registryViolations.length === 0, {
  observed: [...observedRegistries].sort(),
  violations: registryViolations,
});
check("npm-remote-integrity", integrityViolations.length === 0, integrityViolations);

const actualInstallScripts = Object.fromEntries(
  Object.entries(packages)
    .filter(([, entry]) => entry.hasInstallScript)
    .map(([name, entry]) => [name, entry.version])
);
check(
  "npm-install-script-allowlist",
  JSON.stringify(actualInstallScripts) === JSON.stringify(policy.allowedInstallScripts),
  actualInstallScripts
);

const projectFiles = files.filter((file) => file.endsWith(".csproj"));
const packageReferences = projectFiles.filter((file) =>
  fs.readFileSync(path.join(root, file), "utf8").includes("<PackageReference")
);
check("dotnet-zero-external-packages", packageReferences.length === 0, packageReferences);
const nugetConfig = fs.readFileSync(path.join(root, "backend", "NuGet.Config"), "utf8");
check(
  "nuget-sources-cleared",
  /<packageSources>[\s\S]*?<clear\s*\/>[\s\S]*?<\/packageSources>/.test(nugetConfig),
  true
);

for (const dockerfile of policy.requiredDockerfiles) {
  const body = fs.readFileSync(path.join(root, dockerfile), "utf8");
  const images = [...body.matchAll(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/gim)].map((match) => match[1]);
  check(
    `pinned-images:${dockerfile}`,
    images.length > 0 && images.every((image) => /:[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9.]+)?$/.test(image)),
    images
  );
  check(`non-root-runtime:${dockerfile}`, /^USER\s+[1-9][0-9]*:[1-9][0-9]*$/m.test(body), true);
}

const report = {
  schemaVersion: "1.0",
  generatedAtUtc: new Date().toISOString(),
  result: "pass",
  summary: {
    passed: checks.filter((item) => item.pass).length,
    total: checks.length,
  },
  checks,
};
const artifact = path.join(root, "backend", "artifacts", "security-audit.json");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Security audit PASS: ${report.summary.passed}/${report.summary.total}`);
console.log(artifact);
