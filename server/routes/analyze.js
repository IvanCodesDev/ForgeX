/* 分析任务路由：建任务（限流）/ SSE 进度流 / 结果获取。契约见 doc/开发文档.md §8.3。 */
"use strict";
const { HttpError, readJson, sendJson, sseStart } = require("../lib/http");

const MAX_QUESTION = 500;

function register(router, ctx) {
  const { tasks, datasources, log } = ctx;

  router.add("POST", /^\/api\/analyze$/, async (req, res, m, rc) => {
    ctx.rateLimit(rc.ip);   // 同 IP 冷却，防刷（doc §8.4）
    const body = await readJson(req, 8 * 1024);
    const question = String(body.question || "").trim();
    if (!question) throw new HttpError(400, "question 不能为空");
    if (question.length > MAX_QUESTION) throw new HttpError(400, "question 超过 " + MAX_QUESTION + " 字");
    const ds = datasources.get(body.datasourceId || "sample");
    if (!ds) throw new HttpError(404, "数据源不存在或已过期，请重新上传");
    const task = tasks.create(question, ds, rc.reqId);
    sendJson(res, 202, { taskId: task.id, engine: task.engine });
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
