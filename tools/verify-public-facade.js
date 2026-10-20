/* Stage 8.6d-1 公共门面契约演练：起真实的 ForgeX.Api（PublicFacade:Enabled=true），验证语料级双跑覆盖不到的
   服务器层语义——这些原本都长在 server/index.js 里：
     - CORS：ALLOW_ORIGINS 白名单命中才回 Access-Control-*，OPTIONS 一律 204；
     - 未命中的公共 /api/* 任何方法都 404「接口不存在」，内部 /api/v1/* 仍是 problem+json；
     - 每 IP 冷却限流只作用于 POST /api/analyze，429「请求过于频繁，请 N 秒后重试」；
     - /healthz 是前端探测的 Node 形状；/metrics 含 Node 命名的任务 / AI 系列与资源 gauge；
     - /api/auth/infini/me 墓碑固定 200；
     - REQUIRE_AUTH 下匿名 401 文案与 Node 一致，公开目录不受影响；
     - TRUST_PROXY 下按 X-Forwarded-For 第一跳区分匿名身份，数据源按身份隔离。
   需要 POSTGRES_URL（分析任务只有 postgres provider；FORGEX_DRILL_REQUIRE_ALL=1 时缺库判失败）。
   产物：backend/artifacts/public-facade-contract.json。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const apiDll = path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");
const artifactPath = path.join(root, "backend", "artifacts", "public-facade-contract.json");
const INTERNAL_SECRET = "stage86d-public-facade-internal-secret-" + crypto.randomBytes(8).toString("hex");
const RUN_ID = crypto.randomBytes(4).toString("hex");
const SUBMIT_KEY = `facade-submit-${RUN_ID}`;
const REVIEW_KEY = `facade-review-${RUN_ID}`;
const ALLOWED_ORIGIN = "https://ui.forgex.example";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, pass: !!condition, detail: condition ? undefined : trim(detail) });
  process.stdout.write(`  ${condition ? "PASS  " : "FAIL  "} ${name}${condition ? "" : " " + trim(detail)}\n`);
}
function trim(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "" : text.length > 300 ? text.slice(0, 300) + "…" : text;
}

function dotnetExecutable() {
  const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  return fs.existsSync(local) ? local : "dotnet";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForReady(baseUrl, child, output) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`ForgeX.Api exited ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 启动竞态：限期内重试。
    }
    await sleep(125);
  }
  throw new Error(`ForgeX.Api readiness timed out: ${output.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function spawnFacade(storageRoot, postgresUrl, extraEnv) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const env = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: "Production",
    Kestrel__Endpoints__Http__Url: baseUrl,
    Storage__Root: storageRoot,
    InternalAuth__SharedSecret: INTERNAL_SECRET,
    Calibrations__TenantId: "tn_" + crypto.randomBytes(16).toString("hex"),
    PublicFacade__Enabled: "true",
    PublicFacade__AllowOrigins: ALLOWED_ORIGIN,
    PublicFacade__PublicBase: "https://forgex.example",
    DirectAuth__ApiKeys: `${SUBMIT_KEY},${REVIEW_KEY}`,
    DirectAuth__CalibrationReviewKeys: REVIEW_KEY,
    AnalysisTasks__Provider: "postgres",
    AnalysisTasks__PostgresUrl: postgresUrl,
    ...extraEnv,
  };
  for (const section of ["Datasources", "Knowledge", "Calibrations", "Shares"]) {
    env[`${section}__Provider`] = "postgres";
    env[`${section}__PostgresUrl`] = postgresUrl;
  }
  const child = spawn(dotnetExecutable(), [apiDll], {
    cwd: root,
    windowsHide: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  await waitForReady(baseUrl, child, output);
  return { child, baseUrl, output };
}

async function call(baseUrl, method, pathname, { body, headers } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-public-facade-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  if (!fs.existsSync(apiDll))
    throw new Error(`Release API build missing: ${apiDll} — run \`npm run dotnet:build\` first`);
  const postgresUrl = process.env.POSTGRES_URL || "";
  const requireAll = process.env.FORGEX_DRILL_REQUIRE_ALL === "1";
  if (!postgresUrl) {
    if (requireAll) throw new Error("公共门面演练需要 POSTGRES_URL（分析任务只有 postgres provider）");
    console.log("public facade contract SKIPPED: no POSTGRES_URL");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath,
      JSON.stringify({ schemaVersion: "1.0", skipped: "no POSTGRES_URL", checks: [] }, null, 2) + "\n"
    );
    return;
  }

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-public-facade-"));
  let api = null;
  let strict = null;
  try {
    api = await spawnFacade(path.join(runtimeRoot, "open"), postgresUrl, {
      PublicFacade__RateLimitMs: "60000",
      PublicFacade__TrustProxy: "true",
    });
    const base = api.baseUrl;
    const auth = { Authorization: "Bearer " + SUBMIT_KEY };

    console.log("[1] CORS 与 OPTIONS");
    const preflight = await call(base, "OPTIONS", "/api/analyze", {
      headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    check(
      "允许来源的 OPTIONS → 204 + Access-Control-*",
      preflight.status === 204 &&
        preflight.headers.get("access-control-allow-origin") === ALLOWED_ORIGIN &&
        preflight.headers.get("access-control-allow-methods") === "GET,POST,OPTIONS" &&
        preflight.headers.get("access-control-allow-headers") ===
          "Content-Type, Authorization, X-API-Key, Idempotency-Key, Last-Event-ID" &&
        preflight.headers.get("access-control-max-age") === "600" &&
        preflight.headers.get("vary") === "Origin",
      { status: preflight.status, headers: Object.fromEntries(preflight.headers) }
    );
    const foreignOrigin = await call(base, "OPTIONS", "/api/analyze", { headers: { Origin: "https://evil.example" } });
    check(
      "非白名单来源的 OPTIONS → 204 但不带 CORS 头",
      foreignOrigin.status === 204 && !foreignOrigin.headers.get("access-control-allow-origin"),
      Object.fromEntries(foreignOrigin.headers)
    );
    const corsGet = await call(base, "GET", "/healthz", { headers: { Origin: ALLOWED_ORIGIN } });
    check(
      "普通请求也回 CORS 头",
      corsGet.status === 200 && corsGet.headers.get("access-control-allow-origin") === ALLOWED_ORIGIN,
      corsGet.status
    );

    console.log("[2] 404 / 405 语义");
    const missingGet = await call(base, "GET", "/api/nope");
    const missingPost = await call(base, "POST", "/api/analyze/x/y/z", { body: {} });
    const missingInternal = await call(base, "GET", "/api/v1/nope");
    check(
      "公共 /api/* 未命中 → 404 接口不存在（GET）",
      missingGet.status === 404 && missingGet.json && missingGet.json.error === "接口不存在",
      missingGet.text
    );
    check(
      "公共 /api/* 未命中 → 404 接口不存在（POST）",
      missingPost.status === 404 && missingPost.json && missingPost.json.error === "接口不存在",
      missingPost.text
    );
    check(
      "内部 /api/v1/* 未命中仍是 problem+json",
      missingInternal.status === 404 && (missingInternal.headers.get("content-type") || "").includes("problem+json"),
      [missingInternal.status, missingInternal.headers.get("content-type")]
    );

    console.log("[3] 限流只作用于创建分析");
    const first = await call(base, "POST", "/api/analyze", {
      body: { question: "哪台机器的失败率最高？" },
      headers: auth,
    });
    const second = await call(base, "POST", "/api/analyze", {
      body: { question: "材料与失败率有什么关系" },
      headers: auth,
    });
    check("首个创建 202", first.status === 202 && first.json && /^t_[a-f0-9]{16}$/.test(first.json.taskId), first.text);
    check(
      "冷却期内第二个创建 → 429 请求过于频繁，请 N 秒后重试",
      second.status === 429 && second.json && /^请求过于频繁，请 \d+ 秒后重试$/.test(second.json.error),
      second.text
    );
    const upload = await call(base, "POST", "/api/datasource", {
      body: { csv: "machine,material,status\nM1,PLA,success\nM2,ABS,fail\n" },
      headers: auth,
    });
    check("其它路由不受冷却影响（数据源上传 201）", upload.status === 201, upload.text);

    console.log("[4] /healthz 与 /metrics");
    const health = await call(base, "GET", "/healthz");
    const h = health.json || {};
    check(
      "/healthz 为 Node 形状",
      health.status === 200 &&
        h.ok === true &&
        h.engine === "server-rules" &&
        h.provider === "local" &&
        h.label === "后端规则引擎（无 AI）" &&
        h.capabilities &&
        h.capabilities.ai === false &&
        h.capabilities.structuredOutput === true &&
        h.capabilityScope === "system" &&
        typeof h.reason === "string" &&
        h.quota === null &&
        h.auth &&
        h.auth.enabled === true &&
        h.auth.required === false &&
        h.persistence === "postgres" &&
        h.calibrations &&
        typeof h.calibrations.approved === "number" &&
        h.calibrations.writesEnabled === true &&
        typeof h.now === "number",
      health.text
    );
    // 等首个任务结束再看指标，forgex_tasks_total 才稳定。
    const deadline = Date.now() + 10_000;
    let poll = null;
    while (Date.now() < deadline) {
      poll = await call(base, "GET", "/api/analyze/" + first.json.taskId, { headers: auth });
      if (poll.json && poll.json.status !== "running") break;
      await sleep(50);
    }
    const metrics = await call(base, "GET", "/metrics");
    check(
      "/metrics 含 Node 命名的任务 / AI / 资源系列",
      metrics.status === 200 &&
        metrics.text.includes("forgex_tasks_total 1\n") &&
        metrics.text.includes("forgex_ai_running 0\n") &&
        metrics.text.includes("forgex_ai_daily_limit ") &&
        metrics.text.includes("forgex_datasources ") &&
        metrics.text.includes("forgex_shares ") &&
        metrics.text.includes("forgex_calibrations_approved ") &&
        metrics.text.includes("forgex_http_requests_total"),
      metrics.text
        .split("\n")
        .filter((line) => line.startsWith("forgex_tasks") || line.startsWith("forgex_ai"))
        .join(" | ")
    );

    console.log("[5] 墓碑与身份");
    const tombstone = await call(base, "GET", "/api/auth/infini/me");
    check(
      "/api/auth/infini/me 固定 200 未启用",
      tombstone.status === 200 &&
        tombstone.json &&
        tombstone.json.enabled === false &&
        tombstone.json.integration === "retired",
      tombstone.text
    );
    const asIpA = await call(base, "POST", "/api/datasource", {
      body: { csv: "machine,material,status\nM1,PLA,success\nM2,ABS,fail\n", name: "a.csv" },
      headers: { "X-Forwarded-For": "203.0.113.10" },
    });
    const asIpB = await call(base, "POST", "/api/analyze", {
      body: { question: "x", datasourceId: asIpA.json && asIpA.json.datasourceId },
      headers: { "X-Forwarded-For": "203.0.113.11" },
    });
    const asIpAAgain = await call(base, "POST", "/api/analyze", {
      body: { question: "x", datasourceId: asIpA.json && asIpA.json.datasourceId },
      headers: { "X-Forwarded-For": "203.0.113.10" },
    });
    check(
      "TRUST_PROXY：匿名身份按 X-Forwarded-For 第一跳隔离（他人 IP 看不到我的数据源）",
      asIpA.status === 201 &&
        asIpB.status === 404 &&
        asIpB.json.error === "数据源不存在或已过期，请重新上传" &&
        asIpAAgain.status === 202 &&
        asIpAAgain.json.authenticated === false,
      [asIpA.status, asIpB.text, asIpAAgain.text]
    );

    console.log("[6] REQUIRE_AUTH");
    strict = await spawnFacade(path.join(runtimeRoot, "strict"), postgresUrl, {
      DirectAuth__RequireAuth: "true",
      PublicFacade__RateLimitMs: "0",
    });
    const anonymous = await call(strict.baseUrl, "POST", "/api/datasource", { body: { csv: "a,b\n1,2\n" } });
    const keyed = await call(strict.baseUrl, "POST", "/api/datasource", {
      body: { csv: "machine,material,status\nM1,PLA,success\n" },
      headers: auth,
    });
    const catalog = await call(strict.baseUrl, "GET", "/api/calibrations");
    const strictHealth = await call(strict.baseUrl, "GET", "/healthz");
    check(
      "匿名 → 401 需要 API Key 文案",
      anonymous.status === 401 &&
        anonymous.json &&
        anonymous.json.error === "需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供",
      anonymous.text
    );
    check("持 key → 201", keyed.status === 201, keyed.text);
    check("公开校准目录不受 REQUIRE_AUTH 影响", catalog.status === 200, catalog.text);
    check(
      "/healthz auth.required=true",
      strictHealth.json && strictHealth.json.auth && strictHealth.json.auth.required === true,
      strictHealth.text
    );
  } finally {
    if (api) await stop(api.child);
    if (strict) await stop(strict.child);
    safeCleanup(runtimeRoot);
  }

  const failed = checks.filter((item) => !item.pass).length;
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      { schemaVersion: "1.0", generatedAtUtc: new Date().toISOString(), total: checks.length, failed, checks },
      null,
      2
    ) + "\n"
  );
  console.log(`public facade contract ${failed === 0 ? "PASS" : "FAIL"}: ${checks.length - failed}/${checks.length}`);
  console.log(`report=${path.relative(root, artifactPath)}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
