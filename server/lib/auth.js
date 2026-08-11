/* 轻量鉴权 —— 只在需要时启用，本地开发零摩擦。

   设计取舍：

   - **默认关闭**。本项目的第一使用场景是「clone 下来 node server/index.js 即起」，
     强制鉴权会毁掉这个体验。配置了 API_KEYS 才启用。
   - **普通分析接口中鉴权主要是配额身份来源**。即使不带 key 也能用规则引擎——
     真正需要按人计费的是 AI 调用，而不是「看不看得到页面」。
     P8 校准审批写接口是明确例外：它始终要求 key，并用不同 key 实施四眼复核。
   - **常数时间比较**。key 比较用逐字节异或，不用 ===，避免时序侧信道。
     这个场景下泄漏风险很低，但正确做法本身不费事。 */
"use strict";

const crypto = require("crypto");

/** 常数时间字符串比较（长度不同直接返回 false，但仍走完比较避免长度侧信道放大） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // timingSafeEqual 要求等长；用固定长度摘要再比，长度差异不构成额外信息
    return crypto.timingSafeEqual(crypto.createHash("sha256").update(ba).digest(),
      crypto.createHash("sha256").update(bb).digest());
  }
  return crypto.timingSafeEqual(ba, bb);
}

class Auth {
  /**
   * @param cfg.apiKeys      逗号分隔的合法 key 列表；为空则不启用鉴权
   * @param cfg.calibrationReviewKeys 逗号分隔的校准审核 key；不从 apiKeys 隐式继承
   * @param cfg.requireAuth  为 true 时未携带合法 key 直接 401（默认 false：只用于识别身份）
   */
  constructor(cfg, log) {
    this.keys = (cfg.apiKeys || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.reviewKeys = (cfg.calibrationReviewKeys || "").split(",").map((s) => s.trim()).filter(Boolean);
    this.required = !!cfg.requireAuth;
    this.enabled = this.keys.length > 0;
    this.reviewEnabled = this.reviewKeys.length > 0;
    this.log = log;
    if (this.required && !this.enabled) {
      // 配置矛盾必须响亮地说出来，否则会以为自己受保护、实际大门敞开
      this.log.warn("REQUIRE_AUTH=1 但未配置 API_KEYS —— 鉴权无法生效，已按未启用处理");
      this.required = false;
    }
    if (this.enabled) this.log.info("auth enabled", { keys: this.keys.length, required: this.required });
    if (this.reviewEnabled) this.log.info("calibration review auth enabled", { keys: this.reviewKeys.length });
  }

  /** 从请求里取出 key：Authorization: Bearer xxx 或 X-API-Key */
  keyOf(req) {
    const h = req.headers["authorization"];
    if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
    const x = req.headers["x-api-key"];
    return x ? String(x).trim() : "";
  }

  /**
   * 识别调用方身份。
   * @returns {{authenticated, caller, keyId}} caller 是配额计数的主体
   */
  identify(req, ip) {
    const key = this.keyOf(req);
    const matched = this._match(this.keys, key);
    if (matched) return { authenticated: true, caller: "key:" + matched.keyId, keyId: matched.keyId };
    return { authenticated: false, caller: "ip:" + ip, keyId: null };
  }

  /**
   * 识别校准审核角色。审核表独立于普通 API key 表，调用方不会因持有普通 key
   * 自动获得审核权。返回的 keyId 与 identify() 使用同一摘要算法，以便存储层
   * 对两表重叠的 key 继续执行四眼原则。
   */
  identifyReviewer(req) {
    const matched = this._match(this.reviewKeys, this.keyOf(req));
    return matched || { authenticated: false, keyId: null };
  }

  _match(keys, candidate) {
    if (!candidate || keys.length === 0) return null;
    let matchedKey = null;
    // 不在首次命中时提前退出，避免 key 在列表中的位置影响比较次数。
    for (const configured of keys) {
      if (safeEqual(configured, candidate)) matchedKey = configured;
    }
    if (!matchedKey) return null;
    // 只用摘要前 8 位标识身份，完整 key 绝不进日志或响应。
    const keyId = crypto.createHash("sha256").update(matchedKey).digest("hex").slice(0, 8);
    return { authenticated: true, keyId };
  }

  /** requireAuth 模式下的守卫；返回 null 表示放行，否则返回错误对象 */
  guard(identity) {
    if (!this.required || identity.authenticated) return null;
    const err = new Error("需要 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 头中提供");
    err.status = 401;
    return err;
  }
}

module.exports = { Auth, safeEqual };
