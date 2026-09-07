/* 分析任务路由：建任务（限流）/ SSE 进度流 / 结果获取。

   Stage 8.6c-1（V2.0 手册 §4.2）：ANALYSIS_TASKS_AUTHORITY=csharp 时结果与轮询两条 GET 改读
   ForgeX.Api 的任务快照（GET /api/v1/analysis-tasks/{id}，同一张 forgex.node_analysis_tasks）。
   Stage 8.6c-2a：SSE 进度流也改读 C#（GET /api/v1/analysis-tasks/{id}/events）——C# 发的是
   id/event 命名帧，前端 EventSource.onmessage 只认无名 data: 帧，所以 Node 在这里重新组帧：
   progress/message 帧的 data 就是 Node 落库的事件对象，原样转发；C# 的 done 快照帧只在事件里
   没有终态事件时才合成一条 Node 形状的终态事件。创建仍在 Node（任务在本进程执行），随 8.6c-2b 迁移。
   ANALYSIS_TASKS_AUTHORITY=node（默认）保持既有行为，作为回滚开关。 */
"use strict";
const { HttpError, readJson, sendJson, sseStart, sseSend } = require("../lib/http");
const { resolveIdentity, requireOwner } = require("../lib/identity");
const { parseAiOverride } = require("../lib/ai-endpoint");
const { authorityRequest, authorityStream, authorityProblem } = require("../lib/authority-client");
const { createSseParser } = require("../lib/sse");
const { readSnapshot, AUTHORITY_UNAVAILABLE } = require("../lib/analysis-tasks-client");

const MAX_QUESTION = 500;

/* C# 的 done 帧是快照 DTO；事件数组里没有终态事件（例如重启恢复成 failed 的任务）时，
   按 Node _finish / _fail 的形状补一条，前端才会收口。 */
function terminalEventFromSnapshot(snapshot, lastSeq) {
  const base = { seq: lastSeq + 1, ts: Date.now(), done: true };
  if (snapshot && snapshot.status === "failed") {
    const error = snapshot.error || "分析失败";
    return Object.assign(base, { error, message: "分析失败：" + error });
  }
  return Object.assign(base, { progress: 1, message: "分析完成" });
}

/* csharp 模式的进度流：消费 C# /events，重新组成无名 data: 帧。返回 Promise，随连接结束 resolve。 */
async function proxyEventStream(req, res, cfg, log, identity, taskId, rc) {
  let upstream;
  try {
    upstream = await authorityStream(cfg, identity, "/api/v1/analysis-tasks/" + taskId + "/events", {
      timeoutMs: cfg.resourceAuthorityTimeoutMs,
      headers: { "last-event-id": req.headers["last-event-id"] },
    });
  } catch (error) {
    log.warn("analysis tasks authority stream failed", { reqId: rc.reqId, error: error.message });
    throw new HttpError(502, AUTHORITY_UNAVAILABLE);
  }
  if (upstream.status === 404) {
    upstream.abort();
    throw new HttpError(404, "任务不存在或已过期");
  }
  if (upstream.status !== 200 || !/event-stream/i.test(upstream.contentType)) {
    upstream.abort();
    log.warn("analysis tasks authority stream rejected", { reqId: rc.reqId, status: upstream.status });
    throw new HttpError(502, AUTHORITY_UNAVAILABLE);
  }

  sseStart(res);
  let lastSeq = 0;
  let sawTerminal = false;
  const parser = createSseParser({
    onComment(text) {
      // 心跳原样转发：前端 EventSource 不会收到注释，但中间代理不会因空闲断开。
      if (!res.destroyed) res.write(": " + text + "\n\n");
    },
    onFrame(frame) {
      if (sawTerminal || res.destroyed) return;
      let payload;
      try {
        payload = JSON.parse(frame.data);
      } catch {
        return;
      }
      if (frame.event === "done") {
        sseSend(res, terminalEventFromSnapshot(payload, lastSeq));
        sawTerminal = true;
        return;
      }
      if (!payload || typeof payload !== "object") return;
      if (typeof payload.seq === "number") lastSeq = Math.max(lastSeq, payload.seq);
      sseSend(res, payload);
      if (payload.done === true) sawTerminal = true;
    },
  });

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      upstream.abort();
      if (!res.destroyed && !res.writableEnded) res.end();
      resolve();
    };
    upstream.stream.on("data", (chunk) => {
      parser.push(chunk);
      if (sawTerminal) finish();
    });
    upstream.stream.on("end", () => {
      parser.end();
      finish();
    });
    upstream.stream.on("error", (error) => {
      log.warn("analysis tasks authority stream interrupted", { reqId: rc.reqId, error: error.message });
      finish();
    });
    req.on("close", finish);
  });
}

/* csharp 模式（8.6c-2b 规则引擎腿）：把创建交给 C#。身份 / 限流 / question 校验仍在 Node，
   数据源归属由 C# 按租户 + owner 判定（他人数据源 → 404，与 8.6a A7 同一取舍）。 */
