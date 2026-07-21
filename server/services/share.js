/* 分享页存储：token → 报告快照。存快照而非任务引用，任务被 TTL 清理后分享页依然可开。 */
"use strict";
const crypto = require("crypto");

const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

class ShareStore {
  constructor() {
    this.map = new Map();
  }

  create(task) {
    const token = crypto.randomBytes(9).toString("hex");
    this.map.set(token, {
      token,
      report: task.report,
      question: task.question,
      engine: task.engine,
      upstreamTaskId: task.upstreamTaskId,
      createdAt: Date.now(),
    });
    return token;
  }

  get(token) {
    const s = this.map.get(String(token || ""));
    if (!s) return null;
    if (Date.now() - s.createdAt > SHARE_TTL_MS) { this.map.delete(s.token); return null; }
    return s;
  }

  sweep(now) {
    for (const [t, s] of this.map) {
      if (now - s.createdAt > SHARE_TTL_MS) this.map.delete(t);
    }
  }
}

module.exports = { ShareStore };
