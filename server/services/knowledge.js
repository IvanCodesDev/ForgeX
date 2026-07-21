/* 知识库文档存储（内存态）：工艺术语表 / 材料参数 / 设备手册。
   演示模式仅登记；InfiniSynapse RAG 接口核准后（附录 B-6）在建任务时注入。 */
"use strict";
const crypto = require("crypto");
const { HttpError } = require("../lib/http");

const MAX_DOCS = 50;
const MAX_TEXT = 512 * 1024;

class KnowledgeStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map();
  }

  create(name, text) {
    const body = String(text || "");
    if (!body.trim()) throw new HttpError(400, "知识文档内容为空");
    if (body.length > MAX_TEXT) throw new HttpError(413, "知识文档超过 512KB");
    if (this.map.size >= MAX_DOCS) {
      const oldestKey = this.map.keys().next().value;   // Map 迭代序 = 插入序
      this.map.delete(oldestKey);
    }
    const id = "kb_" + crypto.randomBytes(8).toString("hex");
    const doc = { id, name: String(name || "knowledge.md").slice(0, 80), text: body, createdAt: Date.now() };
    this.map.set(id, doc);
    return doc;
  }

  all() {
    return [...this.map.values()];
  }

  sweep(now) {
    for (const [id, doc] of this.map) {
      if (now - doc.createdAt > this.cfg.taskTtlMs) this.map.delete(id);
    }
  }
}

module.exports = { KnowledgeStore };
