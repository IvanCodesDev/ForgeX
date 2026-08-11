/* C# 权威 sidecar 的 G-code 与 Analytics 固定路由代理。
   固定目标路径、流式转发原始字节、按业务严格限长，并刻意采用请求头白名单，
   避免把 Node 会话、API Key 或 Authorization 泄露给独立计算进程。 */
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { resolveIdentity } = require("../lib/identity");

const ANALYZE_PATH = "/api/v1/gcode/analyze";
const ANALYSES_PATH = "/api/v1/gcode/analyses";
const ANALYTICS_PATH = "/api/v1/analytics/reports";
const RESPONSE_HEADERS = [
  "content-type",
  "traceparent",
  "tracestate",
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "server-timing",
  "location",
  "x-accel-buffering",
];

function sendProblem(res, status, code, title, traceId, closeConnection) {
  const body = JSON.stringify({
    type: "about:blank",
    title,
    status,
    code,
    traceId,
  });
  const headers = {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Request-ID": traceId,
  };
  if (closeConnection) headers.Connection = "close";
  res.writeHead(status, headers);
  res.end(body);
}

function contentLength(req) {
  const raw = req.headers["content-length"];
  if (raw == null) return null;
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) return NaN;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : NaN;
}

function opaqueContextId(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function upstreamHeaders(req, length, reqId, identity, cfg) {
  const headers = { "x-request-id": reqId };
  if (typeof req.headers.accept === "string") headers.accept = req.headers.accept;
  if (typeof req.headers["content-type"] === "string") {
    headers["content-type"] = req.headers["content-type"];
  }
  if (length != null) headers["content-length"] = String(length);
  if (typeof req.headers["idempotency-key"] === "string") {
    headers["idempotency-key"] = req.headers["idempotency-key"];
  }
  if (typeof req.headers["last-event-id"] === "string") {
    headers["last-event-id"] = req.headers["last-event-id"];
  }
  if (cfg.gcodeAuthorityInternalSecret && identity) {
    headers["x-forgex-internal-token"] = cfg.gcodeAuthorityInternalSecret;
    headers["x-forgex-tenant-id"] = opaqueContextId("tn_", identity.tenantId);
    headers["x-forgex-owner-id"] = opaqueContextId("ow_", identity.caller);
  }
  return headers;
}

function responseHeaders(upstream, reqId) {
  const headers = { "cache-control": "no-store", "x-request-id": reqId };
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers[name];
    if (value == null) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function proxyAnalyze(req, res, rc, ctx, targetPath) {
  const { cfg, log } = ctx;
  const analytics = targetPath === ANALYTICS_PATH;
  const authorityLabel = analytics ? "C# Analytics 影子计算" : "C# G-code 权威计算";
  const maxBytes = analytics ? cfg.analyticsAuthorityMaxBytes : cfg.gcodeAuthorityMaxBytes;
  const timeoutMs = analytics ? cfg.analyticsAuthorityTimeoutMs : cfg.gcodeAuthorityTimeoutMs;
  const tooLargeTitle = analytics ? "Analytics JSON 超过 5 MiB 上限" : "G-code 超过 64 MiB 上限";
  // 与其他写接口共用同一身份优先级和同一 IP 冷却窗口；守卫与限流都在
  // 创建 sidecar 连接前执行，拒绝的请求不会向权威计算进程泄漏任何字节。
  const identity = resolveIdentity(req, rc, ctx);
  ctx.rateLimit(rc.ip);

  if (analytics && !cfg.analyticsAuthorityEnabled) {
    sendProblem(res, 503, "analytics_authority_disabled", "C# Analytics 影子计算已关闭", rc.reqId);
    req.resume();
    return Promise.resolve();
  }

  if (!cfg.gcodeAuthorityUrl) {
    sendProblem(res, 503, "authority_not_configured", authorityLabel + "服务未配置", rc.reqId);
    req.resume();
    return Promise.resolve();
  }

  const declaredLength = contentLength(req);
  if (Number.isNaN(declaredLength)) {
    sendProblem(res, 400, "invalid_content_length", "Content-Length 不合法", rc.reqId, true);
    req.resume();
    return Promise.resolve();
  }
  if (declaredLength != null && declaredLength > maxBytes) {
    sendProblem(res, 413, "payload_too_large", tooLargeTitle, rc.reqId, true);
    req.resume();
    return Promise.resolve();
  }

  const requestUrl = new URL(req.url, "http://node.invalid");
  const target = new URL((targetPath || ANALYZE_PATH) + requestUrl.search, cfg.gcodeAuthorityUrl);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let finished = false;
    let terminal = false;
    let uploadEnded = false;
    let responseStarted = false;
    let transferred = 0;
    let pendingResponse = null;
    let timeout = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };

    let upstreamReq;

    const fail = (status, code, title, error) => {
      if (terminal) return;
      terminal = true;
      if (pendingResponse) pendingResponse.destroy();
      if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
      req.resume();

      if (error) {
        log.warn(analytics ? "analytics authority proxy failed" : "gcode authority proxy failed", {
          reqId: rc.reqId,
          code,
          error: error.message,
        });
      }
      if (!res.headersSent && !res.destroyed) {
        sendProblem(res, status, code, title, rc.reqId);
      } else if (!res.destroyed) {
        res.destroy();
      }
    };

    const startResponse = (upstreamRes) => {
      if (terminal) {
        upstreamRes.destroy();
        return;
      }
      if (!uploadEnded) {
        pendingResponse = upstreamRes;
        upstreamRes.pause();
        return;
      }

      pendingResponse = null;
      responseStarted = true;
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes, rc.reqId));
      upstreamRes.on("error", (error) => {
        fail(502, "authority_response_error", authorityLabel + "响应中断", error);
      });
      upstreamRes.on("aborted", () => {
        fail(502, "authority_response_aborted", authorityLabel + "响应中断");
      });
      upstreamRes.pipe(res);
      upstreamRes.resume();
    };

    try {
      upstreamReq = transport.request(target, {
        method: "POST",
        headers: upstreamHeaders(req, declaredLength, rc.reqId, identity, cfg),
      });
    } catch (error) {
      fail(502, "authority_unavailable", authorityLabel + "服务不可用", error);
      finish();
      return;
    }

    timeout = setTimeout(() => {
      fail(504, "authority_timeout", authorityLabel + "超时");
    }, timeoutMs);
    timeout.unref();

    upstreamReq.on("response", startResponse);
    upstreamReq.on("error", (error) => {
      if (terminal) return;
      const code = responseStarted ? "authority_response_error" : "authority_unavailable";
      const title = responseStarted ? authorityLabel + "响应中断" : authorityLabel + "服务不可用";
      fail(502, code, title, error);
    });
    upstreamReq.on("drain", () => {
      if (!terminal) req.resume();
    });

    req.on("data", (chunk) => {
      if (terminal) return;
      transferred += chunk.length;
      if (transferred > maxBytes) {
        fail(413, "payload_too_large", tooLargeTitle);
        return;
      }
      if (!upstreamReq.write(chunk)) req.pause();
    });
    req.on("end", () => {
      if (terminal) return;
      uploadEnded = true;
      upstreamReq.end();
      if (pendingResponse) startResponse(pendingResponse);
    });
    req.on("aborted", () => {
      if (terminal) return;
      terminal = true;
      if (pendingResponse) pendingResponse.destroy();
      upstreamReq.destroy();
      finish();
    });
    req.on("error", (error) => {
      fail(400, "request_stream_error", analytics ? "Analytics JSON 上传中断" : "G-code 上传中断", error);
    });

    res.once("finish", finish);
    res.once("close", () => {
      if (!res.writableEnded && !terminal) {
        terminal = true;
        if (pendingResponse) pendingResponse.destroy();
        upstreamReq.destroy();
      }
      finish();
    });
  });
}

