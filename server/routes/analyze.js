/* 分析任务路由：建任务（限流）/ SSE 进度流 / 结果获取。 */
"use strict";
const { HttpError, readJson, sendJson, sseStart } = require("../lib/http");

const MAX_QUESTION = 500;

function register(router, ctx) {
  const { tasks, datasources, log, auth, gate, metrics } = ctx;

  router.add("POST", /^\/api\/analyze$/, async (req, res, m, rc) => {
    // 身份先于限流：带合法 key 的调用方按 key 计费，否则按 IP
    const identity = auth.identify(req, rc.ip);
    const denied = auth.guard(identity);
    if (denied) throw new HttpError(denied.status, denied.message);

    ctx.rateLimit(rc.ip);   // 同 IP 冷却，防刷
    const body = await readJson(req, 8 * 1024);
    const question = String(body.question || "").trim();
    if (!question) throw new HttpError(400, "question 不能为空");
    if (question.length > MAX_QUESTION) throw new HttpError(400, "question 超过 " + MAX_QUESTION + " 字");
    const ds = datasources.get(body.datasourceId || "sample");
    if (!ds) throw new HttpError(404, "数据源不存在或已过期，请重新上传");

    // 配额预检：提前把「会不会降级」告诉调用方，而不是等报告出来才发现没有 AI 叙述
    const quota = tasks.usesAi && gate ? gate.check(identity.caller) : { ok: true };
    const task = tasks.create(question, ds, rc.reqId, { caller: identity.caller });
    metrics.tasks++;

    sendJson(res, 202, {
      taskId: task.id,
      engine: task.engine,
      authenticated: identity.authenticated,
      willUseAi: !!(tasks.usesAi && quota.ok),
      quota: tasks.usesAi && gate
        ? { ok: quota.ok, remaining: quota.remaining === Infinity ? null : quota.remaining, reason: quota.reason }
        : null,
    });
  });

  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)\/stream$/, (req, res, m) => {
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    sseStart(res);
    const unsubscribe = tasks.subscribe(task, res);
    req.on("close", unsubscribe);
  });

  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)\/result$/, (req, res, m) => {
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    if (task.status === "running") return sendJson(res, 202, { status: "running" });
    if (task.status === "failed") return sendJson(res, 502, { error: task.error || "分析失败" });
    sendJson(res, 200, task.report);
  });

  // 轮询兜底（SSE 不可用的网络环境，doc §4.2「优雅降级」）
  router.add("GET", /^\/api\/analyze\/([A-Za-z0-9_]+)$/, (req, res, m) => {
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    const last = task.events[task.events.length - 1] || null;
    sendJson(res, 200, {
      taskId: task.id, status: task.status, engine: task.engine,
      progress: last ? last.progress || 0 : 0,
      message: last ? last.message : "",
      error: task.error || undefined,
    });
  });

  log.debug("routes registered", { scope: "analyze" });
}

module.exports = { register };
