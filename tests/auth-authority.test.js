/* Stage 8.2 Partner SSO 与会话权威切流（AUTH_AUTHORITY=node|csharp）集成测试。
 *
 * 用 node:http 起一个假 C# sidecar，按 backend/src/ForgeX.Api/PartnerSsoService.cs 与
 * PartnerSsoEndpoints.cs 仿真 5 个端点（login/callback/me/logout + 内部会话解析），
 * 并记录收到的请求（方法 / 路径 / 请求头）供断言。
 *
 * 覆盖五类场景：
 *   [1] 配置校验：AUTH_AUTHORITY / AUTH_AUTHORITY_TIMEOUT_MS 的默认值、归一化、
 *       非法取值与「csharp 模式缺 GCODE_AUTHORITY_URL / 内部密钥」的报错文案；
 *   [2] 默认 node 模式：本地内存会话照常工作，假 sidecar 收到 0 个鉴权请求；
 *   [3] csharp 透明代理：四条 /api/auth/infini/* 路由的状态码 / Location /
 *       Set-Cookie（含多值）/ 响应体逐字节透传，凭据不泄漏；业务路由经内部信任
 *       通道反查会话，SSO 身份派生的 tn_/ow_ 与本地 sha256 计算一致（与 C# 侧
 *       AuthGate 的同一派生断言互为跨语言对齐锚点）；双身份优先级、未知会话回退；
 *   [4] 错误路径：会话解析 404/500/非 JSON、sidecar 不可达时携带会话的请求
 *       fail-closed（502），无会话请求不受影响，healthz 不因此失败；
 *   [5] csharp 模式但 Node 侧未配置 Partner 凭据：SSO 判定关闭，零会话反查。
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

const INTERNAL_SECRET = "stage82-auth-internal-secret-32-bytes";
const PARTNER = {
  infiniPartnerClientId: "partner_test",
  infiniPartnerClientSecret: "psk_test",
  publicBase: "https://example.com/projects/forgex",
};
const SESSION_USER = { id: "u_1", nickname: "会话用户", email: "u@example.com", avatar: "" };
const FAKE_ME_BODY = JSON.stringify({
  enabled: true,
  authenticated: false,
  user: null,
  canUseAi: false,
  integration: "InfiniSynapse Partner SSO (B)",
});

/* 假 C# sidecar：仿真 PartnerSsoEndpoints 的 5 个端点 + gcode analyze（供业务代理断言）。 */
function createFakeSidecar() {
  const observed = [];
  const state = { behaveSession: null };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers };
      observed.push(record);
      const pathname = req.url.split("?")[0];
      const json = (status, payload, headers) => {
        const body = typeof payload === "string" ? payload : JSON.stringify(payload);
        res.writeHead(status, Object.assign({ "content-type": "application/json; charset=utf-8" }, headers));
        res.end(body);
      };

      if (pathname === "/api/auth/infini/login") {
        res.writeHead(302, {
          location: "https://app.infinisynapse.cn/auth/entry?session=ps_proxy",
          "cache-control": "no-store",
          "set-cookie": "fx_oauth=nonce-from-csharp; Path=/projects/forgex/; HttpOnly; SameSite=Lax; Secure; Max-Age=600",
        });
        res.end();
        return;
      }
      if (pathname === "/api/auth/infini/callback") {
        res.writeHead(302, {
          location: "https://example.com/projects/forgex/?login=success",
          "cache-control": "no-store",
          "set-cookie": [
            "fx_session=sso-token-1; Path=/projects/forgex/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800",
            "fx_oauth=; Path=/projects/forgex/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
          ],
        });
        res.end();
        return;
      }
      if (pathname === "/api/auth/infini/me") {
        json(200, FAKE_ME_BODY);
        return;
      }
      if (pathname === "/api/auth/infini/logout") {
        json(200, { ok: true }, {
          "set-cookie": "fx_session=; Path=/projects/forgex/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
        });
        return;
      }
      if (pathname === "/api/v1/auth/infini/session") {
        if (state.behaveSession && state.behaveSession(req, res, record)) return;
        if (record.headers["x-forgex-internal-token"] !== INTERNAL_SECRET) {
          json(401, { title: "Trusted sidecar caller context is required" });
          return;
        }
        const token = record.headers["x-forgex-session-token"] || "";
        if (token === "sso-token-1") {
          json(200, { user: SESSION_USER, apiKey: "sk-user-1" });
          return;
        }
        json(404, { title: "Partner SSO session not found or expired" });
        return;
      }
      if (pathname === "/api/v1/gcode/analyze") {
        json(200, { ok: true });
        return;
      }
      json(501, { error: "unexpected sidecar request: " + req.url });
    });
  });
  const sessionLookups = () => observed.filter((item) => item.url.startsWith("/api/v1/auth/infini/session")).length;
  const authProxied = () => observed.filter((item) => item.url.startsWith("/api/auth/")).length;
  return { server, observed, state, sessionLookups, authProxied };
}

