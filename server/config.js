/* FORGE·X 智造洞察 — 后端配置：读取 server/.env（KEY=VALUE，不覆盖已有环境变量）。
   sk- 密钥只活在进程环境与 services/infini.js，绝不回写文件、绝不进日志。 */
"use strict";
const fs = require("fs");
const path = require("path");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const GCODE_AUTHORITY_HARD_MAX_BYTES = 64 * 1024 * 1024;
const ANALYTICS_AUTHORITY_HARD_MAX_BYTES = 5 * 1024 * 1024;
const CALIBRATION_AUTHORITY_HARD_MAX_BYTES = 2 * 1024 * 1024;

function normalizeAuthorityOrigin(value, allowRemote) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    throw new Error("GCODE_AUTHORITY_URL 必须是合法的 http(s) origin", { cause: e });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("GCODE_AUTHORITY_URL 只允许 http(s)");
  }
  if (target.username || target.password) {
    throw new Error("GCODE_AUTHORITY_URL 禁止携带凭据");
  }
  if (target.pathname !== "/" || target.search || target.hash) {
    throw new Error("GCODE_AUTHORITY_URL 只能配置 origin，禁止路径、查询参数或片段");
  }

  const hostname = target.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (!allowRemote && !loopback) {
    throw new Error("GCODE_AUTHORITY_URL 默认只允许 loopback；远端部署需显式启用 GCODE_AUTHORITY_ALLOW_REMOTE=1");
  }
  return target.origin;
}

