/* 阶段 0 硬化回归：统一身份、资源 owner、内容寻址、指标与文件责任链。 */
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { URLSearchParams } = require("url");
const { createApp } = require("../server/index");
const { resolveIdentity } = require("../server/lib/identity");

if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;
require("../js/gcode-parser.js");
require("../js/machine-log.js");

const CSV = [
  "任务编号,日期,机台,模型,材料,层高,耗时,耗材克重,成本元,状态,故障类型,能耗",
  "S1,2026-08-01,FX-01,支架,PLA,0.2,30,8,1.2,success,,0.1",
  "S2,2026-08-02,FX-02,支架,PLA,0.2,35,9,1.3,失败,堵料,0.2",
].join("\n");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forgex-stage0-"));
}

function listen(app) {
  return new Promise((resolve) => app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port)));
}

async function request(base, url, key, body) {
  const headers = key ? { Authorization: "Bearer " + key } : {};
  const opt = { headers };
  if (body !== undefined) {
    opt.method = "POST";
    headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const response = await fetch(base + url, opt);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* HTML/SSE/text */ }
  return { status: response.status, text, json };
}

async function waitResult(base, taskId, key) {
  for (let i = 0; i < 100; i++) {
    const out = await request(base, "/api/analyze/" + taskId + "/result", key);
    if (out.status !== 202) return out;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not finish: " + taskId);
}

function metric(text, name) {
  const match = text.match(new RegExp("^" + name + "\\s+([0-9.]+)$", "m"));
  return match ? Number(match[1]) : NaN;
}

function noNulBytes(dir) {
  const bad = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bad.push(...noNulBytes(full));
    else if (/\.(js|json|md|html|css)$/.test(entry.name) && fs.readFileSync(full).includes(0)) bad.push(full);
  }
  return bad;
}