function proxyJobControl(req, res, rc, ctx, targetPath, rateLimited) {
  const { cfg, log } = ctx;
  const identity = resolveIdentity(req, rc, ctx);
  if (rateLimited) ctx.rateLimit(rc.ip);
  if (!cfg.gcodeAsyncJobsEnabled) {
    sendProblem(res, 503, "async_jobs_disabled", "异步 G-code 作业已关闭", rc.reqId);
    req.resume();
    return Promise.resolve();
  }
  if (!cfg.gcodeAuthorityUrl) {
    sendProblem(res, 503, "authority_not_configured", "C# G-code 权威计算服务未配置", rc.reqId);
    req.resume();
    return Promise.resolve();
  }

  const target = new URL(targetPath, cfg.gcodeAuthorityUrl);
  const transport = target.protocol === "https:" ? https : http;
  req.resume();
  return new Promise((resolve) => {
    let done = false;
    let terminal = false;
    let timeout = null;
    let upstreamReq;
    const finish = () => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    try {
      upstreamReq = transport.request(target, {
        method: req.method,
        headers: upstreamHeaders(req, 0, rc.reqId, identity, cfg),
      });
    } catch (error) {
      log.warn("gcode job proxy failed", { reqId: rc.reqId, error: error.message });
      sendProblem(res, 502, "authority_unavailable", "C# G-code 权威计算服务不可用", rc.reqId);
      return finish();
    }
    if (!targetPath.endsWith("/events")) {
      timeout = setTimeout(() => {
        if (terminal) return;
        terminal = true;
        upstreamReq.destroy();
        if (!res.headersSent) {
          sendProblem(res, 504, "authority_timeout", "C# G-code 权威计算超时", rc.reqId);
        } else if (!res.destroyed) {
          res.destroy();
        }
        finish();
      }, cfg.gcodeAuthorityTimeoutMs);
      timeout.unref();
    }
    upstreamReq.on("response", (upstreamRes) => {
      if (terminal) return upstreamRes.destroy();
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes, rc.reqId));
      upstreamRes.on("error", () => {
        if (!res.destroyed) res.destroy();
      });
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", (error) => {
      if (terminal) return;
      terminal = true;
      log.warn("gcode job proxy failed", { reqId: rc.reqId, error: error.message });
      if (!res.headersSent) {
        sendProblem(res, 502, "authority_unavailable", "C# G-code 权威计算服务不可用", rc.reqId);
      } else if (!res.destroyed) res.destroy();
      finish();
    });
    upstreamReq.end();
    res.once("finish", finish);
    res.once("close", () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
      finish();
    });
  });
}

