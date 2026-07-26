/* 知识库路由：登记工艺术语/材料参数/设备手册文档。

   ⚠ 当前状态：**只存不用**。文档存进内存后不会进入任何分析任务的提示词，
   没有任何检索（RAG）实现——KnowledgeStore.all() 全仓库无调用方。
   本路由保留的唯一理由是它是 RAG 落地时要复用的存储管线；
   在检索真正接通之前，响应里绝不能出现「将被使用/将被注入」之类的措辞。
   实现计划见 doc/优化文档.md §5 P3.10。 */
"use strict";
const { HttpError, readJson, sendJson } = require("../lib/http");

/** 未实现能力的统一口径——改这里之前必须先有真实实现 */
const NOT_IMPLEMENTED_NOTE =
  "已登记到内存（进程重启或 TTL 到期即失效）。注意：当前版本尚未实现检索，" +
  "该文档不会进入任何分析任务的提示词，对分析结果没有影响。";

function register(router, ctx) {
  const { knowledge } = ctx;

  router.add("POST", /^\/api\/knowledge$/, async (req, res) => {
    const body = await readJson(req, 600 * 1024);
    if (typeof body.text !== "string") throw new HttpError(400, "text 字段不能为空");
    const doc = knowledge.create(body.name, body.text);
    sendJson(res, 201, {
      knowledgeId: doc.id,
      name: doc.name,
      retrievalEnabled: false,        // 机器可读的能力标记，前端据此决定是否展示相关 UI
      note: NOT_IMPLEMENTED_NOTE,
    });
  });
}

module.exports = { register, NOT_IMPLEMENTED_NOTE };
