/* 知识库路由：登记工艺术语/材料参数/设备手册文档，供分析时检索注入。

   P3 起检索已真实接通（services/retrieval.js，BM25 关键词检索）：
   提问时按问题检索 top-k 相关片段注入 AI provider 的提示词。

   两个诚实性约束：
     1. **只有 AI provider 会用到它**。规则引擎是确定性统计，不读自然语言知识——
        所以在规则引擎模式下必须如实告知「本次配置下不会被使用」。
     2. **检索不到就不注入**。宁可不给，也不给无关片段——
        往提示词里塞无关内容只会干扰模型。 */
"use strict";
const { HttpError, readJson, sendJson } = require("../lib/http");
const { resolveIdentity } = require("../lib/identity");
const { retrieve } = require("../services/retrieval");

function register(router, ctx) {
  const { knowledge, tasks } = ctx;

  router.add("POST", /^\/api\/knowledge$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    const body = await readJson(req, 600 * 1024);
    if (typeof body.text !== "string") throw new HttpError(400, "text 字段不能为空");
    const doc = await knowledge.create(body.name, body.text, identity.tenantId);
    const aiEnabled = !!(tasks && tasks.provider && tasks.provider.capabilities.ai);
    sendJson(res, 201, {
      knowledgeId: doc.id,
      name: doc.name,
      chunks: doc.text.length,
      // 机器可读的能力标记：前端据此决定是否展示知识库相关 UI
      retrievalEnabled: aiEnabled,
      note: aiEnabled
        ? "已登记。提问时会按问题检索相关片段注入 AI 提示词（BM25 关键词检索，检索不到则不注入）。" +
          "存储由当前持久化 provider 管理，TTL 到期后失效。"
        : "已登记，但**当前配置下不会被使用**：正在运行的是规则引擎（确定性统计，不读自然语言知识）。" +
          "配置 AI provider（INFINI_API_KEY 或 OPENAI_API_KEY）后检索才会生效。存储由当前持久化 provider 管理，TTL 到期后失效。",
    });
  });

  /** 检索预览：让用户能自己验证「问这个问题时会检索到什么」，而不是盲信 */
  router.add("POST", /^\/api\/knowledge\/search$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    const body = await readJson(req, 8 * 1024);
    const q = String(body.question || "").trim();
    if (!q) throw new HttpError(400, "question 不能为空");
    if (typeof knowledge.ready === "function") await knowledge.ready(identity.tenantId);
    const docs = knowledge.all(identity.tenantId);
    const hits = retrieve(docs, q, { topK: Number(body.topK) || 4 });
    sendJson(res, 200, {
      question: q,
      docCount: docs.length,
      hits: hits,
      note: hits.length ? undefined : "没有检索到相关片段——分析时不会注入任何知识内容。",
    });
  });
}

module.exports = { register };
