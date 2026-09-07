/* ANALYSIS_TASKS_AUTHORITY=csharp 时读 ForgeX.Api 的任务快照（GET /api/v1/analysis-tasks/{id}）。

   Stage 8.6c-1 长在 routes/analyze.js 里；8.6c-2b 起 routes/share.js 也要用它——C# 创建的任务
   不在 Node TaskStore 的内存里，分享前的「任务存在且已完成」判定必须同样问 C#。
   归属由 C# 按租户 + owner 隔离：他人任务一律 404。 */
"use strict";
const { HttpError } = require("./http");
const { authorityRequest } = require("./authority-client");

const AUTHORITY_UNAVAILABLE = "分析任务服务暂不可用，请稍后再试";

/**
 * @returns C# AnalysisTaskSnapshotDto：{ id, question, datasourceId, engine, provider, status, progress,
 *          phase, message, lastEventSeq, report, error, upstreamTaskId, createdAtUtc, finishedAtUtc, expiresAtUtc, links }
 */
async function readSnapshot(cfg, log, identity, taskId, rc) {
  let response;
  try {
    response = await authorityRequest(cfg, identity, "GET", "/api/v1/analysis-tasks/" + taskId, null, {
      timeoutMs: cfg.resourceAuthorityTimeoutMs,
    });
  } catch (error) {
    log.warn("analysis tasks authority read failed", { reqId: rc && rc.reqId, error: error.message });
    throw new HttpError(502, AUTHORITY_UNAVAILABLE);
  }
  if (response.status === 404) throw new HttpError(404, "任务不存在或已过期");
  const snapshot = response.status === 200 ? response.json() : null;
  if (!snapshot || typeof snapshot !== "object") {
    log.warn("analysis tasks authority read rejected", { reqId: rc && rc.reqId, status: response.status });
    throw new HttpError(502, AUTHORITY_UNAVAILABLE);
  }
  return snapshot;
}

module.exports = { readSnapshot, AUTHORITY_UNAVAILABLE };
