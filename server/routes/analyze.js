/* 分析任务路由：建任务（限流）/ SSE 进度流 / 结果获取。 */
"use strict";
const { HttpError, readJson, sendJson, sseStart } = require("../lib/http");
const { resolveIdentity, requireOwner } = require("../lib/identity");

const MAX_QUESTION = 500;

function register(router, ctx) {
  const { tasks, datasources, knowledge, log, gate, metrics } = ctx;

  router.add("POST", /^\/api\/analyze$/, async (req, res, m, rc) => {
    // 先统一 SSO/API Key 身份，再做限流和资源授权；有效 SSO 不再被 API Key 守卫误拒。
    const identity = await resolveIdentity(req, rc, ctx);
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
    const identity = await resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    requireOwner({ owner: task.caller, ownerId: task.ownerId }, identity, ctx, "analysis-task", task.id);
    sseStart(res);
    const unsubscribe = tasks.subscribe(task, res);
    req.on("close", unsubscribe);
  });

  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)\/result$/, async (req, res, m, rc) => {
    const identity = await resolveIdentity(req, rc, ctx);
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
    const identity = await resolveIdentity(req, rc, ctx);
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
