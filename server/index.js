/* FORGE·X 智造洞察 — 自有薄后端（Node ≥18 原生 http，零 npm 依赖）。职责：
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
const { CalibrationStore } = require("./services/calibration");
const { PostgresCalibrationStore } = require("./services/postgres-calibration");
const { InfiniClient } = require("./services/infini");
const { PartnerSSO } = require("./services/partner-sso");
const { CostGate } = require("./lib/quota");
const { Auth } = require("./lib/auth");

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
  const gate = new CostGate(cfg, log);
  const auth = new Auth(cfg, log);
  const partnerSSO = new PartnerSSO(cfg, log);
  const datasources = new DatasourceStore(cfg, log);
  const knowledge = new KnowledgeStore(cfg, log);
  const tasks = new TaskStore(cfg, log, infini, knowledge, gate);
  const shares = new ShareStore(cfg, log);
  const calibrations = cfg.persistenceProvider === "file"
    ? new CalibrationStore(cfg, log)
    : new PostgresCalibrationStore(cfg, log);

  /* 运行指标。不引依赖，就是几个计数器——够 /metrics 用，也够排查线上问题。 */
  const metrics = {
    tasks: 0,
    failed: 0,
    degraded: 0,
    cached: 0,
    requests: 0,
    lastDurationMs: 0,
    snapshot() {
      return { ...this };
    },
  };
  tasks.onTerminal = (task) => {
    metrics.lastDurationMs = Math.max(0, task.finishedAt - task.createdAt);
    if (task.status === "failed") metrics.failed++;
    if (task.degraded) metrics.degraded++;
    if (task.cached) metrics.cached++;
  };

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

  const ctx = {
    cfg,
    log,
    infini,
    datasources,
    tasks,
    knowledge,
    shares,
    calibrations,
    rateLimit,
    gate,
    auth,
    partnerSSO,
    metrics,
  };
  const router = new Router();

  router.add("GET", /^\/healthz$/, async (req, res) => {
    // engine 与报告里的 engine 字段取同一个值（provider.id），避免 healthz 说一套、报告说另一套
    const p = tasks.provider;
    const partnerIdentity = partnerSSO.enabled ? partnerSSO.identity(req) : null;
    const userAi = !!(partnerIdentity && partnerIdentity.apiKey);
    let calibrationStats;
    try {
      calibrationStats = typeof calibrations.stats === "function"
        ? await calibrations.stats()
        : { approved: calibrations.approvedCount, pending: calibrations.pendingCount };
    } catch (error) {
      log.warn("persistence probe failed", { provider: cfg.persistenceProvider, error: error.message });
      return sendJson(res, 503, {
        ok: false,
        engine: userAi ? "infinisynapse" : p.id,
        provider: userAi ? "infinisynapse" : cfg.provider,
        persistence: cfg.persistenceProvider,
        error: "persistence_unavailable",
        now: Date.now(),
      });
    }
    sendJson(res, 200, {
      ok: true,
      engine: userAi ? "infinisynapse" : p.id,
      provider: userAi ? "infinisynapse" : cfg.provider,
      label: userAi ? "InfiniSynapse Partner 用户密钥" : p.label,
      capabilities: userAi
        ? { ai: true, streaming: true, structuredOutput: true }
        : p.capabilities,
      capabilityScope: userAi ? "current-user" : "system",
      reason: userAi ? "当前 SSO 用户持有有效 Partner API Key" : cfg.providerReason,
      // 公网访问者有权知道自己面对的是什么限制，而不是撞上 429 才发现
      quota: p.capabilities.ai ? gate.snapshot() : null,
      auth: { enabled: auth.enabled, required: auth.required },
      sso: { enabled: partnerSSO.enabled, integration: "partner-sso-b" },
      persistence: cfg.persistenceProvider === "file" ? (cfg.dataDir ? "file" : "memory") : "postgres",
      calibrations: {
        approved: calibrationStats.approved,
        pending: calibrationStats.pending,
        writesEnabled: auth.enabled,
      },
      now: Date.now(),
    });
  });

  /* Prometheus 文本格式指标。不引入依赖——格式本身就是几行字符串拼接。
     暴露的是运维需要的量：任务数、失败率、时延、配额用量、存储规模。 */
  router.add("GET", /^\/metrics$/, async (req, res) => {
    const q = gate.snapshot();
    const m = metrics.snapshot();
    const L = [];
    const g = (name, help, value, labels) => {
      L.push("# HELP " + name + " " + help);
      L.push("# TYPE " + name + " gauge");
      L.push(name + (labels || "") + " " + value);
    };
    const c = (name, help, value, labels) => {
      L.push("# HELP " + name + " " + help);
      L.push("# TYPE " + name + " counter");
      L.push(name + (labels || "") + " " + value);
    };
    c("forgex_tasks_total", "分析任务总数", m.tasks);
    c("forgex_tasks_failed_total", "失败的分析任务数", m.failed);
    c("forgex_tasks_degraded_total", "因额度/队列降级为规则引擎的任务数", m.degraded);
    c("forgex_tasks_cached_total", "命中结果缓存的任务数", m.cached);
    c("forgex_http_requests_total", "HTTP 请求总数", m.requests);
    g("forgex_task_duration_ms", "最近一次分析任务耗时（毫秒）", m.lastDurationMs);
    g("forgex_ai_running", "正在执行的 AI 任务数", q.running);
    g("forgex_ai_queued", "排队中的 AI 任务数", q.queued);
    g("forgex_ai_concurrency_limit", "AI 并发上限", q.concurrencyLimit);
    g("forgex_ai_daily_used", "今日已用 AI 额度", q.globalUsed);
    g("forgex_ai_daily_limit", "每日 AI 额度上限（0=不限）", q.globalLimit || 0);
    g("forgex_datasources", "已存数据源数", datasources.size);
    g("forgex_knowledge_docs", "已存知识文档数", knowledge.size);
    g("forgex_shares", "有效分享页数", shares.size);
    const calibrationStats = typeof calibrations.stats === "function"
      ? await calibrations.stats()
      : { approved: calibrations.approvedCount, pending: calibrations.pendingCount };
    g("forgex_calibrations_approved", "已发布校准 bundle 数", calibrationStats.approved);
    g("forgex_calibrations_pending", "待审核校准 bundle 数", calibrationStats.pending);
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(L.join("\n") + "\n");
  });
  require("./routes/analyze").register(router, ctx);
  require("./services/partner-sso").register(router, ctx);
  require("./routes/datasource").register(router, ctx);
  require("./routes/knowledge").register(router, ctx);
  require("./routes/share").register(router, ctx);
  require("./routes/calibration").register(router, ctx);
  require("./routes/gcode-authority").register(router, ctx);

  function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && cfg.allowOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key, Idempotency-Key, Last-Event-ID"
      );
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
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    metrics.requests++;
    res.on("finish", () => {
      // SSE 长连接结束时也会走到这，一并计入访问日志
      log.info("http", {
        reqId,
        ip,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
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
      if (res.headersSent) {
        try {
          res.end();
        } catch (e2) {
          /* 已断开 */
        }
        return;
      }
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
    partnerSSO.sweep(now);
  }, 60 * 1000);
  sweeper.unref();

  function close() {
    clearInterval(sweeper);
    gate.state.save(); // 用量计数落盘，避免停机丢掉当日额度记录
    tasks.closeAll();
    return new Promise((resolve) => server.close(resolve)).then(() =>
      typeof calibrations.close === "function" ? calibrations.close() : undefined
    );
  }

  return { server, cfg, log, ctx, close };
}

/* ── 直接运行入口 ───────────────────────────── */

if (require.main === module) {
  const app = createApp();
  const { cfg, log } = app;
  app.server.listen(cfg.port, cfg.host, async () => {
    log.info("FORGE·X server started", {
      url: "http://" + cfg.host + ":" + cfg.port,
      provider: cfg.provider,
      reason: cfg.providerReason,
      persistence: cfg.persistenceProvider === "file" ? (cfg.dataDir ? cfg.dataDir : "memory-only") : "postgres",
    });
    // 探活放在 listen 之后：服务先可用，AI 通道慢一拍确认，不阻塞启动
    if (cfg.probeProvider) await app.ctx.tasks.probeProvider();
  });
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { sig });
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref(); // 兜底强退
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
