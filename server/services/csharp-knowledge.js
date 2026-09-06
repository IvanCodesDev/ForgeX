/* 知识库存储的 C# 权威门面（KNOWLEDGE_AUTHORITY=csharp）。

   登记 / 列表 / 检索都经可信通道转给 ForgeX.Api（/api/v1/knowledge*）。
   TaskStore.knowledgeFor 仍同步调用 all(owner)，所以沿 PostgresKnowledgeStore 的
   ready(owner) → all(owner) 约定：ready 每次向 C# 取最新文档列表并缓存到进程内，
   all 只读缓存。缓存按 owner 键、有上限，只是请求内的临时视图，不是存储。 */
"use strict";
const { HttpError } = require("../lib/http");
const { storageId } = require("../lib/identity");
const { authorityRequest, authorityProblem, AuthorityUnavailableError } = require("../lib/authority-client");

const UNAVAILABLE = "知识库服务暂不可用，请稍后再试";
const MAX_CACHED_OWNERS = 256;

function identityFor(owner) {
  const value = String(owner || "legacy:unowned");
  return { tenantId: value, caller: value };
}

class CsharpKnowledgeStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.cache = new Map();
    this.probePromise = null;
  }

  async _call(identity, method, pathname, payload) {
    try {
      return await authorityRequest(this.cfg, identity, method, pathname, payload);
    } catch (error) {
      if (error instanceof AuthorityUnavailableError) {
        this.log.warn("knowledge authority unreachable", { method, pathname, error: error.message });
        throw new HttpError(502, UNAVAILABLE);
      }
      throw error;
    }
  }

  _reject(response, context) {
    const problem = authorityProblem(response);
    if (problem && problem.status >= 400 && problem.status < 500 && problem.title) {
      throw new HttpError(problem.status, problem.title);
    }
    this.log.warn("knowledge authority rejected", { context, status: response.status });
    throw new HttpError(502, UNAVAILABLE);
  }

  _probe() {
    if (!this.probePromise) {
      this.probePromise = this._call(identityFor("probe"), "GET", "/api/v1/knowledge", null)
        .then((response) => {
          if (response.status !== 200) throw new Error("knowledge authority probe returned " + response.status);
        })
        .catch((error) => {
          this.probePromise = null;
          throw error;
        });
    }
    return this.probePromise;
  }

  async ready(owner) {
    if (owner == null) return this._probe();
    const identity = identityFor(owner);
    const response = await this._call(identity, "GET", "/api/v1/knowledge", null);
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || !Array.isArray(parsed.docs)) this._reject(response, "list");
    const docs = parsed.docs.map((doc) => ({
      id: doc.knowledgeId,
      name: doc.name,
      text: doc.text,
      owner: identity.tenantId,
      ownerId: storageId(identity.tenantId, "ow_"),
      tenantId: storageId(identity.tenantId, "tn_"),
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
    }));
    this.cache.delete(identity.tenantId);
    this.cache.set(identity.tenantId, docs);
    while (this.cache.size > MAX_CACHED_OWNERS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  async create(name, text, owner) {
    const identity = identityFor(owner);
    const body = String(text || "");
    const response = await this._call(identity, "POST", "/api/v1/knowledge", { name, text });
    const parsed = response.status === 201 ? response.json() : null;
    if (!parsed || typeof parsed.knowledgeId !== "string") this._reject(response, "create");
    this.cache.delete(identity.tenantId);
    return {
      id: parsed.knowledgeId,
      name: parsed.name,
      // 路由回报 chunks = doc.text.length；C# 的 chunks 与之同义（UTF-16 单元数）。
      text: body,
      chunks: parsed.chunks,
      owner: identity.tenantId,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  }

  /** 检索预览直接由 C#（同一 BM25 实现）完成，响应形状与 Node 路由一致。 */
  async search(owner, question, topK) {
    const identity = identityFor(owner);
    const response = await this._call(identity, "POST", "/api/v1/knowledge/search", { question, topK });
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || !Array.isArray(parsed.hits)) this._reject(response, "search");
    return parsed;
  }

  all(owner) {
    if (owner == null) return [];
    return (this.cache.get(identityFor(owner).tenantId) || []).slice();
  }

  /** 清扫与容量由 C# ResourceSweeper 负责；本进程无状态。 */
  sweep() {}

  /** Node 自身不再存知识文档；权威 gauge 在 C# /metrics 的 forgex_knowledge_docs。 */
  get size() {
    return 0;
  }
}

module.exports = { CsharpKnowledgeStore };
