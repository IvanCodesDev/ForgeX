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
  }, overrides || {});

  // 真实调用需同时满足：有 key + 端点核准（INFINI_VERIFIED=1）+ 未强制降级
  // mode="rules" 指后端规则引擎（确定性聚合统计，不是 AI，也不是假数据——
  // 旧名 "mock" 会让人误以为结果是编的，实际是真实计算，只是没有 AI 参与）。
  cfg.mode = (!cfg.forceMock && cfg.infiniKey && cfg.infiniVerified) ? "infinisynapse" : "rules";
  cfg.modeReason = cfg.forceMock ? "INFINI_MOCK=1 强制使用规则引擎"
    : !cfg.infiniKey ? "未配置 INFINI_API_KEY，使用规则引擎"
    : !cfg.infiniVerified ? "端点未核准（INFINI_VERIFIED≠1），使用规则引擎"
    : "密钥就绪且端点已核准，使用 InfiniSynapse 云端 AI";
  return cfg;
}

module.exports = { getConfig };