function register(router, ctx) {
  router.add("POST", /^\/api\/v1\/gcode\/analyze$/, (req, res, _match, rc) => {
    return proxyAnalyze(req, res, rc, ctx);
  });
  router.add("POST", /^\/api\/v1\/gcode\/analyses$/, (req, res, _match, rc) => {
    if (!ctx.cfg.gcodeAsyncJobsEnabled) {
      sendProblem(res, 503, "async_jobs_disabled", "异步 G-code 作业已关闭", rc.reqId);
      req.resume();
      return Promise.resolve();
    }
    return proxyAnalyze(req, res, rc, ctx, ANALYSES_PATH);
  });
  router.add("POST", /^\/api\/v1\/analytics\/reports$/, (req, res, _match, rc) => {
    return proxyAnalyze(req, res, rc, ctx, ANALYTICS_PATH);
  });
  router.add("GET", /^\/api\/v1\/jobs\/([a-f0-9]{32})$/, (req, res, match, rc) => {
    return proxyJobControl(req, res, rc, ctx, `/api/v1/jobs/${match[1]}`, false);
  });
  router.add("GET", /^\/api\/v1\/jobs\/([a-f0-9]{32})\/events$/, (req, res, match, rc) => {
    return proxyJobControl(req, res, rc, ctx, `/api/v1/jobs/${match[1]}/events`, false);
  });
  router.add("POST", /^\/api\/v1\/jobs\/([a-f0-9]{32})\/cancel$/, (req, res, match, rc) => {
    return proxyJobControl(req, res, rc, ctx, `/api/v1/jobs/${match[1]}/cancel`, true);
  });
}

module.exports = { register };