function getConfig(overrides) {
  loadEnvFile(path.join(__dirname, ".env"));
  const env = process.env;
  const cfg = Object.assign(
    {
      host: env.HOST || "127.0.0.1", // 部署平台一般要求 HOST=0.0.0.0
      port: num(env.PORT, 8787),
      staticRoot: path.resolve(__dirname, ".."),
      publicBase: env.PUBLIC_BASE || "", // 分享链接前缀（部署后填公网域名）
      allowOrigins: (env.ALLOW_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      trustProxy: env.TRUST_PROXY === "1",
      rateLimitMs: num(env.RATE_LIMIT_MS, 5000),
      // 规则引擎每阶段的人造延时。默认 0：规则引擎本就是毫秒级，
      // 拖慢进度条只是为了「看起来在思考」，属于欺骗性 UI。仅演示录屏时才显式打开。
      mockDelayMs: num(env.MOCK_DELAY_MS, 0),
      taskTtlMs: num(env.TASK_TTL_MS, 60 * 60 * 1000),
      logLevel: env.LOG_LEVEL || "info",
      infiniKey: env.INFINI_API_KEY || "",
      infiniServerUrl: env.INFINI_SERVER_URL || "https://app.infinisynapse.cn",
      infiniConsoleUrl: env.INFINI_CONSOLE_URL || "https://api.infinisynapse.cn/api",
      infiniVerified: env.INFINI_VERIFIED === "1",
      infiniTimeoutMs: num(env.INFINI_TIMEOUT_MS, 180000),
      forceMock: env.INFINI_MOCK === "1",

      // ── InfiniSynapse Partner SSO（路线 B：用户授权、用户结算）──
      // clientSecret 只能存在服务端；前端只接触登录入口与脱敏后的用户资料。
      infiniPartnerApi: env.INFINI_PARTNER_API || "https://api.infinisynapse.cn/api",
      infiniPartnerClientId: env.INFINI_PARTNER_CLIENT_ID || "",
      infiniPartnerClientSecret: env.INFINI_PARTNER_CLIENT_SECRET || "",
      loginSessionTtlMs: num(env.LOGIN_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),

      // ── OpenAI 兼容 provider（OpenAI / Azure / Ollama / vLLM / 各家兼容端点）──
      openaiKey: env.OPENAI_API_KEY || "",
      openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      openaiModel: env.OPENAI_MODEL || "",
      openaiTimeoutMs: num(env.OPENAI_TIMEOUT_MS, 120000),

      // 显式指定 provider：auto / local / infinisynapse / openai
      providerPref: env.ANALYSIS_PROVIDER || "auto",

      // 结果缓存：同一「问题 + 数据集 + provider」不重复调用 AI（省钱也省等待）
      cacheTtlMs: num(env.RESULT_CACHE_TTL_MS, 30 * 60 * 1000),
      cacheMax: num(env.RESULT_CACHE_MAX, 200),

      // ── 持久化 ──────────────────────────────
      // 重启不再丢一切。设为空字符串可显式关闭（回到纯内存）。
      dataDir: env.DATA_DIR === "" ? "" : env.DATA_DIR || path.resolve(__dirname, "..", "data"),
      persistenceProvider: String(env.PERSISTENCE_PROVIDER || "file").trim().toLowerCase(),
      postgresUrl: env.POSTGRES_URL || env.DATABASE_URL || "",
      postgresPoolMax: num(env.POSTGRES_POOL_MAX, 10),
      postgresSsl: env.POSTGRES_SSL === "1",

      // ── 成本闸门（公网部署的生死线，见 server/lib/quota.js）──
      // 规则引擎不受任何闸门限制——它不花钱。这里限的只有 AI provider 调用。
      aiConcurrency: num(env.AI_CONCURRENCY, 2),
      aiQueueMax: num(env.AI_QUEUE_MAX, 8),
      dailyPerCaller: num(env.AI_DAILY_PER_CALLER, 20),
      dailyGlobal: num(env.AI_DAILY_GLOBAL, 200),

      // ── 鉴权（默认关闭；配了 API_KEYS 才启用）──
      apiKeys: env.API_KEYS || "",
      requireAuth: env.REQUIRE_AUTH === "1",

      // ── 校准审核角色 ─────────────────────────
      // 与普通 API key 显式分离。可配置为 API_KEYS 的受信子集，也可使用
      // 独立保管的审核 key；无论哪种方式，普通 API key 都不会隐式获得审核权。
      calibrationReviewKeys: env.CALIBRATION_REVIEW_KEYS || "",

      // ── C# G-code 权威计算 sidecar ────────────
      // 默认关闭；生产建议同机 loopback。代理固定到 /api/v1/gcode/analyze，
      // 不接受目标路径，也不把浏览器凭据传给 sidecar。
      gcodeAuthorityUrl: env.GCODE_AUTHORITY_URL || "",
      gcodeAuthorityAllowRemote: env.GCODE_AUTHORITY_ALLOW_REMOTE === "1",
      gcodeAuthorityTimeoutMs: num(env.GCODE_AUTHORITY_TIMEOUT_MS, 120000),
      gcodeAuthorityMaxBytes: GCODE_AUTHORITY_HARD_MAX_BYTES,
      gcodeAsyncJobsEnabled: env.GCODE_ASYNC_JOBS_ENABLED !== "0",
      // Node 与 C# sidecar 的进程间信任边界。浏览器永远不接触该值；
      // 配置后，Node 才会向 C# 注入经过身份解析的匿名化 tenant/owner 上下文。
      gcodeAuthorityInternalSecret: env.GCODE_AUTHORITY_INTERNAL_SECRET || "",
      // ── C# Analytics 对照/权威计算 ─────────────
      // 与 G-code 共用同一 sidecar origin，但使用独立开关、超时和 5 MiB JSON 上限。
      // 浏览器默认仍走 JS；VITE_ANALYTICS_AUTHORITY=shadow/dotnet 时才会调用该路由。
      analyticsAuthorityEnabled: env.ANALYTICS_AUTHORITY_ENABLED !== "0",
      analyticsAuthorityTimeoutMs: num(env.ANALYTICS_AUTHORITY_TIMEOUT_MS, 30000),
      analyticsAuthorityMaxBytes: ANALYTICS_AUTHORITY_HARD_MAX_BYTES,
      // ── Stage 8.1：shares 权威切流（迁移期双向开关）─────────────
      // node = 本进程存储（默认，行为不变）；csharp = 代理到 ForgeX.Api
      //（与 G-code 权威共用同一 sidecar origin 与内部信任令牌）。
      sharesAuthority: String(env.SHARES_AUTHORITY || "node").trim().toLowerCase(),
      sharesAuthorityTimeoutMs: num(env.SHARES_AUTHORITY_TIMEOUT_MS, 15000),
      // ── Stage 8.3：规则计算腿权威切流（迁移期双向开关）─────────────
      // node = 本进程 classic 规则腿（默认，行为不变）；csharp = 调 ForgeX.Api
      //（与 G-code 权威共用同一 sidecar origin）。
      rulesEngineAuthority: String(env.RULES_ENGINE_AUTHORITY || "node").trim().toLowerCase(),
      rulesEngineTimeoutMs: num(env.RULES_ENGINE_TIMEOUT_MS, 30000),
      // ── Stage 8.2：Partner SSO 与会话权威切流（迁移期双向开关）─────────────
      // node = 本进程内存会话（默认，行为不变）；csharp = /api/auth/infini/* 透明
      // 代理到 ForgeX.Api，会话存储与校验由 C# 承担，Node 业务路由经内部信任通道
      // 反查会话身份。凭据（INFINI_PARTNER_CLIENT_ID/SECRET、PUBLIC_BASE）继续作为
      // 启用判定，两侧配置需保持一致（C# 侧为 DirectSso:*）。
      authAuthority: String(env.AUTH_AUTHORITY || "node").trim().toLowerCase(),
      authAuthorityTimeoutMs: num(env.AUTH_AUTHORITY_TIMEOUT_MS, 15000),
      calibrationAuthorityEnabled: env.CALIBRATION_AUTHORITY_ENABLED !== "0",
      calibrationAuthorityTimeoutMs: num(env.CALIBRATION_AUTHORITY_TIMEOUT_MS, 30000),
      calibrationAuthorityMaxBytes: CALIBRATION_AUTHORITY_HARD_MAX_BYTES,
      serverRulesAuthority: env.SERVER_RULES_AUTHORITY !== "0",

      // 启动时探活 provider，失败自动降级为规则引擎（取代人工 INFINI_VERIFIED 门禁的下一步）
      probeProvider: env.PROBE_PROVIDER !== "0",
    },
    overrides || {}
  );

  cfg.gcodeAuthorityAllowRemote = cfg.gcodeAuthorityAllowRemote === true || cfg.gcodeAuthorityAllowRemote === "1";
  cfg.gcodeAuthorityUrl = normalizeAuthorityOrigin(cfg.gcodeAuthorityUrl, cfg.gcodeAuthorityAllowRemote);
  cfg.gcodeAuthorityTimeoutMs = Math.max(1, num(cfg.gcodeAuthorityTimeoutMs, 120000));
  cfg.gcodeAsyncJobsEnabled = cfg.gcodeAsyncJobsEnabled !== false && cfg.gcodeAsyncJobsEnabled !== "0";
  cfg.gcodeAuthorityInternalSecret = String(cfg.gcodeAuthorityInternalSecret || "");
  if (cfg.gcodeAuthorityInternalSecret && Buffer.byteLength(cfg.gcodeAuthorityInternalSecret, "utf8") < 32) {
    throw new Error("GCODE_AUTHORITY_INTERNAL_SECRET 至少需要 32 个 UTF-8 字节");
  }
  // 生产硬上限恒为 64 MiB；测试可通过 override 缩小，任何配置都不能放大。
  cfg.gcodeAuthorityMaxBytes = Math.min(
    GCODE_AUTHORITY_HARD_MAX_BYTES,
    Math.max(1, num(cfg.gcodeAuthorityMaxBytes, GCODE_AUTHORITY_HARD_MAX_BYTES))
  );
  cfg.analyticsAuthorityEnabled =
    cfg.analyticsAuthorityEnabled !== false && cfg.analyticsAuthorityEnabled !== "0";
  cfg.analyticsAuthorityTimeoutMs = Math.max(1, num(cfg.analyticsAuthorityTimeoutMs, 30000));
  cfg.analyticsAuthorityMaxBytes = Math.min(
    ANALYTICS_AUTHORITY_HARD_MAX_BYTES,
    Math.max(1, num(cfg.analyticsAuthorityMaxBytes, ANALYTICS_AUTHORITY_HARD_MAX_BYTES))
  );
  cfg.calibrationAuthorityEnabled =
    cfg.calibrationAuthorityEnabled !== false && cfg.calibrationAuthorityEnabled !== "0";
  cfg.calibrationAuthorityTimeoutMs = Math.max(1, num(cfg.calibrationAuthorityTimeoutMs, 30000));
  cfg.calibrationAuthorityMaxBytes = Math.min(
    CALIBRATION_AUTHORITY_HARD_MAX_BYTES,
    Math.max(1, num(cfg.calibrationAuthorityMaxBytes, CALIBRATION_AUTHORITY_HARD_MAX_BYTES))
  );
  cfg.serverRulesAuthority = cfg.serverRulesAuthority !== false && cfg.serverRulesAuthority !== "0";
  cfg.sharesAuthority = String(cfg.sharesAuthority || "node").trim().toLowerCase();
  if (!["node", "csharp"].includes(cfg.sharesAuthority)) {
    throw new Error("SHARES_AUTHORITY must be node or csharp");
  }
  if (cfg.sharesAuthority === "csharp" && !cfg.gcodeAuthorityUrl) {
    throw new Error("SHARES_AUTHORITY=csharp 需要先配置 GCODE_AUTHORITY_URL（共用同一 C# sidecar）");
  }
  cfg.sharesAuthorityTimeoutMs = Math.max(1, num(cfg.sharesAuthorityTimeoutMs, 15000));
  cfg.rulesEngineAuthority = String(cfg.rulesEngineAuthority || "node").trim().toLowerCase();
  if (!["node", "csharp"].includes(cfg.rulesEngineAuthority)) {
    throw new Error("RULES_ENGINE_AUTHORITY must be node or csharp");
  }
  if (cfg.rulesEngineAuthority === "csharp" && !cfg.gcodeAuthorityUrl) {
    throw new Error("RULES_ENGINE_AUTHORITY=csharp 需要先配置 GCODE_AUTHORITY_URL（共用同一 C# sidecar）");
  }
  cfg.rulesEngineTimeoutMs = Math.max(1, num(cfg.rulesEngineTimeoutMs, 30000));
  cfg.authAuthority = String(cfg.authAuthority || "node").trim().toLowerCase();
  if (!["node", "csharp"].includes(cfg.authAuthority)) {
    throw new Error("AUTH_AUTHORITY must be node or csharp");
  }
  if (cfg.authAuthority === "csharp" && !cfg.gcodeAuthorityUrl) {
    throw new Error("AUTH_AUTHORITY=csharp 需要先配置 GCODE_AUTHORITY_URL（共用同一 C# sidecar）");
  }
  if (cfg.authAuthority === "csharp" && !cfg.gcodeAuthorityInternalSecret) {
    throw new Error("AUTH_AUTHORITY=csharp 需要配置 GCODE_AUTHORITY_INTERNAL_SECRET（会话身份经内部信任通道解析）");
  }
  cfg.authAuthorityTimeoutMs = Math.max(1, num(cfg.authAuthorityTimeoutMs, 15000));
  if (!["file", "postgres", "postgresql"].includes(cfg.persistenceProvider)) {
    throw new Error("PERSISTENCE_PROVIDER must be file or postgres");
  }
  if (cfg.persistenceProvider !== "file" && !String(cfg.postgresUrl || "").trim()) {
    throw new Error("POSTGRES_URL is required when PERSISTENCE_PROVIDER=postgres");
  }
  cfg.postgresPoolMax = Math.min(50, Math.max(1, num(cfg.postgresPoolMax, 10)));
  cfg.postgresSsl = cfg.postgresSsl === true || cfg.postgresSsl === "1";

  /* ── provider 选择 ──────────────────────────
     优先级：强制降级 > 显式指定 > 自动探测（InfiniSynapse > OpenAI 兼容 > 本地规则）。
     "local" 指后端规则引擎——确定性聚合统计 + 假设检验，不是 AI，也不是假数据。
     旧名 "mock" 会让人误以为结果是编的，实际是真实计算，只是没有 AI 参与。 */
  var pref = String(cfg.providerPref || "auto").toLowerCase();
  var infiniReady = !!(cfg.infiniKey && cfg.infiniVerified);
  var openaiReady = !!(cfg.openaiKey && cfg.openaiModel);

  if (cfg.forceMock || pref === "local") {
    cfg.provider = "local";
    cfg.providerReason = cfg.forceMock ? "INFINI_MOCK=1 强制使用规则引擎" : "ANALYSIS_PROVIDER=local";
  } else if (pref === "infinisynapse") {
    cfg.provider = infiniReady ? "infinisynapse" : "local";
    cfg.providerReason = infiniReady
      ? "显式指定 InfiniSynapse"
      : "指定了 InfiniSynapse 但密钥/核准不全，降级为规则引擎";
  } else if (pref === "openai") {
    cfg.provider = openaiReady ? "openai" : "local";
    cfg.providerReason = openaiReady
      ? "显式指定 OpenAI 兼容端点（" + cfg.openaiModel + "）"
      : "指定了 OpenAI 兼容端点但缺 OPENAI_API_KEY / OPENAI_MODEL，降级为规则引擎";
  } else if (infiniReady) {
    cfg.provider = "infinisynapse";
    cfg.providerReason = "自动选择：InfiniSynapse 密钥就绪且端点已核准";
  } else if (openaiReady) {
    cfg.provider = "openai";
    cfg.providerReason = "自动选择：OpenAI 兼容端点已配置（" + cfg.openaiModel + "）";
  } else {
    cfg.provider = "local";
    cfg.providerReason = "未配置任何 AI provider，使用规则引擎（结论仍带置信区间与显著性检验）";
  }

  // 兼容旧字段：healthz 与前端读的是 mode/modeReason
  cfg.mode = cfg.provider === "local" ? "rules" : cfg.provider;
  cfg.modeReason = cfg.providerReason;
  return cfg;
}

module.exports = {
  getConfig,
  GCODE_AUTHORITY_HARD_MAX_BYTES,
  ANALYTICS_AUTHORITY_HARD_MAX_BYTES,
  CALIBRATION_AUTHORITY_HARD_MAX_BYTES,
};
