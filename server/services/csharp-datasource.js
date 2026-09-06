/* 数据源存储的 C# 权威门面（DATASOURCES_AUTHORITY=csharp）。

   本进程不再落任何数据源：上传与读取都经可信通道转给 ForgeX.Api（/api/v1/datasources），
   C# 侧按 file / postgres provider 存储并负责 TTL 清扫与容量淘汰。
   对路由与 TaskStore 暴露的形状与 DatasourceStore 一致（create → ds.rows.length 等），
   路由代码零改动。 */
"use strict";
const { HttpError } = require("../lib/http");
const { storageId } = require("../lib/identity");
const { authorityRequest, authorityProblem, AuthorityUnavailableError } = require("../lib/authority-client");

const UNAVAILABLE = "数据源服务暂不可用，请稍后再试";
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function identityFor(owner) {
  const value = String(owner || "legacy:unowned");
  return { tenantId: value, caller: value };
}

class CsharpDatasourceStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.probePromise = null;
  }

  /** 探活：内置 sample 在 C# 侧永远存在，拿不到就是 provider 未启用或 sidecar 不可达。 */
  ready() {
    if (!this.probePromise) {
      this.probePromise = this._call(identityFor("probe"), "GET", "/api/v1/datasources/sample", null)
        .then((response) => {
          if (response.status !== 200) throw new Error("datasources authority probe returned " + response.status);
        })
        .catch((error) => {
          this.probePromise = null;
          throw error;
        });
    }
    return this.probePromise;
  }

  async _call(identity, method, pathname, payload) {
    try {
      return await authorityRequest(this.cfg, identity, method, pathname, payload);
    } catch (error) {
      if (error instanceof AuthorityUnavailableError) {
        this.log.warn("datasources authority unreachable", { method, pathname, error: error.message });
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
    this.log.warn("datasources authority rejected", { context, status: response.status });
    throw new HttpError(502, UNAVAILABLE);
  }

  async create(name, csvText, provenanceClaim, owner) {
    const identity = identityFor(owner);
    const response = await this._call(identity, "POST", "/api/v1/datasources", {
      name,
      csv: csvText,
      provenance: provenanceClaim,
    });
    const parsed = response.status === 201 ? response.json() : null;
    if (!parsed || typeof parsed.datasourceId !== "string") this._reject(response, "create");
    return {
      id: parsed.datasourceId,
      name: parsed.name,
      // 路由只读 rows.length；行数据留在 C# 侧，不再回传 4 MiB 的行数组。
      rows: { length: Number(parsed.rows) || 0 },
      contentSha256: parsed.sha256,
      deduplicated: !!parsed.deduplicated,
      provenance: parsed.provenance,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      owner: identity.tenantId,
    };
  }

  async get(id, owner) {
    const key = String(id || "");
    if (!SAFE_ID.test(key)) return null;
    const identity = identityFor(owner);
    const response = await this._call(identity, "GET", "/api/v1/datasources/" + encodeURIComponent(key), null);
    if (response.status === 404) return null;
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || typeof parsed.datasourceId !== "string") this._reject(response, "get");
    return {
      id: parsed.datasourceId,
      name: parsed.name,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      contentSha256: parsed.contentSha256,
      cacheKey: parsed.cacheKey,
      // requireOwner 比对的是 owner === identity.tenantId 或 ownerId === storageId(...)；
      // C# 已按租户/所有者隔离（他人数据源即 404），这里回填调用方自己的身份即可。
      owner: identity.tenantId,
      ownerId: storageId(identity.tenantId, "ow_"),
      tenantId: storageId(identity.tenantId, "tn_"),
      builtin: !!parsed.builtin,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      provenance: parsed.provenance,
    };
  }

  /** 清扫与容量由 C# ResourceSweeper 负责；本进程无状态。 */
  sweep() {}

  /** Node 自身不再存数据源；权威 gauge 在 C# /metrics 的 forgex_datasources。 */
  get size() {
    return 0;
  }
}

module.exports = { CsharpDatasourceStore };
