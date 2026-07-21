/* 知识库路由：上传工艺术语/材料参数/设备手册文档（RAG 素材）。 */
"use strict";
const { HttpError, readJson, sendJson } = require("../lib/http");

function register(router, ctx) {
  const { knowledge, cfg } = ctx;

  router.add("POST", /^\/api\/knowledge$/, async (req, res) => {
    const body = await readJson(req, 600 * 1024);
    if (typeof body.text !== "string") throw new HttpError(400, "text 字段不能为空");
    const doc = knowledge.create(body.name, body.text);
    sendJson(res, 201, {
      knowledgeId: doc.id,
      name: doc.name,
      note: cfg.mode === "infinisynapse"
        ? "已登记，将在分析任务中注入"
        : "已登记（演示模式暂存内存；InfiniRAG 接入待附录 B-6 端点核准）",
    });
  });
}

module.exports = { register };
