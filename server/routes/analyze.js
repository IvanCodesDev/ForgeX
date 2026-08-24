/* 分析任务路由：建任务（限流）/ SSE 进度流 / 结果获取。

   Stage 8.3（V2.0 手册 §4.2）：ANALYSIS_AUTHORITY=csharp 时，规则腿任务
   （不使用 AI 的确定性统计分析）的创建与计算迁到 ForgeX.Api——本文件保留
   身份/限流/数据源归属校验，把已归一化的行连同匿名化租户上下文转发给
   POST /api/v1/analysis-tasks；C# 逐事件 UPSERT 共享 PostgreSQL 行后返回
   终态快照，Node 收编进 TaskStore，既有 SSE / 结果 / 轮询路由原样服务。
   AI 叙述腿（Partner SSO / OpenAI 兼容）始终留在 Node：provider 密钥不出本进程。
   ANALYSIS_AUTHORITY=node（默认）保持既有行为，作为回滚开关。

   Stage 8.4：DATASOURCES_READ_AUTHORITY=csharp 时，持久化数据源不再内联全量
   行——代理只发 { schemaVersion, question, datasourceId }，行数据由 C# 在同一
   匿名化租户上下文（RLS GUC）下从共享 forgex.datasources 读取。Node 仍先做
   轻量归属校验（不存在/越权在本进程就 404/403）。内置 sample 只存在于 Node
   内存，任何模式下都继续走 Stage 8.3 内联行载荷。
   DATASOURCES_READ_AUTHORITY=node（默认）保持 Stage 8.3 行为，作为回滚开关。 */
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { HttpError, readJson, sendJson, sseStart } = require("../lib/http");
const { resolveIdentity, requireOwner } = require("../lib/identity");
const { authorityRow } = require("../services/providers");

const MAX_QUESTION = 500;

