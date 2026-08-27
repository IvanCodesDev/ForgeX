/* Stage 8.2（V2 手册 §4.2 工作项 2）：AUTH_AUTHORITY=csharp 时的 Partner SSO 透明代理。

   会话存储与 OAuth 流程全部由 ForgeX.Api 承担（backend/src/ForgeX.Api/PartnerSsoService.cs），
   本模块只做两件事：
     1. /api/auth/infini/* 四条路由按原始 URL 转发到 sidecar，回传状态码、
        Set-Cookie（含多值）、Location 与响应体——浏览器契约与 node 模式逐字节一致；
     2. identity(req) 经内部信任通道（X-ForgeX-Internal-Token）反查 fx_session，
        使 Node 迁移期业务路由（配额、任务归属、AI 用户密钥）继续拿到同一身份。
   与 PartnerSSO 同接口（enabled/begin/callback/me/logout/identity/sweep），
   由 server/index.js 按 cfg.authAuthority 二选一注入 ctx.partnerSSO。 */
"use strict";

const http = require("http");
const https = require("https");
const { HttpError } = require("../lib/http");
const { cookies } = require("./partner-sso");

/* 转发白名单：请求只透传 cookie/accept（登录路由不消费 Authorization，
   也绝不把 API Key 泄给会话服务）；响应只透传浏览器契约需要的头。 */
const RESPONSE_HEADERS = ["content-type", "location", "set-cookie", "cache-control", "content-length"];

class PartnerSSOProxy {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    // 启用判定与本地实现同源：凭据在 Node 环境保留为开关（C# 侧 DirectSso:* 配置同一套值）。
    this.enabled = !!(cfg.infiniPartnerClientId && cfg.infiniPartnerClientSecret && cfg.publicBase);
  }

  _request(method, pathWithQuery, headers) {
    const target = new URL(pathWithQuery, this.cfg.gcodeAuthorityUrl);
    const transport = target.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const upstream = transport.request(
        target,
        { method, headers, timeout: this.cfg.authAuthorityTimeoutMs },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        }
      );
      upstream.on("timeout", () => upstream.destroy(new Error("auth authority timeout")));
      upstream.on("error", reject);
      upstream.end();
    });
  }

  async _proxy(req, res, label) {
    const headers = {};
    if (typeof req.headers.cookie === "string") headers.cookie = req.headers.cookie;
    if (typeof req.headers.accept === "string") headers.accept = req.headers.accept;
    let response;
    try {
      response = await this._request(req.method, req.url, headers);
    } catch (error) {
      this.log.warn("partner sso proxy failed", { route: label, error: error.message });
      throw new HttpError(502, "InfiniSynapse 登录服务暂时不可用");
    }
    const out = {};
    for (const name of RESPONSE_HEADERS) {
      if (response.headers[name] != null) out[name] = response.headers[name];
    }
    res.writeHead(response.status, out);
    res.end(response.body);
  }

  begin(req, res) {
    return this._proxy(req, res, "login");
  }

  callback(req, res) {
    return this._proxy(req, res, "callback");
  }

  me(req, res) {
    return this._proxy(req, res, "me");
  }

  logout(req, res) {
    return this._proxy(req, res, "logout");
  }

  /* 会话反查。无 fx_session cookie 时零网络开销直接返回 null；
     sidecar 不可达时对携带会话的请求 fail-closed（502），
     不携带会话的请求不受影响（API Key / 匿名身份照常解析）。 */
  async identity(req) {
    const token = cookies(req).fx_session || "";
    if (!token) return null;
    let response;
    try {
      response = await this._request("GET", "/api/v1/auth/infini/session", {
        accept: "application/json",
        "x-forgex-internal-token": this.cfg.gcodeAuthorityInternalSecret,
        "x-forgex-session-token": token,
      });
    } catch (error) {
      this.log.warn("partner sso session resolve failed", { error: error.message });
      throw new HttpError(502, "InfiniSynapse 登录服务暂时不可用");
    }
    if (response.status === 404) return null;
    if (response.status !== 200) {
      this.log.warn("partner sso session resolve rejected", { status: response.status });
      throw new HttpError(502, "InfiniSynapse 登录服务暂时不可用");
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.user || !parsed.user.id) {
      this.log.warn("partner sso session resolve malformed", { status: response.status });
      throw new HttpError(502, "InfiniSynapse 登录服务暂时不可用");
    }
    return { token, user: parsed.user, apiKey: String(parsed.apiKey || "") };
  }

  /* 会话由 C# 持有并清扫（PartnerSsoService 内置 60s 周期 + 惰性过期）。 */
  sweep() {}
}

module.exports = { PartnerSSOProxy };
