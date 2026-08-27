/* 直连身份与跨语言派生锚点（Partner SSO 退役后的收敛版）集成测试。
 *
 * 用 node:http 起一个假 C# sidecar 记录收到的请求头，验证：
 *   [1] 配置校验：内部信任密钥最小长度、REQUIRE_AUTH 缺 key 时的降级语义；
 *   [2] API Key 直连：Bearer / X-API-Key 两种携带方式都能建任务，
 *       业务代理注入的 tenant/owner 与本地 sha256(key:{id8}) 派生一致——
 *       与 C# 侧 AuthGate 的同一派生断言互为跨语言对齐锚点；
 *   [3] 匿名 IP 身份：默认放行并按 ip:{addr} 派生；REQUIRE_AUTH=1 时 401；
 *   [4] 凭据不泄漏：代理到 sidecar 的请求不携带浏览器 Authorization / Cookie。
 */
"use strict";

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApp } = require("../server/index");
const { getConfig } = require("../server/config");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function throwsMessage(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function opaque(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function keyId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

const INTERNAL_SECRET = "stage82-auth-internal-secret-32-bytes";
const SVC_KEY = "svc-key";

/* 假 C# sidecar：记录 gcode analyze 请求（供身份注入与凭据不泄漏断言）。 */
function createFakeSidecar() {
  const observed = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      observed.push({ method: req.method, url: req.url, headers: req.headers });
      if (req.url.split("?")[0] === "/api/v1/gcode/analyze") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected sidecar request: " + req.url }));
    });
  });
  return { server, observed };
}

async function main() {
  /* ── [1] 配置校验 ─────────────────────────────────────────────── */
  console.log("[1] 直连身份相关配置校验");
  const defaults = getConfig({ gcodeAuthorityUrl: "" });
  check("默认无鉴权（API_KEYS 空）", defaults.apiKeys === "", JSON.stringify(defaults.apiKeys));
  check(
    "内部信任密钥不足 32 字节被拒绝",
    /GCODE_AUTHORITY_INTERNAL_SECRET/.test(
      throwsMessage(() => getConfig({ gcodeAuthorityInternalSecret: "short" })) || ""
    )
  );

  const sidecar = createFakeSidecar();
  const sidecarPort = await listen(sidecar.server);
  const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;

  /* ── [2] API Key 直连与派生锚点 ───────────────────────────────── */
  console.log("[2] API Key 直连身份与 tenant/owner 派生");
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-key-"));
  const keyApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: keyDir,
    apiKeys: SVC_KEY,
    gcodeAuthorityUrl: sidecarOrigin,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  const keyBase = `http://127.0.0.1:${await listen(keyApp.server)}`;
  try {
    const bearerTask = await fetch(keyBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + SVC_KEY },
      body: JSON.stringify({ question: "Bearer 身份", datasourceId: "sample" }),
    });
    check("Bearer 携带可建任务", bearerTask.status === 202 && (await bearerTask.json()).authenticated === true);
    const headerTask = await fetch(keyBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": SVC_KEY },
      body: JSON.stringify({ question: "X-API-Key 身份", datasourceId: "sample" }),
    });
    check("X-API-Key 携带可建任务", headerTask.status === 202 && (await headerTask.json()).authenticated === true);

    // 业务代理：key 身份派生的 tn_/ow_ 与本地 sha256 一致（跨语言对齐锚点，
    // 与 backend/tests/ForgeX.AuthGate 的 apikey-*-caller-derivation 同一字面值）
    const caller = "key:" + keyId(SVC_KEY);
    const gcode = await fetch(keyBase + "/api/v1/gcode/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-gcode",
        Authorization: "Bearer " + SVC_KEY,
        Cookie: "session-probe=1",
      },
      body: "G28\nG1 X1 Y1 E1\n",
    });
    await gcode.text();
    const gcodeSeen = sidecar.observed.filter((item) => item.url.startsWith("/api/v1/gcode/analyze")).at(-1);
    check(
      "key 身份注入的 tenant/owner 与 sha256(key:{id8}) 一致",
      gcodeSeen &&
        gcodeSeen.headers["x-forgex-tenant-id"] === opaque("tn_", caller) &&
        gcodeSeen.headers["x-forgex-owner-id"] === opaque("ow_", caller),
      JSON.stringify(gcodeSeen && { t: gcodeSeen.headers["x-forgex-tenant-id"], o: gcodeSeen.headers["x-forgex-owner-id"] })
    );
    check(
      "业务代理不向 sidecar 泄漏浏览器凭据",
      gcodeSeen && !gcodeSeen.headers.cookie && !gcodeSeen.headers.authorization,
      gcodeSeen && JSON.stringify(gcodeSeen.headers)
    );

    /* ── [3] 匿名 IP 身份 ────────────────────────────────────────── */
    console.log("[3] 匿名 IP 身份（REQUIRE_AUTH=0 放行）");
    const anonGcode = await fetch(keyBase + "/api/v1/gcode/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode" },
      body: "G28\n",
    });
    await anonGcode.text();
    const anonSeen = sidecar.observed.filter((item) => item.url.startsWith("/api/v1/gcode/analyze")).at(-1);
    check(
      "匿名身份按 ip:{addr} 派生",
      anonSeen && anonSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "ip:127.0.0.1"),
      anonSeen && anonSeen.headers["x-forgex-tenant-id"]
    );
  } finally {
    await keyApp.close();
    fs.rmSync(keyDir, { recursive: true, force: true });
  }

  console.log("[4] REQUIRE_AUTH=1 匿名与错误 key 拒绝");
  const requireDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-require-"));
  const requireApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: requireDir,
    apiKeys: SVC_KEY,
    requireAuth: true,
  });
  const requireBase = `http://127.0.0.1:${await listen(requireApp.server)}`;
  try {
    const anon = await fetch(requireBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "匿名", datasourceId: "sample" }),
    });
    const anonBody = await anon.json();
    check(
      "匿名请求被 401 拒绝（与 C# api_key_required 同文案）",
      anon.status === 401 && anonBody.error === "需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供",
      JSON.stringify(anonBody)
    );
    const wrongKey = await fetch(requireBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "not-a-key" },
      body: JSON.stringify({ question: "错误 key", datasourceId: "sample" }),
    });
    check("错误 key 被 401 拒绝", wrongKey.status === 401, wrongKey.status);
    const okKey = await fetch(requireBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": SVC_KEY },
      body: JSON.stringify({ question: "合法 key", datasourceId: "sample" }),
    });
    check("合法 key 照常放行", okKey.status === 202 && (await okKey.json()).authenticated === true);
  } finally {
    await requireApp.close();
    fs.rmSync(requireDir, { recursive: true, force: true });
  }

  await close(sidecar.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  // 不用 process.exit()：硬退出会与 undici keep-alive 套接字的收尾竞态，
  // 在 Windows 触发 libuv 断言（async.c UV_HANDLE_CLOSING）。上面的服务器
  // 已全部关闭，客户端空闲连接随之消亡，事件循环自然排空（同 rules-authority）。
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
