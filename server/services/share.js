/* 分享页存储：token → 报告快照。

   存快照而非任务引用：任务被 TTL 清理后分享页依然可开。

   P4 起落盘。此前是纯内存，于是「分享页 24 小时有效」这句话在每次重启时都变成谎言——
   README 里只好写成「指进程存活期内」。现在它是真的 24 小时（或你配置的时长）。

   同时支持撤销：分享出去的东西必须能收回来，这是分享功能的基本义务。 */
"use strict";
const crypto = require("crypto");
const { FileStore } = require("../lib/store");

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

class ShareStore {
  constructor(cfg, log) {
    this.ttlMs = (cfg && cfg.shareTtlMs) || DEFAULT_TTL_MS;
    this.map = new FileStore({
      dir: (cfg && cfg.dataDir) || "",
      name: "shares",
      ttlMs: this.ttlMs,
      max: 2000,
      log: log,
    });
  }

  create(task, opt) {
    opt = opt || {};
    const token = crypto.randomBytes(9).toString("hex");
    // 撤销密钥：只在创建时返回一次，用它才能撤销这条分享
    const revokeKey = crypto.randomBytes(9).toString("hex");
    const ttl = opt.ttlMs && opt.ttlMs > 0 ? Math.min(opt.ttlMs, this.ttlMs) : this.ttlMs;
    const rec = {
      id: token,
      token,
      revokeHash: crypto.createHash("sha256").update(revokeKey).digest("hex"),
      report: task.report,
      question: task.question,
      engine: task.engine,
      owner: task.caller,
      upstreamTaskId: task.upstreamTaskId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    this.map.set(rec);
    return { token, revokeKey, expiresAt: rec.expiresAt };
  }

  get(token) {
    return this.map.get(token);
  }

  /** 撤销：必须持有创建时返回的 revokeKey。密钥只存哈希，比较用常数时间。 */
  revoke(token, revokeKey) {
    const rec = this.map.get(token);
    if (!rec) return { ok: false, reason: "not_found" };
    const given = crypto.createHash("sha256").update(String(revokeKey || "")).digest();
    const want = Buffer.from(rec.revokeHash, "hex");
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return { ok: false, reason: "bad_key" };
    }
    this.map.delete(token);
    return { ok: true };
  }

  sweep(now) {
    this.map.sweep(now);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { ShareStore };
