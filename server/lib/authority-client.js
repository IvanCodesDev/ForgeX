/* ForgeX.Api（C# 权威 sidecar）的小体量 JSON 调用客户端。

   Stage 8.1 时它长在 routes/share.js 里；Stage 8.6a 数据源 / 知识库 / 校准治理三条
   资源腿都要走同一条可信通道，于是抽到这里共用：
     - 与 gcode-authority.js 一致的匿名化上下文：C# 只见哈希后的 tenant/owner；
     - 可选 extra headers（校准治理的 actor 头）；
     - 网络错误 / 超时统一抛 AuthorityUnavailableError，各路由映射成自己的 502 文案；
     - problem+json 解析成 { status, code, title }，让路由把 C# 4xx 原样透传为 { error }。 */
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");

class AuthorityUnavailableError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "AuthorityUnavailableError";
  }
}

/* 与 gcode-authority.js 一致的匿名化上下文：C# 只见哈希后的 tenant/owner。 */
function opaqueContextId(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/**
 * 发起一次 JSON 调用。
 * @param cfg        服务配置（gcodeAuthorityUrl / gcodeAuthorityInternalSecret / resourceAuthorityTimeoutMs）
 * @param identity   { tenantId, caller } | null —— null 表示公开调用，不注入任何身份上下文
 * @param method     HTTP 方法
 * @param pathname   sidecar 上的路径
 * @param payload    JSON 请求体（null 表示无请求体）
 * @param options    { timeoutMs?, headers? }
 * @returns { status, contentType, body: Buffer, json() }
 */
function authorityRequest(cfg, identity, method, pathname, payload, options) {
  const opts = options || {};
  const target = new URL(pathname, cfg.gcodeAuthorityUrl);
  const transport = target.protocol === "https:" ? https : http;
  const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
  const headers = { accept: "application/json" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  if (cfg.gcodeAuthorityInternalSecret && identity) {
    headers["x-forgex-internal-token"] = cfg.gcodeAuthorityInternalSecret;
    headers["x-forgex-tenant-id"] = opaqueContextId("tn_", identity.tenantId);
    headers["x-forgex-owner-id"] = opaqueContextId("ow_", identity.caller);
  }
  for (const [name, value] of Object.entries(opts.headers || {})) {
    if (value != null) headers[name.toLowerCase()] = String(value);
  }
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || Number(cfg.resourceAuthorityTimeoutMs) || 15000);
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(new AuthorityUnavailableError(error.message || "authority unavailable", error));
    const upstream = transport.request(target, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 502,
          contentType: res.headers["content-type"] || "application/json",
          body: raw,
          json() {
            try {
              return JSON.parse(raw.toString("utf8"));
            } catch {
              return null;
            }
          },
        });
      });
      res.on("error", fail);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("authority timeout")));
    upstream.on("error", fail);
    if (body) upstream.write(body);
    upstream.end();
  });
}

/** 解析 C# problem+json → { status, code, title }；不是 problem 形状时返回 null。 */
function authorityProblem(response) {
  const parsed = response && typeof response.json === "function" ? response.json() : null;
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.title !== "string" && typeof parsed.code !== "string") return null;
  return {
    status: Number(parsed.status) || response.status,
    code: typeof parsed.code === "string" ? parsed.code : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
  };
}

module.exports = { authorityRequest, opaqueContextId, authorityProblem, AuthorityUnavailableError };
