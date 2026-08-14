/* 知识库文档存储（内存态）：工艺术语表 / 材料参数 / 设备手册。

   AI provider 的分析路径会按问题检索 top-k 片段并注入提示词；规则引擎不读取自然语言文档。
   存储仍是单实例文件态，阶段 3 的共享租户仓储尚未启用。
   */
"use strict";
const crypto = require("crypto");
const { HttpError } = require("../lib/http");
const { FileStore } = require("../lib/store");

const MAX_DOCS = 50;
const MAX_TEXT = 512 * 1024;

class KnowledgeStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.map = new FileStore({
      dir: cfg.dataDir, name: "knowledge", ttlMs: cfg.taskTtlMs, max: MAX_DOCS, log: log,
    });
  }

  create(name, text, owner) {
    const body = String(text || "");
    if (!body.trim()) throw new HttpError(400, "知识文档内容为空");
    if (body.length > MAX_TEXT) throw new HttpError(413, "知识文档超过 512KB");
    const id = "kb_" + crypto.randomBytes(8).toString("hex");
    const doc = {
      id,
      name: String(name || "knowledge.md").slice(0, 80),
      text: body,
      owner: String(owner || "legacy:unowned"),
      createdAt: Date.now(),
    };
    this.map.set(doc);        // FileStore 自带容量淘汰
    return doc;
  }

  all(owner) {
    const docs = this.map.all();
    if (owner == null) return docs;
    return docs.filter((doc) => doc.owner === owner);
  }

  sweep(now) {
    this.map.sweep(now);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { KnowledgeStore };
