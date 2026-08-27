/* Stage 8 工作项 5「静态托管」单进程部署实测（手册 §6 第 4 周「ForgeX.Api 托管静态，单进程部署实测」）。

   ForgeX.StaticGate 用固件静态根锁定与 server/lib/http.js 的逐条行为对齐；本工具是它的实战补集：
   真实构建 dist/react（已有产物则复用，FORGEX_STATIC_DRILL_REBUILD=1 强制重建），只启动一个
   ForgeX.Api 进程（file 持久化），走 Stage 8 退出门槛「上传→分析→分享→撤销→重启持久化」全链：
     1. 静态面可达：/ → React 构建产物、/legacy 经典入口、/react/assets/* immutable 缓存、
        contracts 白名单、dist 不直达、路径穿越防护；API/健康检查路由优先级不受影响；
     2. 上传数据集/发起分析：POST /api/v1/gcode/analyses 真实执行异步 G-code 分析作业至终态；
     3. 创建分享 → 撤销：C# shares 自 Stage 8.1 起仅支持 PostgreSQL（Node ShareStore 有 file 腿，
        C# 没有）。提供 FORGEX_DRILL_POSTGRES_URL / POSTGRES_URL 且 forgex.shares 已迁移时真实跑通；
        否则该腿如实记 skipped 并给出原因，绝不伪造通过；
     4. 重启进程（新随机端口）：file 作业仓库跨重启可读、静态面仍可达、分享撤销状态保持；
     5. 清理临时运行目录与分享数据。
   端口一律随机分配（getFreePort），不硬编码；产物：backend/artifacts/static-hosting-drill.json。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const apiDll = path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");
const artifactPath = path.join(root, "backend", "artifacts", "static-hosting-drill.json");

const steps = [];
let skippedCount = 0;

function step(name, pass, detail) {
  steps.push({ name, result: pass ? "pass" : "fail", detail: detail === undefined ? null : String(detail) });
  if (!pass) throw new Error(`${name} failed: ${detail}`);
  process.stdout.write(`  PASS  ${name}\n`);
}

function skipStep(name, reason) {
  skippedCount += 1;
  steps.push({ name, result: "skipped", detail: reason });
  process.stdout.write(`  SKIP  ${name} — ${reason}\n`);
}

const sha256 = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dotnetExecutable() {
  const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  return fs.existsSync(local) ? local : "dotnet";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-static-drill-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function jfetch(baseUrl, pathname, init = {}, timeoutMs = 15_000) {
  const response = await fetch(baseUrl + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 正文（HTML/静态资源）走 text */
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Node http 客户端会原样发送 path——用于把未规范化的穿越路径逐字节交给 Kestrel。 */
function rawRequest(baseUrl, rawPath) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path: rawPath, method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("raw request timeout")));
    request.end();
  });
}