async function main() {
  /* ── [1] 配置校验 ─────────────────────────────────────────────── */
  console.log("[1] AUTH_AUTHORITY 配置校验");
  const defaults = getConfig({ gcodeAuthorityUrl: "" });
  check("默认 authAuthority=node", defaults.authAuthority === "node", defaults.authAuthority);
  check("默认超时 15000ms", defaults.authAuthorityTimeoutMs === 15000, String(defaults.authAuthorityTimeoutMs));
  check(
    "非法取值被拒绝",
    throwsMessage(() => getConfig({ authAuthority: "python" })) === "AUTH_AUTHORITY must be node or csharp"
  );
  check(
    "csharp 模式缺 GCODE_AUTHORITY_URL 被拒绝",
    /GCODE_AUTHORITY_URL/.test(throwsMessage(() => getConfig({ authAuthority: "csharp", gcodeAuthorityUrl: "" })) || "")
  );
  check(
    "csharp 模式缺内部密钥被拒绝",
    /GCODE_AUTHORITY_INTERNAL_SECRET/.test(
      throwsMessage(() =>
        getConfig({
          authAuthority: "csharp",
          gcodeAuthorityUrl: "http://127.0.0.1:65000",
          gcodeAuthorityInternalSecret: "",
        })
      ) || ""
    )
  );
  const normalized = getConfig({
    authAuthority: "  CSHARP  ",
    authAuthorityTimeoutMs: 0,
    gcodeAuthorityUrl: "http://127.0.0.1:65000",
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  check("取值归一化（大小写/空白）", normalized.authAuthority === "csharp", normalized.authAuthority);
  check("超时下限收敛到 1ms", normalized.authAuthorityTimeoutMs === 1, String(normalized.authAuthorityTimeoutMs));

  /* ── [2] 默认 node 模式：本地会话 + 零 sidecar 鉴权流量 ───────── */
  console.log("[2] 默认 node 模式行为不变");
  const sidecar = createFakeSidecar();
  const sidecarPort = await listen(sidecar.server);
  const sidecarOrigin = `http://127.0.0.1:${sidecarPort}`;

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-node-"));
  const nodeApp = createApp(
    Object.assign({}, PARTNER, {
      logLevel: "error",
      forceMock: true,
      rateLimitMs: 0,
      dataDir: nodeDir,
      apiKeys: "svc-key",
      gcodeAuthorityUrl: sidecarOrigin,
      gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    })
  );
  const nodeBase = `http://127.0.0.1:${await listen(nodeApp.server)}`;
  try {
    nodeApp.ctx.partnerSSO.sessions.set("local-session", {
      user: { id: "local-user", nickname: "本地" },
      apiKey: "sk-local",
      expiresAt: Date.now() + 60000,
    });
    const localMe = await fetch(nodeBase + "/api/auth/infini/me", { headers: { Cookie: "fx_session=local-session" } });
    const localMeBody = await localMe.json();
    check("node 模式本地会话 me 认证成功", localMe.status === 200 && localMeBody.authenticated === true);
    const localTask = await fetch(nodeBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=local-session" },
      body: JSON.stringify({ question: "本地会话身份", datasourceId: "sample" }),
    });
    check("node 模式本地会话可建任务", localTask.status === 202 && (await localTask.json()).authenticated === true);
    check("node 模式 sidecar 零鉴权流量", sidecar.authProxied() === 0 && sidecar.sessionLookups() === 0);
  } finally {
    await nodeApp.close();
    fs.rmSync(nodeDir, { recursive: true, force: true });
  }

  /* ── [3] csharp 透明代理 ──────────────────────────────────────── */
  console.log("[3] AUTH_AUTHORITY=csharp 透明代理与会话反查");
  const csharpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-csharp-"));
  const csharpApp = createApp(
    Object.assign({}, PARTNER, {
      logLevel: "error",
      forceMock: true,
      rateLimitMs: 0,
      dataDir: csharpDir,
      apiKeys: "svc-key",
      authAuthority: "csharp",
      gcodeAuthorityUrl: sidecarOrigin,
      gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    })
  );
  const csharpBase = `http://127.0.0.1:${await listen(csharpApp.server)}`;
  try {
    const login = await fetch(csharpBase + "/api/auth/infini/login?returnTo=%2Freact%2F", {
      redirect: "manual",
      headers: { Cookie: "fx_probe=1", Authorization: "Bearer svc-key", "X-API-Key": "svc-key" },
    });
    const loginSeen = sidecar.observed.find((item) => item.url.startsWith("/api/auth/infini/login"));
    check("login 代理保留原始路径与 query", loginSeen && loginSeen.url === "/api/auth/infini/login?returnTo=%2Freact%2F");
    check("login 代理透传 302 与 Location", login.status === 302 && login.headers.get("location") === "https://app.infinisynapse.cn/auth/entry?session=ps_proxy");
    check("login 代理透传 Set-Cookie", /fx_oauth=nonce-from-csharp/.test(login.headers.get("set-cookie") || ""));
    check("login 代理转发浏览器 cookie", loginSeen.headers.cookie === "fx_probe=1");
    check(
      "login 代理不泄漏 API Key 凭据",
      !loginSeen.headers.authorization && !loginSeen.headers["x-api-key"]
    );

    const callback = await fetch(csharpBase + "/api/auth/infini/callback?code=ac_1&state=st_1", {
      redirect: "manual",
      headers: { Cookie: "fx_oauth=nonce-from-csharp" },
    });
    const callbackCookies = callback.headers.getSetCookie();
    check("callback 代理透传成功跳转", callback.status === 302 && /login=success/.test(callback.headers.get("location") || ""));
    check(
      "callback 代理透传多值 Set-Cookie",
      callbackCookies.length === 2 && /fx_session=sso-token-1/.test(callbackCookies[0]) && /fx_oauth=;/.test(callbackCookies[1]),
      JSON.stringify(callbackCookies)
    );

    const me = await fetch(csharpBase + "/api/auth/infini/me", { headers: { Cookie: "fx_session=sso-token-1" } });
    check("me 代理逐字节透传响应体", me.status === 200 && (await me.text()) === FAKE_ME_BODY);

    const logout = await fetch(csharpBase + "/api/auth/infini/logout", { method: "POST" });
    check(
      "logout 代理透传响应与清 cookie",
      logout.status === 200 && (await logout.json()).ok === true && /fx_session=;/.test(logout.headers.get("set-cookie") || "")
    );

    // 会话反查：业务路由以 SSO 身份创建任务
    const lookupsBefore = sidecar.sessionLookups();
    const ssoTask = await fetch(csharpBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=sso-token-1" },
      body: JSON.stringify({ question: "SSO 会话身份", datasourceId: "sample" }),
    });
    const ssoTaskBody = await ssoTask.json();
    check("csharp 模式 SSO 会话可建任务", ssoTask.status === 202 && ssoTaskBody.authenticated === true, JSON.stringify(ssoTaskBody));
    const sessionSeen = sidecar.observed.filter((item) => item.url.startsWith("/api/v1/auth/infini/session")).at(-1);
    check(
      "会话反查走内部信任通道",
      sessionSeen &&
        sessionSeen.headers["x-forgex-internal-token"] === INTERNAL_SECRET &&
        sessionSeen.headers["x-forgex-session-token"] === "sso-token-1"
    );
    check(
      "会话反查不转发完整 cookie 与凭据",
      sessionSeen && !sessionSeen.headers.cookie && !sessionSeen.headers.authorization
    );
    check("携带会话的请求才触发反查", sidecar.sessionLookups() > lookupsBefore);

    // 业务代理：SSO 身份派生的 tn_/ow_ 与本地 sha256 一致（跨语言对齐锚点）
    const gcode = await fetch(csharpBase + "/api/v1/gcode/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode", Cookie: "fx_session=sso-token-1" },
      body: "G28\nG1 X1 Y1 E1\n",
    });
    await gcode.text();
    const gcodeSeen = sidecar.observed.filter((item) => item.url.startsWith("/api/v1/gcode/analyze")).at(-1);
    check(
      "SSO 身份注入的 tenant/owner 与 sha256(infini:u_1) 一致",
      gcodeSeen &&
        gcodeSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "infini:u_1") &&
        gcodeSeen.headers["x-forgex-owner-id"] === opaque("ow_", "infini:u_1"),
      JSON.stringify(gcodeSeen && { t: gcodeSeen.headers["x-forgex-tenant-id"], o: gcodeSeen.headers["x-forgex-owner-id"] })
    );
    check("业务代理不向 sidecar 泄漏会话 cookie", gcodeSeen && !gcodeSeen.headers.cookie);

    // 双身份：有效会话优先于有效 API Key
    const dual = await fetch(csharpBase + "/api/v1/gcode/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode", Cookie: "fx_session=sso-token-1", "X-API-Key": "svc-key" },
      body: "G28\n",
    });
    await dual.text();
    const dualSeen = sidecar.observed.filter((item) => item.url.startsWith("/api/v1/gcode/analyze")).at(-1);
    check(
      "双身份下 SSO 会话优先于 API Key",
      dualSeen && dualSeen.headers["x-forgex-tenant-id"] === opaque("tn_", "infini:u_1")
    );

    // 未知/过期会话：SSO 启用下无其他凭据 → 401；有 API Key → 回退 key 身份
    const expired = await fetch(csharpBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=unknown-token" },
      body: JSON.stringify({ question: "过期会话", datasourceId: "sample" }),
    });
    const expiredBody = await expired.json();
    check(
      "未知会话且无凭据被 401 拒绝",
      expired.status === 401 && expiredBody.error === "请使用 InfiniSynapse 登录或提供有效 API Key",
      JSON.stringify(expiredBody)
    );
    const fallback = await fetch(csharpBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=unknown-token", "X-API-Key": "svc-key" },
      body: JSON.stringify({ question: "回退 key 身份", datasourceId: "sample" }),
    });
    check("未知会话回退到有效 API Key", fallback.status === 202 && (await fallback.json()).authenticated === true);

    /* ── [4] 错误路径 ──────────────────────────────────────────── */
    console.log("[4] 错误路径：会话服务异常 fail-closed");
    sidecar.state.behaveSession = (req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
      return true;
    };
    const broken = await fetch(csharpBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=sso-token-1" },
      body: JSON.stringify({ question: "会话服务 500", datasourceId: "sample" }),
    });
    const brokenBody = await broken.json();
    check(
      "会话解析 500 → 502 fail-closed",
      broken.status === 502 && brokenBody.error === "InfiniSynapse 登录服务暂时不可用",
      JSON.stringify(brokenBody)
    );
    sidecar.state.behaveSession = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not-json");
      return true;
    };
    const malformed = await fetch(csharpBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=sso-token-1" },
      body: JSON.stringify({ question: "会话响应损坏", datasourceId: "sample" }),
    });
    check("会话解析非 JSON → 502 fail-closed", malformed.status === 502);
    sidecar.state.behaveSession = null;
  } finally {
    await csharpApp.close();
    fs.rmSync(csharpDir, { recursive: true, force: true });
  }

  // sidecar 不可达：携带会话 fail-closed，无会话请求与 healthz 不受影响
  const deadServer = http.createServer(() => {});
  const deadPort = await listen(deadServer);
  await close(deadServer);
  const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-dead-"));
  const deadApp = createApp(
    Object.assign({}, PARTNER, {
      logLevel: "error",
      forceMock: true,
      rateLimitMs: 0,
      dataDir: deadDir,
      apiKeys: "svc-key",
      authAuthority: "csharp",
      gcodeAuthorityUrl: `http://127.0.0.1:${deadPort}`,
      gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    })
  );
  const deadBase = `http://127.0.0.1:${await listen(deadApp.server)}`;
  try {
    const deadLogin = await fetch(deadBase + "/api/auth/infini/login", { redirect: "manual" });
    const deadLoginBody = await deadLogin.json();
    check(
      "sidecar 不可达时登录代理 502",
      deadLogin.status === 502 && deadLoginBody.error === "InfiniSynapse 登录服务暂时不可用",
      JSON.stringify(deadLoginBody)
    );
    const deadSession = await fetch(deadBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "fx_session=sso-token-1" },
      body: JSON.stringify({ question: "不可达", datasourceId: "sample" }),
    });
    check("sidecar 不可达时携带会话 fail-closed 502", deadSession.status === 502);
    const deadKeyOnly = await fetch(deadBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "svc-key" },
      body: JSON.stringify({ question: "无会话不受影响", datasourceId: "sample" }),
    });
    check("无会话请求不受 sidecar 故障影响", deadKeyOnly.status === 202);
    const deadHealth = await fetch(deadBase + "/healthz", { headers: { Cookie: "fx_session=sso-token-1" } });
    check("healthz 不因会话服务故障失败", deadHealth.status === 200 && (await deadHealth.json()).ok === true);
  } finally {
    await deadApp.close();
    fs.rmSync(deadDir, { recursive: true, force: true });
  }

  /* ── [5] csharp 模式但 Node 侧未配置 Partner 凭据 ─────────────── */
  console.log("[5] csharp 模式 + SSO 未启用");
  const lookupsBeforeDisabled = sidecar.sessionLookups();
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-auth-disabled-"));
  const disabledApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: disabledDir,
    apiKeys: "svc-key",
    authAuthority: "csharp",
    gcodeAuthorityUrl: sidecarOrigin,
    gcodeAuthorityInternalSecret: INTERNAL_SECRET,
  });
  const disabledBase = `http://127.0.0.1:${await listen(disabledApp.server)}`;
  try {
    const keyTask = await fetch(disabledBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "svc-key", Cookie: "fx_session=sso-token-1" },
      body: JSON.stringify({ question: "SSO 关闭走 key", datasourceId: "sample" }),
    });
    check("SSO 未启用时 API Key 身份照常", keyTask.status === 202 && (await keyTask.json()).authenticated === true);
    check("SSO 未启用时零会话反查", sidecar.sessionLookups() === lookupsBeforeDisabled);
  } finally {
    await disabledApp.close();
    fs.rmSync(disabledDir, { recursive: true, force: true });
  }

  await close(sidecar.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  // 与 server.test.js 同理：fetch keep-alive 连接会拖住事件循环，显式退出。
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
