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
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function getConfig(overrides) {
  loadEnvFile(path.join(__dirname, ".env"));
  const env = process.env;
  const cfg = Object.assign({
    host: env.HOST || "127.0.0.1",          // 部署平台一般要求 HOST=0.0.0.0
    port: num(env.PORT, 8787),
    staticRoot: path.resolve(__dirname, ".."),
    publicBase: env.PUBLIC_BASE || "",       // 分享链接前缀（部署后填公网域名）
    allowOrigins: (env.ALLOW_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
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
  }, overrides || {});

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
    cfg.providerReason = infiniReady ? "显式指定 InfiniSynapse"
      : "指定了 InfiniSynapse 但密钥/核准不全，降级为规则引擎";
  } else if (pref === "openai") {
    cfg.provider = openaiReady ? "openai" : "local";
    cfg.providerReason = openaiReady ? "显式指定 OpenAI 兼容端点（" + cfg.openaiModel + "）"
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

module.exports = { getConfig };
