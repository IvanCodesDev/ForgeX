"use strict";

const crypto = require("crypto");
const { HttpError } = require("../lib/http");
const { createPool, withTransaction, closePool } = require("../lib/postgres");
const { storageId } = require("../lib/identity");
const { MAX_DOCS, MAX_TEXT } = require("./knowledge");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mapRecord(row) {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    owner: row.owner_id,
    ownerId: row.owner_id,
    tenantId: row.tenant_id,
    createdAt: new Date(row.created_at_utc).getTime(),
    expiresAt: row.expires_at_utc ? new Date(row.expires_at_utc).getTime() : undefined,
  };
}

class PostgresKnowledgeStore {
  constructor(cfg, log, pool) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.pool = pool || cfg.postgresPool || createPool(cfg);
    this.ownsPool = !pool && !cfg.postgresPool;
    this.map = new Map();
    this.seenTenants = new Map();
    this.readyPromises = new Map();
    this.probePromise = null;
    this._size = 0;
  }

  _context(owner) {
    const tenantId = storageId(owner, "tn_");
    const ownerId = storageId(owner, "ow_");
    const key = `${tenantId}\0${ownerId}`;
    this.seenTenants.set(key, { tenantId, ownerId });
    return { key, tenantId, ownerId };
  }

  async _probe() {
    if (!this.probePromise) {
      this.probePromise = withTransaction(this.pool, "tn_local", "ow_local", async (client) => {
        await client.query("SELECT 1 FROM forgex.knowledge_docs LIMIT 0");
      }).catch((error) => {
        this.probePromise = null;
        throw error;
      });
    }
    return this.probePromise;
  }

  async ready(owner) {
    await this._probe();
    if (owner == null) return;
    const context = this._context(owner);
    if (!this.readyPromises.has(context.key)) {
      const pending = withTransaction(this.pool, context.tenantId, context.ownerId, async (client) => {
        await client.query(
          "DELETE FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc <= $3",
          [context.tenantId, context.ownerId, new Date()]
        );
        const result = await client.query(
          "SELECT * FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at_utc ASC, id ASC",
          [context.tenantId, context.ownerId]
        );
        for (const row of result.rows) {
          const record = mapRecord(row);
          this.map.set(record.id, record);
        }
        this._size = [...this.map.values()].length;
      }).catch((error) => {
        this.readyPromises.delete(context.key);
        throw error;
      });
      this.readyPromises.set(context.key, pending);
    }
    return this.readyPromises.get(context.key);
  }

  _parse(name, text, owner) {
    const body = String(text || "");
    if (!body.trim()) throw new HttpError(400, "知识文档内容为空");
    if (body.length > MAX_TEXT) throw new HttpError(413, "知识文档超过 512KB");
    const context = this._context(owner);
    const now = Date.now();
    return {
      id: "kb_" + crypto.randomBytes(8).toString("hex"),
      name: String(name || "knowledge.md").slice(0, 80),
      text: body,
      owner: context.ownerId,
      ownerId: context.ownerId,
      tenantId: context.tenantId,
      createdAt: now,
      expiresAt: this.cfg.taskTtlMs ? now + this.cfg.taskTtlMs : undefined,
    };
  }

  async create(name, text, owner) {
    const record = this._parse(name, text, owner);
    await this.ready(owner);
    return withTransaction(this.pool, record.tenantId, record.ownerId, async (client) => {
      await client.query(
        `INSERT INTO forgex.knowledge_docs
          (id, tenant_id, owner_id, name, text, created_at_utc, expires_at_utc)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [record.id, record.tenantId, record.ownerId, record.name, record.text,
          new Date(record.createdAt), record.expiresAt ? new Date(record.expiresAt) : null]
      );
      await this._evict(client, record.tenantId, record.ownerId);
      this.map.set(record.id, record);
      this._size++;
      return clone(record);
    });
  }

  all(owner) {
    const docs = [...this.map.values()].filter((doc) => {
      if (doc.expiresAt && Date.now() > doc.expiresAt) return false;
      if (owner == null) return true;
      const context = this._context(owner);
      return doc.tenantId === context.tenantId && doc.ownerId === context.ownerId;
    });
    return docs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async _evict(client, tenantId, ownerId) {
    const deleted = await client.query(
      `DELETE FROM forgex.knowledge_docs
       WHERE tenant_id=$1 AND owner_id=$2 AND id IN (
         SELECT id FROM forgex.knowledge_docs
         WHERE tenant_id=$1 AND owner_id=$2
         ORDER BY created_at_utc ASC, id ASC
         OFFSET $3
       )
       RETURNING id`,
      [tenantId, ownerId, MAX_DOCS]
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
          "DELETE FROM forgex.knowledge_docs WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc IS NOT NULL AND expires_at_utc < $3",
          [tenantId, ownerId, at]
        );
      }).catch((error) => this.log.warn("knowledge sweep failed", { error: error.message }))
    ));
    for (const [id, record] of this.map) {
      if (record.expiresAt && (now || Date.now()) > record.expiresAt) {
        this.map.delete(id);
        this._size = Math.max(0, this._size - 1);
      }
    }
  }

  get size() {
    return this._size;
  }

  async close() {
    await closePool(this.pool, this.ownsPool);
  }
}

module.exports = { PostgresKnowledgeStore };
