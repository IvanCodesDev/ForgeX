"use strict";

const crypto = require("crypto");
const { HttpError } = require("../lib/http");
const { createPool, withTransaction, closePool } = require("../lib/postgres");
const { storageId } = require("../lib/identity");
const { DatasourceStore } = require("./datasource");
const { createRulesEngine } = require("./rules-engine");

const MAX_SETS = 200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mapRecord(row, uploadProvenance) {
  return {
    id: row.id,
    name: row.name,
    rows: row.rows_json || [],
    csv: row.csv,
    contentSha256: row.content_sha256,
    cacheKey: row.cache_key,
    owner: row.owner_id,
    ownerId: row.owner_id,
    tenantId: row.tenant_id,
    builtin: false,
    createdAt: new Date(row.created_at_utc).getTime(),
    expiresAt: row.expires_at_utc ? new Date(row.expires_at_utc).getTime() : undefined,
    warnings: row.warnings_json || [],
    provenance: row.provenance_json || uploadProvenance,
  };
}

class PostgresDatasourceStore {
  constructor(cfg, log, pool, rulesEngine) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.pool = pool || cfg.postgresPool || createPool(cfg);
    this.ownsPool = !pool && !cfg.postgresPool;
    this.engine = rulesEngine || createRulesEngine({ config: cfg });
    this.map = new Map();
    this.seenTenants = new Map();
    this._primed = null;
    this._catalog = null;
    this._ready = null;
    this._size = 0;
  }

  /** farm 种子与 provenance 目录只取一次；独立于 DB 探活——数据库不可用时内置 sample 依旧可用。 */
  _prime() {
    if (!this._primed) {
      this._primed = (async () => {
        const [farm, meta] = await Promise.all([this.engine.farm(), this.engine.meta()]);
        this._catalog = meta.provenance;
        const digest = crypto.createHash("sha256").update(farm.csv).digest("hex");
        this.map.set("sample", {
          id: "sample",
          name: "内置机群仿真数据",
          rows: farm.rows,
          csv: farm.csv,
          builtin: true,
          owner: "system:public",
          createdAt: Date.now(),
          contentSha256: digest,
          cacheKey: digest,
          provenance: farm.provenance,
        });
      })().catch((error) => {
        this._primed = null;
        throw error;
      });
    }
    return this._primed;
  }

  _context(owner) {
    const tenantId = storageId(owner, "tn_");
    const ownerId = storageId(owner, "ow_");
    this.seenTenants.set(`${tenantId}\0${ownerId}`, { tenantId, ownerId });
    return { tenantId, ownerId };
  }

  async ready() {
    await this._prime();
    if (!this._ready) {
      this._ready = withTransaction(this.pool, "tn_local", "ow_local", async (client) => {
        await client.query("SELECT 1 FROM forgex.datasources LIMIT 0");
      }).catch((error) => {
        this._ready = null;
        throw error;
      });
    }
    return this._ready;
  }

  async _parse(name, csvText, provenanceClaim, owner) {
    const out = await this.engine.normalizeCsv(csvText);
    if (!out.rows.length) {
      throw new HttpError(400, "CSV 解析失败：" + (out.errors[0] || "无有效数据"));
    }
    const csv = out.csv;
    const contentSha256 = crypto.createHash("sha256").update(csv).digest("hex");
    const provenance = DatasourceStore.sanitizeProvenance(provenanceClaim, this._catalog);
    const context = this._context(owner);
    const cacheKey = crypto.createHash("sha256")
      .update(contentSha256).update("\0").update(JSON.stringify(provenance)).digest("hex");
    const id = "ds_" + crypto.createHash("sha256")
      .update(context.tenantId).update("\0").update(cacheKey).digest("hex").slice(0, 24);
    const now = Date.now();
    return {
      id,
      name: String(name || "print_jobs.csv").slice(0, 80),
      rows: out.rows,
      csv,
      contentSha256,
      cacheKey,
      owner: context.ownerId,
      ownerId: context.ownerId,
      tenantId: context.tenantId,
      builtin: false,
      createdAt: now,
      expiresAt: this.cfg.taskTtlMs ? now + this.cfg.taskTtlMs : undefined,
      warnings: out.errors,
      provenance,
    };
  }

  async create(name, csvText, provenanceClaim, owner) {
    await this.ready();
    const record = await this._parse(name, csvText, provenanceClaim, owner);
    const { tenantId, ownerId } = record;
    return withTransaction(this.pool, tenantId, ownerId, async (client) => {
      const existing = await client.query(
        "SELECT * FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND cache_key=$3",
        [tenantId, ownerId, record.cacheKey]
      );
      if (existing.rowCount) {
        const found = mapRecord(existing.rows[0], this._catalog.upload);
        if (!found.expiresAt || Date.now() <= found.expiresAt) {
          this.map.set(found.id, found);
          return Object.assign({}, found, { deduplicated: true });
        }
        await client.query(
          "DELETE FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",
          [tenantId, ownerId, found.id]
        );
        this.map.delete(found.id);
        this._size = Math.max(0, this._size - 1);
      }
      await client.query(
        `INSERT INTO forgex.datasources
          (id, tenant_id, owner_id, name, csv, rows_json, content_sha256, cache_key,
           warnings_json, provenance_json, created_at_utc, expires_at_utc)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
        [record.id, tenantId, ownerId, record.name, record.csv, JSON.stringify(record.rows),
          record.contentSha256, record.cacheKey, JSON.stringify(record.warnings),
          JSON.stringify(record.provenance), new Date(record.createdAt),
          record.expiresAt ? new Date(record.expiresAt) : null]
      );
      await this._evict(client, tenantId, ownerId);
      this.map.set(record.id, record);
      this._size++;
      return clone(record);
    });
  }

  async get(id, owner) {
    const key = String(id || "");
    if (key === "sample") {
      await this._prime();
      return this.map.get("sample");
    }
    await this.ready();
    const cached = this.map.get(key);
    const context = this._context(owner);
    if (cached && cached.tenantId === context.tenantId && cached.ownerId === context.ownerId) {
      if (cached.expiresAt && Date.now() > cached.expiresAt) {
        this.map.delete(key);
        return null;
      }
      return cached;
    }
    const result = await withTransaction(this.pool, context.tenantId, context.ownerId, (client) => client.query(
      "SELECT * FROM forgex.datasources WHERE id=$1 AND tenant_id=$2 AND owner_id=$3",
      [key, context.tenantId, context.ownerId]
    ));
    if (!result.rowCount) return null;
    const record = mapRecord(result.rows[0], this._catalog.upload);
    if (record.expiresAt && Date.now() > record.expiresAt) return null;
    this.map.set(record.id, record);
    this._size = Math.max(this._size, this.map.size - 1);
    return record;
  }

  async _evict(client, tenantId, ownerId) {
    const deleted = await client.query(
      `DELETE FROM forgex.datasources
       WHERE tenant_id=$1 AND owner_id=$2 AND id IN (
         SELECT id FROM forgex.datasources
         WHERE tenant_id=$1 AND owner_id=$2
         ORDER BY created_at_utc ASC
         OFFSET $3
       )
       RETURNING id`,
      [tenantId, ownerId, MAX_SETS]
    );
    for (const row of deleted.rows || []) {
      this.map.delete(row.id);
      this._size = Math.max(0, this._size - 1);
    }
  }

  async sweep(now) {
    const at = new Date(now || Date.now());
    await Promise.all([...this.seenTenants.values()].map(({ tenantId, ownerId }) =>
      withTransaction(this.pool, tenantId, ownerId, async (client) => {
        await client.query(
          "DELETE FROM forgex.datasources WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc < $3",
          [tenantId, ownerId, at]
        );
      }).catch((error) => this.log.warn("datasource sweep failed", { error: error.message }))
    ));
    for (const [id, record] of this.map) {
      if (!record.builtin && record.expiresAt && (now || Date.now()) > record.expiresAt) this.map.delete(id);
    }
  }

  get size() {
    return this._size + 1;
  }

  async close() {
    await closePool(this.pool, this.ownsPool);
  }
}

module.exports = { PostgresDatasourceStore, storageId };
