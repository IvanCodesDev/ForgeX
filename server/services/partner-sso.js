/* InfiniSynapse Partner SSO（接入路线 B）。
   官方流程：创建登录会话 → 浏览器授权 → code 回调 → 服务端兑换用户资料。
   clientSecret 与用户 Partner API Key 始终只存在服务端。 */
"use strict";

const crypto = require("crypto");
const { HttpError, sendJson } = require("../lib/http");

const OAUTH_TTL_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function publicPath(publicBase) {
  try {
    const p = new URL(publicBase).pathname || "/";
    return p.endsWith("/") ? p : p + "/";
  } catch (e) {
    return "/";
  }
}

class PartnerSSO {
  constructor(cfg, log, fetchImpl) {
    this.cfg = cfg;
    this.log = log;
    this.fetch = fetchImpl || fetch;
    this.pending = new Map();
    this.sessions = new Map();
    this.enabled = !!(cfg.infiniPartnerClientId && cfg.infiniPartnerClientSecret && cfg.publicBase);
    this.cookiePath = publicPath(cfg.publicBase);
    this.secure = /^https:/i.test(cfg.publicBase || "");
  }

  _cookie(name, value, maxAge) {
    const bits = [name + "=" + encodeURIComponent(value || ""), "Path=" + this.cookiePath, "HttpOnly", "SameSite=Lax"];
    if (this.secure) bits.push("Secure");
    if (Number.isFinite(maxAge)) bits.push("Max-Age=" + Math.max(0, Math.floor(maxAge)));
    return bits.join("; ");
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      "X-Client-Id": this.cfg.infiniPartnerClientId,
      "X-Client-Secret": this.cfg.infiniPartnerClientSecret,
    };
  }

  async _post(path, body) {
    const res = await this.fetch(this.cfg.infiniPartnerApi.replace(/\/$/, "") + path, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.code !== 200 || !json.data) {
      this.log.warn("partner sso upstream rejected", {
        path,
        status: res.status,
        message: json && json.message ? String(json.message).slice(0, 160) : "invalid response",
      });
      throw new HttpError(502, "InfiniSynapse 登录服务暂时不可用");
    }
    return json.data;
  }

  async begin(req, res) {
    if (!this.enabled) throw new HttpError(503, "InfiniSynapse 登录尚未配置");
    const state = crypto.randomBytes(24).toString("hex");
    const browserNonce = crypto.randomBytes(24).toString("hex");
    this.pending.set(browserNonce, { state, createdAt: Date.now() });

    const base = this.cfg.publicBase.replace(/\/$/, "");
    const data = await this._post("/auth/partner/sessions", {
      returnUrl: base + "/api/auth/infini/callback",
      cancelUrl: base + "/?login=cancelled",
      state,
      metadata: { source: "forgex-insight", integration: "partner-sso-b" },
    });
    if (!data.entryUrl || !/^https:\/\/app\.infinisynapse\.(cn|com)\//i.test(data.entryUrl)) {
      throw new HttpError(502, "InfiniSynapse 返回了无效登录地址");
    }
    res.writeHead(302, {
      Location: data.entryUrl,
      "Cache-Control": "no-store",
      "Set-Cookie": this._cookie("fx_oauth", browserNonce, 600),
    });
    res.end();
  }

  async callback(req, res) {
    if (!this.enabled) throw new HttpError(503, "InfiniSynapse 登录尚未配置");
    const u = new URL(req.url, "http://local");
    const code = u.searchParams.get("code") || "";
    const state = u.searchParams.get("state") || "";
    const nonce = cookies(req).fx_oauth || "";
    const pending = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (!code || !pending || !safeEqual(state, pending.state) || Date.now() - pending.createdAt > OAUTH_TTL_MS) {
      throw new HttpError(400, "登录回调校验失败，请重新登录");
    }

    const data = await this._post("/auth/partner/token", {
      code,
      grant_type: "authorization_code",
      withApiKey: true,
    });
    if (!data.user || !data.user.id) throw new HttpError(502, "InfiniSynapse 未返回有效用户资料");

    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      user: {
        id: String(data.user.id),
        nickname: String(data.user.nickname || data.user.username || "InfiniSynapse 用户"),
        email: String(data.user.email || ""),
        avatar: String(data.user.avatar || ""),
      },
      apiKey: String(data.apiKey || ""),
      expiresAt: Date.now() + this.cfg.loginSessionTtlMs,
    });
    this.log.info("partner sso login completed", {
      userId: String(data.user.id),
      hasPartnerKey: !!data.apiKey,
    });

    const base = this.cfg.publicBase.replace(/\/$/, "");
    res.writeHead(302, {
      Location: base + "/?login=success",
      "Cache-Control": "no-store",
      "Set-Cookie": [
        this._cookie("fx_session", token, Math.floor(this.cfg.loginSessionTtlMs / 1000)),
        this._cookie("fx_oauth", "", 0),
      ],
    });
    res.end();
  }

  identity(req) {
    const token = cookies(req).fx_session || "";
    const hit = this.sessions.get(token);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { token, user: hit.user, apiKey: hit.apiKey };
  }

  me(req, res) {
    const hit = this.identity(req);
    sendJson(res, 200, {
      enabled: this.enabled,
      authenticated: !!hit,
      user: hit ? hit.user : null,
      canUseAi: !!(hit && hit.apiKey),
      integration: "InfiniSynapse Partner SSO (B)",
    });
  }

  logout(req, res) {
    const hit = this.identity(req);
    if (hit) this.sessions.delete(hit.token);
    res.setHeader("Set-Cookie", this._cookie("fx_session", "", 0));
    sendJson(res, 200, { ok: true });
  }

  sweep(now) {
    for (const [key, value] of this.pending) {
      if (now - value.createdAt > OAUTH_TTL_MS) this.pending.delete(key);
    }
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
  }
}

function register(router, ctx) {
  const sso = ctx.partnerSSO;
  router.add("GET", /^\/api\/auth\/infini\/login$/, (req, res) => sso.begin(req, res));
  router.add("GET", /^\/api\/auth\/infini\/callback$/, (req, res) => sso.callback(req, res));
  router.add("GET", /^\/api\/auth\/infini\/me$/, (req, res) => sso.me(req, res));
  router.add("POST", /^\/api\/auth\/infini\/logout$/, (req, res) => sso.logout(req, res));
}

module.exports = { PartnerSSO, register, safeEqual, cookies, publicPath };