async function main() {
  console.log("\n[Stage0-1] 认证优先级");
  const ssoIdentity = resolveIdentity(
    { headers: {} },
    { ip: "127.0.0.1" },
    {
      partnerSSO: { enabled: true, identity: () => ({ user: { id: "u1" }, apiKey: "user-key" }) },
      auth: { identify: () => ({ authenticated: false }), guard: () => ({ status: 401, message: "api" }) },
    }
  );
  assert.strictEqual(ssoIdentity.source, "partner-sso", "有效 SSO 必须先于 API Key 守卫");
  const apiIdentity = resolveIdentity(
    { headers: {} },
    { ip: "127.0.0.1" },
    {
      partnerSSO: { enabled: true, identity: () => null },
      auth: { identify: () => ({ authenticated: true, caller: "key:a" }), guard: () => null },
    }
  );
  assert.strictEqual(apiIdentity.source, "api-key", "双身份模式应允许服务 API Key");
  assert.throws(() => resolveIdentity(
    { headers: {} }, { ip: "127.0.0.1" },
    {
      partnerSSO: { enabled: true, identity: () => null },
      auth: { identify: () => ({ authenticated: false, caller: "ip:x" }), guard: () => null },
    }
  ), (error) => error.status === 401, "SSO-only 模式应拒绝匿名请求");

  console.log("[Stage0-2] owner/tenant、去重、缓存与审计");
  const dataDir = tmpDir();
  const app = createApp({
    apiKeys: "alpha,beta",
    requireAuth: true,
    forceMock: true,
    mockDelayMs: 8,
    rateLimitMs: 0,
    logLevel: "error",
    dataDir,
  });
  const audits = [];
  app.log.warn = (message, fields) => { if (fields && fields.audit) audits.push({ message, fields }); };
  const base = "http://127.0.0.1:" + (await listen(app));
  try {
    const upA1 = await request(base, "/api/datasource", "alpha", { name: "a.csv", csv: CSV });
    const upA2 = await request(base, "/api/datasource", "alpha", { name: "again.csv", csv: CSV });
    const upB = await request(base, "/api/datasource", "beta", { name: "b.csv", csv: CSV });
    assert.strictEqual(upA1.status, 201);
    assert.strictEqual(upA1.json.datasourceId, upA2.json.datasourceId, "同租户同内容 ID 应稳定");
    assert.strictEqual(upA2.json.deduplicated, true);
    assert.strictEqual(upA1.json.sha256, crypto.createHash("sha256").update(app.ctx.datasources.get(upA1.json.datasourceId).csv).digest("hex"));
    assert.notStrictEqual(upA1.json.datasourceId, upB.json.datasourceId, "不同租户业务 ID 必须隔离");

    const crossDatasource = await request(base, "/api/analyze", "beta", {
      question: "故障率", datasourceId: upA1.json.datasourceId,
    });
    assert.strictEqual(crossDatasource.status, 403);

    const kbA = await request(base, "/api/knowledge", "alpha", { name: "a.md", text: "独有工艺词：玄铁层裂" });
    assert.strictEqual(kbA.status, 201);
    const kbSearchB = await request(base, "/api/knowledge/search", "beta", { question: "玄铁层裂" });
    const kbSearchA = await request(base, "/api/knowledge/search", "alpha", { question: "玄铁层裂" });
    assert.strictEqual(kbSearchB.json.docCount, 0);
    assert.strictEqual(kbSearchA.json.docCount, 1);

    const created = await request(base, "/api/analyze", "alpha", {
      question: "哪台机故障率最高", datasourceId: upA1.json.datasourceId,
    });
    assert.strictEqual(created.status, 202);
    const taskId = created.json.taskId;
    const first = await waitResult(base, taskId, "alpha");
    assert.strictEqual(first.status, 200);

    assert.strictEqual((await request(base, "/api/analyze/" + taskId, "beta")).status, 403);
    assert.strictEqual((await request(base, "/api/analyze/" + taskId + "/stream", "beta")).status, 403);
    assert.strictEqual((await request(base, "/api/analyze/" + taskId + "/result", "beta")).status, 403);
    assert.strictEqual((await request(base, "/api/share/" + taskId, "beta", {})).status, 403);

    const metricsAfterFirst = await request(base, "/metrics");
    assert(metric(metricsAfterFirst.text, "forgex_task_duration_ms") > 0, "任务时长指标必须由终态更新");

    const repeated = await request(base, "/api/analyze", "alpha", {
      question: "哪台机故障率最高", datasourceId: upA2.json.datasourceId,
    });
    const repeatedResult = await waitResult(base, repeated.json.taskId, "alpha");
    assert.strictEqual(repeatedResult.json.cached, true, "稳定数据源指纹应恢复结果缓存命中");
    const metricsAfterCache = await request(base, "/metrics");
    assert.strictEqual(metric(metricsAfterCache.text, "forgex_tasks_cached_total"), 1);

    const shared = await request(base, "/api/share/" + taskId, "alpha", {});
    assert.strictEqual(shared.status, 201);
    const crossRevoke = await request(base, "/api/share/" + shared.json.token + "/revoke", "beta", {
      revokeKey: shared.json.revokeKey,
    });
    assert.strictEqual(crossRevoke.status, 403, "撤销密钥不能绕过 owner");
    assert.strictEqual((await request(base, "/api/share/" + shared.json.token + "/revoke", "alpha", {
      revokeKey: shared.json.revokeKey,
    })).status, 200);

    const originalAnalyze = app.ctx.tasks.provider.analyze;
    const originalLogError = app.log.error;
    app.log.error = () => {};
    app.ctx.tasks.provider.analyze = async () => { throw new Error("stage0 forced failure"); };
    const failedTask = await request(base, "/api/analyze", "alpha", { question: "强制失败", datasourceId: "sample" });
    assert.strictEqual((await waitResult(base, failedTask.json.taskId, "alpha")).status, 502);
    app.ctx.tasks.provider.analyze = originalAnalyze;
    app.log.error = originalLogError;
    const metricsAfterFailure = await request(base, "/metrics");
    assert.strictEqual(metric(metricsAfterFailure.text, "forgex_tasks_failed_total"), 1);

    assert(audits.length >= 5, "每次越权拒绝都应产生审计记录");
    assert(audits.every((event) => event.fields.tenantId && event.fields.resourceType));
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log("[Stage0-3] SSO 用户能力与文件责任链");
  const ssoDir = tmpDir();
  const ssoApp = createApp({
    forceMock: true,
    dataDir: ssoDir,
    logLevel: "error",
    infiniPartnerClientId: "client",
    infiniPartnerClientSecret: "secret",
    publicBase: "https://example.test/forgex",
  });
  const ssoBase = "http://127.0.0.1:" + (await listen(ssoApp));
  try {
    ssoApp.ctx.partnerSSO.sessions.set("stage0-session", {
      user: { id: "sso-user", nickname: "Stage0" },
      apiKey: "partner-user-key",
      expiresAt: Date.now() + 60000,
    });
    const health = await fetch(ssoBase + "/healthz", { headers: { Cookie: "fx_session=stage0-session" } });
    const capability = await health.json();
    assert.strictEqual(capability.capabilities.ai, true);
    assert.strictEqual(capability.capabilityScope, "current-user");
  } finally {
    await ssoApp.close();
    fs.rmSync(ssoDir, { recursive: true, force: true });
  }

  const digest = await globalThis.FXGcodeParser.sha256("abc");
  assert.strictEqual(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const verified = globalThis.FXMachineLog.verifyGcodeBinding({ sha256: digest }, { gcodeSha256: digest });
  const mismatch = globalThis.FXMachineLog.verifyGcodeBinding({ sha256: digest }, { gcodeSha256: "a".repeat(64) });
  const missing = globalThis.FXMachineLog.verifyGcodeBinding({ sha256: digest }, {});
  assert.strictEqual(verified.status, "verified");
  assert.strictEqual(mismatch.status, "mismatch");
  assert.strictEqual(missing.status, "missing");

  console.log("[Stage0-4] Delta、file:// 与源码可审计性");
  const uiSource = fs.readFileSync(path.join(__dirname, "..", "js", "ui.js"), "utf8");
  assert(/KIN_TAG \|\| ""\)\.toLowerCase\(\) === "delta"/.test(uiSource), "Delta 标记应大小写归一");
  let authCalls = 0;
  const authSandbox = {
    console,
    location: { protocol: "file:", search: "" },
    document: { readyState: "complete", getElementById: () => null },
    FXApiClient: { base: "", authMe: () => { authCalls++; return Promise.resolve({}); } },
    window: { URLSearchParams },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "js", "auth.js"), "utf8"), authSandbox);
  assert.strictEqual(authCalls, 0, "file:// 启动不应请求认证 API");
  assert.strictEqual(authSandbox.window.FXAuth.integration, "offline");
  assert.deepStrictEqual(noNulBytes(path.join(__dirname, "..", "server")), []);

  console.log("Stage 0 hardening OK: auth/tenant/cache/metrics/SHA/Delta/file/NUL");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