async function createOnAuthority(cfg, log, identity, question, datasourceId, rc) {
  let response;
  try {
    response = await authorityRequest(cfg, identity, "POST", "/api/v1/analysis-tasks", { question, datasourceId }, {
      timeoutMs: cfg.resourceAuthorityTimeoutMs,
    });
  } catch (error) {
    log.warn("analysis tasks authority create failed", { reqId: rc.reqId, error: error.message });
    throw new HttpError(502, AUTHORITY_UNAVAILABLE);
  }
  const accepted = response.status === 202 ? response.json() : null;
  if (accepted && typeof accepted === "object" && typeof accepted.id === "string") return accepted;
  const problem = authorityProblem(response);
  if (problem && problem.status >= 400 && problem.status < 500 && problem.title) {
    throw new HttpError(problem.status, problem.title);
  }
  log.warn("analysis tasks authority create rejected", { reqId: rc.reqId, status: response.status });
  throw new HttpError(502, AUTHORITY_UNAVAILABLE);
}

function register(router, ctx) {
  const { tasks, datasources, knowledge, log, gate, metrics, cfg } = ctx;
  const csharp = cfg.analysisTasksAuthority === "csharp";

  router.add("POST", /^\/api\/analyze$/, async (req, res, m, rc) => {
    // 先统一身份，再做限流和资源授权。
    const identity = await resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);

    ctx.rateLimit(rc.ip); // 同 IP 冷却，防刷
    const body = await readJson(req, 8 * 1024);
    const question = String(body.question || "").trim();
    if (!question) throw new HttpError(400, "question 不能为空");
    if (question.length > MAX_QUESTION) throw new HttpError(400, "question 超过 " + MAX_QUESTION + " 字");
    // 用户自带 OpenAI 兼容端点：校验合法后本次请求覆盖进程级 AI 配置；
    // 密钥只进 provider 闭包，不进任务快照、日志或任何响应。
    const aiOverride = parseAiOverride(body);

    // 8.6c-2b 规则引擎腿：不走 AI 的任务由 C# 创建并执行。AI 任务（进程级 provider 或自带端点）
    // 仍在 Node 创建——C# 侧的 AI provider / 成本闸门 / 缓存随 8.6c-2b-ii 迁移；它们照样落库到同一张表，
    // 结果 / 轮询 / 进度流依旧从 C# 读。
    if (csharp && !aiOverride && !tasks.usesAi) {
      const accepted = await createOnAuthority(cfg, log, identity, question, body.datasourceId || "sample", rc);
      metrics.tasks++;
      sendJson(res, 202, {
        taskId: accepted.id,
        engine: accepted.engine,
        authenticated: identity.authenticated,
        willUseAi: false,
        quota: null,
      });
      return;
    }

    const ds = await datasources.get(body.datasourceId || "sample", identity.tenantId);
    if (!ds) throw new HttpError(404, "数据源不存在或已过期，请重新上传");
    if (!ds.builtin) requireOwner(ds, identity, ctx, "datasource", ds.id);
    if (typeof knowledge.ready === "function") await knowledge.ready(identity.tenantId);

    // 配额预检：提前把「会不会降级」告诉调用方，而不是等报告出来才发现没有 AI 叙述
    const willUseAi = !!(aiOverride || tasks.usesAi);
    const quota = willUseAi && gate ? gate.check(identity.caller) : { ok: true };
    const task = tasks.create(question, ds, rc.reqId, {
      caller: identity.caller,
      aiOverride,
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
    if (csharp) return proxyEventStream(req, res, cfg, log, identity, m[1], rc);
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
    if (csharp) {
      // 落库按任务串行异步进行：Node 内存已 done 而快照可能滞后一个 DB 往返，此时如实返回 202，调用方按既有轮询语义重试。
      const snapshot = await readSnapshot(cfg, log, identity, m[1], rc);
      if (snapshot.status === "running") return sendJson(res, 202, { status: "running" });
      // C# 快照 DTO 的失败文案字段叫 error（AnalysisTaskSnapshotDto），不是仓储记录里的 errorMessage。
      if (snapshot.status === "failed") return sendJson(res, 502, { error: snapshot.error || "分析失败" });
      if (snapshot.status === "done") return sendJson(res, 200, snapshot.report);
      log.warn("analysis tasks authority snapshot has unknown status", { reqId: rc.reqId, status: snapshot.status });
      throw new HttpError(502, AUTHORITY_UNAVAILABLE);
    }
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
    if (csharp) {
      const snapshot = await readSnapshot(cfg, log, identity, m[1], rc);
      return sendJson(res, 200, {
        taskId: m[1],
        status: snapshot.status,
        engine: snapshot.engine,
        progress: snapshot.progress || 0,
        message: snapshot.message || "",
        error: snapshot.error || undefined,
      });
    }
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