/* 与 gcode-authority.js / share.js 一致的匿名化上下文：C# 只见哈希后的 tenant/owner。 */
function opaqueContextId(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/* 小体量 JSON 调用（规则腿数据集在 KB～MB 级），不做流式。 */
function authorityRequest(cfg, identity, method, pathname, payload) {
  const target = new URL(pathname, cfg.gcodeAuthorityUrl);
  const transport = target.protocol === "https:" ? https : http;
  const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
  const headers = { accept: "application/json" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  if (cfg.gcodeAuthorityInternalSecret && identity) {
    headers["x-forgex-internal-token"] = cfg.gcodeAuthorityInternalSecret;
    headers["x-forgex-tenant-id"] = opaqueContextId("tn_", identity.tenantId);
    headers["x-forgex-owner-id"] = opaqueContextId("ow_", identity.caller);
  }
  return new Promise((resolve, reject) => {
    const upstream = transport.request(target, { method, headers, timeout: cfg.analysisAuthorityTimeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 502,
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("analysis authority timeout")));
    upstream.on("error", reject);
    if (body) upstream.write(body);
    upstream.end();
  });
}

function parseAuthorityJson(response) {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return null;
  }
}

function register(router, ctx) {
  const { tasks, datasources, knowledge, log, gate, metrics, cfg } = ctx;
  const csharp = cfg.analysisAuthority === "csharp";

  router.add("POST", /^\/api\/analyze$/, async (req, res, m, rc) => {
    // 先统一 SSO/API Key 身份，再做限流和资源授权；有效 SSO 不再被 API Key 守卫误拒。
    const identity = resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const partnerIdentity = identity.partner;
    if (partnerIdentity && !partnerIdentity.apiKey) {
      throw new HttpError(409, "该账号未能签发 Partner API Key，请清理 InfiniSynapse API Key 后重新登录");
    }

    ctx.rateLimit(rc.ip); // 同 IP 冷却，防刷
    const body = await readJson(req, 8 * 1024);
    const question = String(body.question || "").trim();
    if (!question) throw new HttpError(400, "question 不能为空");
    if (question.length > MAX_QUESTION) throw new HttpError(400, "question 超过 " + MAX_QUESTION + " 字");
    const ds = await datasources.get(body.datasourceId || "sample", identity.tenantId);
    if (!ds) throw new HttpError(404, "数据源不存在或已过期，请重新上传");
    if (!ds.builtin) requireOwner(ds, identity, ctx, "datasource", ds.id);
    if (typeof knowledge.ready === "function") await knowledge.ready(identity.tenantId);

    // 配额预检：提前把「会不会降级」告诉调用方，而不是等报告出来才发现没有 AI 叙述
    const willUseAi = !!(partnerIdentity || tasks.usesAi);
    const quota = willUseAi && gate ? gate.check(identity.caller) : { ok: true };

    // Stage 8.3：规则腿迁 C#。AI 腿（含额度耗尽的降级路径）留在 Node——
    // 降级文案与配额语义是 Node 的编排职责，provider 密钥也不出本进程。
    if (csharp && !willUseAi) {
      // Stage 8.4：持久化数据源只发 datasourceId，C# 按 RLS 上下文自行读行；
      // 内置 sample（仅存于 Node 内存）与回滚开关 node 仍内联全量行。
      const slimPayload = cfg.datasourcesReadAuthority === "csharp" && !ds.builtin;
      let response;
      try {
        response = await authorityRequest(cfg, identity, "POST", "/api/v1/analysis-tasks", slimPayload
          ? {
            schemaVersion: "1.0",
            question,
            datasourceId: ds.id,
          }
          : {
            schemaVersion: "1.0",
            question,
            datasourceId: ds.id,
            rows: (ds.rows || []).map(authorityRow),
            provenance: null,
          });
      } catch (error) {
        log.warn("analysis authority create failed", { reqId: rc.reqId, error: error.message });
        throw new HttpError(502, "分析服务暂不可用，请稍后再试");
      }
      // 竞态兜底：Node 校验后数据源在 C# 读取前过期/被清理 → 与本地 404 同语义。
      if (slimPayload && response.status === 404) {
        throw new HttpError(404, "数据源不存在或已过期，请重新上传");
      }
      const parsed = parseAuthorityJson(response);
      if (response.status !== 201 || !parsed || !parsed.task || !parsed.task.id) {
        log.warn("analysis authority create rejected", { reqId: rc.reqId, status: response.status });
        throw new HttpError(502, "分析服务暂不可用，请稍后再试");
      }
      const task = tasks.adopt({
        id: parsed.task.id,
        question: parsed.task.question,
        datasourceId: parsed.task.datasourceId,
        engine: parsed.task.engine,
        provider: parsed.task.provider,
        credentialScope: identity.tenantId,
        status: parsed.task.status,
        events: parsed.events,
        report: parsed.task.report || null,
        error: parsed.task.error || null,
        upstreamTaskId: parsed.task.upstreamTaskId || null,
        caller: identity.tenantId,
        tenantId: opaqueContextId("tn_", identity.tenantId),
        ownerId: opaqueContextId("ow_", identity.caller),
        createdAt: Date.parse(parsed.task.createdAtUtc) || Date.now(),
        finishedAt: Date.parse(parsed.task.finishedAtUtc) || Date.now(),
      });
      metrics.tasks++;
      log.info("task adopted from csharp authority", {
        reqId: rc.reqId,
        taskId: task.id,
        status: task.status,
        datasourceId: ds.id,
        rows: ds.rows.length,
        payload: slimPayload ? "datasource-id" : "rows",
      });
      sendJson(res, 202, {
        taskId: task.id,
        engine: task.engine,
        authenticated: identity.authenticated,
        willUseAi: false,
        quota: null,
      });
      return;
    }

    const task = tasks.create(question, ds, rc.reqId, {
      caller: identity.caller,
      infiniKey: partnerIdentity ? partnerIdentity.apiKey : "",
      credentialScope: identity.tenantId,
    });
    if (typeof tasks.persist === "function") await tasks.persist(task);
    metrics.tasks++;

    sendJson(res, 202, {
      taskId: task.id,
      engine: task.engine,
      authenticated: identity.authenticated,
      willUseAi: !!(willUseAi && quota.ok),
      quota:
        willUseAi && gate
          ? { ok: quota.ok, remaining: quota.remaining === Infinity ? null : quota.remaining, reason: quota.reason }
          : null,
    });
  });

  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)\/stream$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    requireOwner({ owner: task.caller, ownerId: task.ownerId }, identity, ctx, "analysis-task", task.id);
    sseStart(res);
    const unsubscribe = tasks.subscribe(task, res);
    req.on("close", unsubscribe);
  });

  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)\/result$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    requireOwner({ owner: task.caller, ownerId: task.ownerId }, identity, ctx, "analysis-task", task.id);
    if (task.status === "running") return sendJson(res, 202, { status: "running" });
    if (task.status === "failed") return sendJson(res, 502, { error: task.error || "分析失败" });
    sendJson(res, 200, task.report);
  });

  // 轮询兜底（SSE 不可用的网络环境，doc §4.2「优雅降级」）
  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    requireOwner({ owner: task.caller, ownerId: task.ownerId }, identity, ctx, "analysis-task", task.id);
    const last = task.events[task.events.length - 1] || null;
    sendJson(res, 200, {
      taskId: task.id,
      status: task.status,
      engine: task.engine,
      progress: last ? last.progress || 0 : 0,
      message: last ? last.message : "",
      error: task.error || undefined,
    });
  });

  log.debug("routes registered", { scope: "analyze" });
}

module.exports = { register };
