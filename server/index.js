/* FORGE·X 智造洞察 — 自有薄后端（Node ≥18 原生 http，零 npm 依赖）
   设计见 doc/开发文档.md §8。职责：
   1. /api/* 业务接口（分析任务 / SSE 进度 / 数据源 / 知识库 / 分享）
   2. /share/:token 公开分享页（服务端渲染）
   3. 静态托管前端（allowlist，server/ 与 .env 永不可达）→ 同源部署零 CORS
   引擎双模：rules（复用前端规则引擎，确定性统计、非 AI）/ infinisynapse（key 核准后启用的云端 AI）。
   零依赖动机：评委 clone 后 `node server/index.js` 即起，无 install、无供应链风险；
   若后续需要 Fastify 生态，services/* 与框架无关，仅需替换本文件与 routes/*。 */
"use strict";
const http = require("http");
const crypto = require("crypto");

const { getConfig } = require("./config");
const { createLogger } = require("./lib/logger");
const { HttpError, sendJson, serveStatic, clientIp } = require("./lib/http");
const { DatasourceStore } = require("./services/datasource");
const { TaskStore } = require("./services/analysis");
const { KnowledgeStore } = require("./services/knowledge");
const { ShareStore } = require("./services/share");
const { InfiniClient } = require("./services/infini");

/* ── 极简路由器 ─────────────────────────────── */

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    this.routes.push({ method, pattern, handler });
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (m) return { handler: r.handler, m };
    }
    return null;
  }
}

/* ── 服务组装（可测：不自动 listen） ───────────── */

function createApp(overrides) {
  const cfg = getConfig(overrides);
  const log = createLogger(cfg.logLevel);
  const infini = new InfiniClient(cfg, log);
  const datasources = new DatasourceStore(cfg);
  const knowledge = new KnowledgeStore(cfg);
  const tasks = new TaskStore(cfg, log, infini, knowledge);
  const shares = new ShareStore();

  // 同 IP 冷却限流（仅分析接口调用）。
  // Map 迭代序 = 插入序，每次命中先 delete 再 set，插入序即等于「最近使用序」，
  // 超容量时从队首淘汰最久未用的条目——旧实现是 size>10000 时 clear()，
  // 会把**所有人**的冷却窗口一次性清空，攻击者只要灌满 Map 就能绕过限流。
  const RATE_MAX_ENTRIES = 10000;
  const lastHit = new Map();
  function rateLimit(ip) {
    if (cfg.rateLimitMs <= 0) return;
    const now = Date.now();
    const last = lastHit.get(ip) || 0;
    if (now - last < cfg.rateLimitMs) {
      throw new HttpError(429, "请求过于频繁，请 " + Math.ceil((cfg.rateLimitMs - (now - last)) / 1000) + " 秒后重试");
    }
    lastHit.delete(ip);
    lastHit.set(ip, now);
    while (lastHit.size > RATE_MAX_ENTRIES) {
      const oldest = lastHit.keys().next();
      if (oldest.done) break;
      lastHit.delete(oldest.value);
    }
  }

  const ctx = { cfg, log, infini, datasources, tasks, knowledge, shares, rateLimit };
  const router = new Router();

  router.add("GET", /^\/healthz$/, (req, res) => {
    // engine 与报告里的 engine 字段取同一个值（provider.id），避免 healthz 说一套、报告说另一套
    const p = tasks.provider;
    sendJson(res, 200, {
      ok: true,
      engine: p.id,
      provider: cfg.provider,
      label: p.label,
      capabilities: p.capabilities,
      reason: cfg.providerReason,
      now: Date.now(),
    });
  });
  require("./routes/analyze").register(router, ctx);
  require("./routes/datasource").register(router, ctx);
  require("./routes/knowledge").register(router, ctx);
  require("./routes/share").register(router, ctx);

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && cfg.allowOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }

  const server = http.createServer(async (req, res) => {
    const reqId = crypto.randomBytes(4).toString("hex");
    const ip = clientIp(req, cfg.trustProxy);
    const started = Date.now();
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://x").pathname;
    } catch (e) {
      return sendJson(res, 400, { error: "URL 不合法" });
    }
    applyCors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    res.on("finish", () => {
      // SSE 长连接结束时也会走到这，一并计入访问日志
      log.info("http", { reqId, ip, method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    });

    try {
      const hit = router.match(req.method, pathname);
      if (hit) {
        const rc = { reqId, ip, origin: req.headers.origin || "" };
        await hit.handler(req, res, hit.m, rc);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "接口不存在" });
        return serveStatic(req, res, cfg.staticRoot);
      }
      sendJson(res, 404, { error: "接口不存在" });
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch (e2) { /* 已断开 */ } return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      log.error("unhandled", { reqId, path: pathname, error: err.message, stack: err.stack });
      sendJson(res, 500, { error: "服务器内部错误" });
    }
  });

  // 周期清理过期数据源 / 任务 / 知识文档 / 分享页
  const sweeper = setInterval(() => {
    const now = Date.now();
    datasources.sweep(now);
    tasks.sweep(now);
    knowledge.sweep(now);
    shares.sweep(now);
  }, 60 * 1000);
  sweeper.unref();

  function close() {
    clearInterval(sweeper);
    tasks.closeAll();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, cfg, log, ctx, close };
}

/* ── 直接运行入口 ───────────────────────────── */

if (require.main === module) {
  const app = createApp();
  const { cfg, log } = app;
  app.server.listen(cfg.port, cfg.host, () => {
    log.info("FORGE·X server started", {
      url: "http://" + cfg.host + ":" + cfg.port,
      engine: cfg.mode,
      reason: cfg.modeReason,
    });
  });
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { sig });
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();   // 兜底强退
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
