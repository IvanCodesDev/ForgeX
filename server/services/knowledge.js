/* 知识库文档存储（内存态）：工艺术语表 / 材料参数 / 设备手册。

   ⚠ 现状：**存储管线可用，但没有任何消费方**——all() 目前无人调用，
   文档不会进入分析提示词。请勿在任何用户可见文案中把它描述成已生效的 RAG。
   检索接入计划见 doc/优化文档.md §5 P3.10。 */
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