async function waitForReady(baseUrl, child, stdout, stderr) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`ForgeX.Api exited ${child.exitCode}: ${stdout.join("")}${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 启动竞态：限期内重试。
    }
    await sleep(125);
  }
  throw new Error(`ForgeX.Api readiness timed out: ${stdout.join("")}${stderr.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/* ── 前端构建（真实产物，不用固件） ─────────────────────────────────────────── */

function ensureFrontendBuild() {
  const indexPath = path.join(root, "dist", "react", "index.html");
  const rebuild = process.env.FORGEX_STATIC_DRILL_REBUILD === "1" || !fs.existsSync(indexPath);
  if (rebuild) {
    process.stdout.write("building dist/react via `npm run frontend:build` ...\n");
    // Windows 下 npm 是 npm.cmd，需经 shell 解析；参数固定为字面量，无注入面。
    const result =
      process.platform === "win32"
        ? spawnSync("npm run frontend:build", { cwd: root, stdio: "inherit", shell: true })
        : spawnSync("npm", ["run", "frontend:build"], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`frontend build failed with exit code ${result.status}`);
  }
  const html = fs.readFileSync(indexPath, "utf8");
  const assets = [...new Set(html.match(/\/react\/assets\/[A-Za-z0-9._-]+/g) || [])];
  if (assets.length === 0) throw new Error("dist/react/index.html 未引用任何 /react/assets/* 资产");
  return { reused: !rebuild, indexSha256: sha256(html), assets };
}

/* ── 分享腿前置探测（C# shares 为 postgres-only，见文件头注释） ─────────────── */

async function probeShares(postgresUrl) {
  let Client;
  try {
    ({ Client } = require("pg"));
  } catch {
    return { ok: false, reason: "pg 模块不可用（需 npm install 后重试）" };
  }
  const client = new Client({ connectionString: postgresUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("SELECT 1 FROM forgex.shares LIMIT 0");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `PostgreSQL 探测失败（未启动或 forgex.shares 未迁移）：${error.message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

/* ── 语料：小型真实 G-code（两层方形壁，含真实挤出与温控） ──────────────────── */

const GCODE_FIXTURE = [
  "; FORGE-X static hosting drill fixture",
  "M104 S200",
  "M140 S60",
  "G28",
  "G92 E0",
  "G1 Z0.2 F600",
  "G1 X10 Y10 F3000",
  "G1 X30 Y10 E1.5 F1500",
  "G1 X30 Y30 E3.0",
  "G1 X10 Y30 E4.5",
  "G1 X10 Y10 E6.0",
  "G1 Z0.4 F600",
  "G1 X30 Y10 E7.5 F1500",
  "G1 X30 Y30 E9.0",
  "G1 X10 Y30 E10.5",
  "G1 X10 Y10 E12.0",
  "M104 S0",
  "M140 S0",
  "M84",
].join("\n");

async function waitForJobTerminal(baseUrl, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const snapshot = await jfetch(baseUrl, `/api/v1/jobs/${jobId}`);
    latest = snapshot.json;
    if (latest && ["succeeded", "degraded", "failed", "cancelled"].includes(latest.status)) return latest;
    await sleep(100);
  }
  throw new Error(`作业未在 ${timeoutMs}ms 内进入终态：${JSON.stringify(latest)}`);
}

/* ── 主流程 ──────────────────────────────────────────────────────────────────── */

async function main() {
  if (!fs.existsSync(apiDll)) {
    throw new Error(`Release API build missing: ${apiDll} — run \`npm run dotnet:build\` first`);
  }

  const frontendBuild = ensureFrontendBuild();
  step("frontend-build-artifacts", frontendBuild.assets.length > 0, JSON.stringify(frontendBuild.assets));

  const sharesUrl = process.env.FORGEX_DRILL_POSTGRES_URL || process.env.POSTGRES_URL || "";
  let sharesMode = { enabled: false, reason: "未提供 FORGEX_DRILL_POSTGRES_URL / POSTGRES_URL" };
  if (sharesUrl) {
    const probe = await probeShares(sharesUrl);
    sharesMode = probe.ok ? { enabled: true, reason: null } : { enabled: false, reason: probe.reason };
  }

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-static-drill-"));
  const storageRoot = path.join(runtimeRoot, "data");
  const spawnApi = async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const stdout = [];
    const stderr = [];
    const child = spawn(dotnetExecutable(), [apiDll], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Production",
        Kestrel__Endpoints__Http__Url: baseUrl,
        Storage__Root: storageRoot,
        StaticHosting__Enabled: "1",
        StaticHosting__Root: root,
        ...(sharesMode.enabled ? { Shares__Provider: "postgres", Shares__PostgresUrl: sharesUrl } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    await waitForReady(baseUrl, child, stdout, stderr);
    return { child, baseUrl, port };
  };

  let phase1 = null;
  let phase2 = null;
  const evidence = { jobId: null, firstPid: null, secondPid: null, ports: [] };

  try {
    phase1 = await spawnApi();
    evidence.firstPid = phase1.child.pid;
    evidence.ports.push(phase1.port);
    const base = phase1.baseUrl;

    // ── 1. 静态面（真实构建产物） ────────────────────────────────────────────
    const home = await jfetch(base, "/");
    step(
      "static-root-serves-react",
      home.status === 200 && home.text.includes('<div id="root">') && home.text.includes("/react/assets/"),
      `status=${home.status}`
    );
    for (const asset of frontendBuild.assets) {
      const response = await jfetch(base, asset);
      const cacheControl = response.headers.get("cache-control") || "";
      step(
        `static-asset:${asset}`,
        response.status === 200 && cacheControl.includes("immutable") && cacheControl.includes("max-age=31536000"),
        `status=${response.status} cache-control=${cacheControl}`
      );
    }
    const legacy = await jfetch(base, "/legacy");
    step("static-legacy-entry", legacy.status === 200 && legacy.text.includes("FORGE"), `status=${legacy.status}`);
    const reactEntry = await jfetch(base, "/react");
    step(
      "static-react-mount",
      reactEntry.status === 200 && reactEntry.text === home.text,
      `status=${reactEntry.status}`
    );
    const contract = await jfetch(base, "/contracts/profiles/example-bundle.json");
    step(
      "static-contract-allowlist",
      contract.status === 200 && contract.text.includes("forgex-profile-bundle"),
      `status=${contract.status}`
    );
    const distDirect = await jfetch(base, "/dist/react/index.html");
    step("static-dist-not-direct", distDirect.status === 404, `status=${distDirect.status}`);
    const traversal = await rawRequest(base, "/react/assets/../../server/.env");
    step("static-traversal-denied", traversal.status === 404, `status=${traversal.status}`);
    const healthz = await jfetch(base, "/healthz");
    step(
      "api-priority-healthz",
      healthz.status === 200 && healthz.json && healthz.json.ok === true,
      `status=${healthz.status}`
    );

    // ── 2. 上传数据集 / 发起分析（异步 G-code 作业，真实执行） ───────────────
    const idempotencyKey = `static-drill-${Date.now()}`;
    const created = await jfetch(base, "/api/v1/gcode/analyses", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode", "Idempotency-Key": idempotencyKey },
      body: GCODE_FIXTURE,
    });
    step(
      "upload-analysis-accepted",
      created.status === 202 && created.json && typeof created.json.jobId === "string",
      `status=${created.status} body=${created.text}`
    );
    evidence.jobId = created.json.jobId;
    const terminal = await waitForJobTerminal(base, evidence.jobId, 60_000);
    step(
      "analysis-succeeded-with-result",
      terminal.status === "succeeded" && terminal.result != null,
      `status=${terminal.status} phase=${terminal.phase}`
    );

    // ── 3. 创建分享 → 撤销（postgres-only，见文件头注释；不可用时如实 skip） ──
    let revokedToken = null;
    let survivorToken = null;
    let survivorRevokeKey = null;
    if (sharesMode.enabled) {
      const shareBody = (title) =>
        JSON.stringify({
          report: { title, verdict: "静态托管单进程实测通过", rowCount: 3, sections: [] },
          question: "单进程部署实测？",
          engine: "local",
        });
      const first = await jfetch(base, "/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: shareBody("drill-share-revoked"),
      });
      step(
        "share-created",
        first.status === 201 && first.json && first.json.token && first.json.revokeKey,
        `status=${first.status} body=${first.text}`
      );
      revokedToken = first.json.token;
      const second = await jfetch(base, "/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: shareBody("drill-share-survivor"),
      });
      step(
        "share-second-created",
        second.status === 201 && second.json && second.json.token,
        `status=${second.status}`
      );
      survivorToken = second.json.token;
      survivorRevokeKey = second.json.revokeKey;
      const page = await jfetch(base, `/share/${revokedToken}`);
      step(
        "share-page-renders",
        page.status === 200 && page.text.includes("drill-share-revoked"),
        `status=${page.status}`
      );
      const revoke = await jfetch(base, `/api/v1/shares/${revokedToken}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revokeKey: first.json.revokeKey }),
      });
      step("share-revoked", revoke.status === 200 && revoke.json && revoke.json.ok === true, `status=${revoke.status}`);
      const gone = await jfetch(base, `/share/${revokedToken}`);
      step("share-revoked-page-404", gone.status === 404, `status=${gone.status}`);
    } else {
      skipStep("share-created", sharesMode.reason);
      skipStep("share-revoked", sharesMode.reason);
    }

    // ── 4. 重启进程（新随机端口，同一 file 存储）：持久化与撤销状态保持 ───────
    await stop(phase1.child);
    phase1 = null;
    phase2 = await spawnApi();
    evidence.secondPid = phase2.child.pid;
    evidence.ports.push(phase2.port);
    const base2 = phase2.baseUrl;

    const persisted = await jfetch(base2, `/api/v1/jobs/${evidence.jobId}`);
    step(
      "restart-job-persisted",
      persisted.status === 200 &&
        persisted.json &&
        persisted.json.status === "succeeded" &&
        persisted.json.result != null,
      `status=${persisted.status} job=${persisted.json && persisted.json.status}`
    );
    const homeAfter = await jfetch(base2, "/");
    step(
      "restart-static-alive",
      homeAfter.status === 200 && homeAfter.text === home.text,
      `status=${homeAfter.status}`
    );
    if (sharesMode.enabled) {
      const stillGone = await jfetch(base2, `/share/${revokedToken}`);
      step("restart-share-revocation-held", stillGone.status === 404, `status=${stillGone.status}`);
      const survivor = await jfetch(base2, `/share/${survivorToken}`);
      step(
        "restart-share-persisted",
        survivor.status === 200 && survivor.text.includes("drill-share-survivor"),
        `status=${survivor.status}`
      );
      const cleanupRevoke = await jfetch(base2, `/api/v1/shares/${survivorToken}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revokeKey: survivorRevokeKey }),
      });
      step("share-cleanup-revoked", cleanupRevoke.status === 200, `status=${cleanupRevoke.status}`);
    } else {
      skipStep("restart-share-revocation-held", sharesMode.reason);
    }
  } finally {
    await stop(phase1 && phase1.child);
    await stop(phase2 && phase2.child);
    safeCleanup(runtimeRoot);
  }

  return { frontendBuild, sharesMode, evidence };
}

main()
  .then(({ frontendBuild, sharesMode, evidence }) => {
    const passed = steps.filter((entry) => entry.result === "pass").length;
    const report = {
      schemaVersion: "1.0",
      generatedAtUtc: new Date().toISOString(),
      result: "pass",
      mode: {
        persistence: "file",
        staticRoot: "repository root (Node cfg.staticRoot equivalent)",
        shares: sharesMode.enabled ? "postgres" : "skipped",
        sharesSkipReason: sharesMode.reason,
      },
      frontendBuild,
      evidence,
      passed,
      skipped: skippedCount,
      total: steps.length,
      steps,
    };
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `static hosting single-process drill PASS: ${passed}/${steps.length} (skipped ${skippedCount})\n`
    );
    process.stdout.write(`${artifactPath}\n`);
  })
  .catch((error) => {
    const passed = steps.filter((entry) => entry.result === "pass").length;
    const report = {
      schemaVersion: "1.0",
      generatedAtUtc: new Date().toISOString(),
      result: "fail",
      error: error && error.message ? error.message : String(error),
      passed,
      skipped: skippedCount,
      total: steps.length,
      steps,
    };
    try {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      /* 报告写盘失败时仍以退出码为准 */
    }
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
