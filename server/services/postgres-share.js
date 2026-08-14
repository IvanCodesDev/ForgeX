"use strict";

const crypto = require("crypto");
const { createPool, withTransaction, withPublicTransaction, closePool } = require("../lib/postgres");
const { storageId } = require("../lib/identity");
const { DEFAULT_TTL_MS, MAX_SHARES } = require("./share");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mapRecord(row) {
  return {
    id: row.token,
    token: row.token,
    revokeHash: row.revoke_hash,
    report: row.report_json,
    question: row.question,
    engine: row.engine,
    owner: row.owner_id,
    ownerId: row.owner_id,
    tenantId: row.tenant_id,
    upstreamTaskId: row.upstream_task_id || undefined,
    createdAt: new Date(row.created_at_utc).getTime(),
    expiresAt: new Date(row.expires_at_utc).getTime(),
    accessCount: Number(row.access_count || 0),
    lastAccessedAt: row.last_accessed_at_utc ? new Date(row.last_accessed_at_utc).getTime() : undefined,
  };
}

class PostgresShareStore {
  constructor(cfg, log, pool) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.pool = pool || cfg.postgresPool || createPool(cfg);
    this.ownsPool = !pool && !cfg.postgresPool;
    this.ttlMs = (cfg && cfg.shareTtlMs) || DEFAULT_TTL_MS;
    this.map = new Map();
    this.seenTenants = new Map();
    this.probePromise = null;
    this._size = 0;
  }

  _context(owner) {
    if (owner && owner.tenantId && owner.ownerId) {
      const context = { tenantId: owner.tenantId, ownerId: owner.ownerId };
      this.seenTenants.set(`${context.tenantId}\0${context.ownerId}`, context);
      return context;
    }
    const tenantId = storageId(owner, "tn_");
    const ownerId = storageId(owner, "ow_");
    this.seenTenants.set(`${tenantId}\0${ownerId}`, { tenantId, ownerId });
    return { tenantId, ownerId };
  }

  async ready() {
    if (!this.probePromise) {
      this.probePromise = withTransaction(this.pool, "tn_local", "ow_local", async (client) => {
        await client.query("SELECT 1 FROM forgex.shares LIMIT 0");
      }).catch((error) => {
        this.probePromise = null;
        throw error;
      });
    }
    return this.probePromise;
  }

  async create(task, opt) {
    await this.ready();
    opt = opt || {};
    const token = crypto.randomBytes(9).toString("hex");
    const revokeKey = crypto.randomBytes(9).toString("hex");
    const ttl = opt.ttlMs && opt.ttlMs > 0 ? Math.min(opt.ttlMs, this.ttlMs) : this.ttlMs;
    const context = task.tenantId && task.ownerId
      ? this._context(task)
      : this._context(task.caller);
    const createdAt = Date.now();
    const record = {
      id: token,
      token,
      revokeHash: crypto.createHash("sha256").update(revokeKey).digest("hex"),
      report: task.report,
      question: task.question,
      engine: task.engine,
      owner: context.ownerId,
      ownerId: context.ownerId,
      tenantId: context.tenantId,
      upstreamTaskId: task.upstreamTaskId,
      createdAt,
      expiresAt: createdAt + ttl,
      accessCount: 0,
    };
    await withTransaction(this.pool, context.tenantId, context.ownerId, async (client) => {
      await client.query(
        `INSERT INTO forgex.shares
          (token, tenant_id, owner_id, revoke_hash, report_json, question, engine,
           upstream_task_id, created_at_utc, expires_at_utc, access_count)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,0)`,
        [record.token, record.tenantId, record.ownerId, record.revokeHash, JSON.stringify(record.report),
          record.question, record.engine, record.upstreamTaskId || null,
          new Date(record.createdAt), new Date(record.expiresAt)]
      );
      await this._evict(client, context.tenantId, context.ownerId);
    });
    this.map.set(token, record);
    this._size++;
    return { token, revokeKey, expiresAt: record.expiresAt };
  }

  async get(token) {
    await this.ready();
    const key = String(token || "");
    const result = await withPublicTransaction(this.pool, (client) => client.query(
      "SELECT * FROM forgex.shares WHERE token=$1",
      [key]
    ));
    if (!result.rowCount) return null;
    const record = mapRecord(result.rows[0]);
    if (Date.now() > record.expiresAt) {
      await withTransaction(this.pool, record.tenantId, record.ownerId, (client) => client.query(
        "DELETE FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
        [record.token, record.tenantId, record.ownerId]
      ));
      this.map.delete(record.token);
      this._size = Math.max(0, this._size - 1);
      return null;
    }
    const access = await withTransaction(this.pool, record.tenantId, record.ownerId, (client) => client.query(
      `UPDATE forgex.shares
       SET access_count=access_count+1, last_accessed_at_utc=$2
       WHERE token=$1
       RETURNING access_count, last_accessed_at_utc`,
      [record.token, new Date()]
    ));
    if (access.rowCount) {
      record.accessCount = Number(access.rows[0].access_count || 0);
      record.lastAccessedAt = new Date(access.rows[0].last_accessed_at_utc).getTime();
    }
    this.seenTenants.set(`${record.tenantId}\0${record.ownerId}`, {
      tenantId: record.tenantId,
      ownerId: record.ownerId,
    });
    const cached = this.map.get(record.token);
    if (!cached) this._size++;
    this.map.set(record.token, record);
    return clone(record);
  }

  async revoke(token, revokeKey, owner) {
    await this.ready();
    const context = this._context(owner);
    const result = await withTransaction(this.pool, context.tenantId, context.ownerId, (client) => client.query(
      "SELECT revoke_hash FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
      [String(token || ""), context.tenantId, context.ownerId]
    ));
    if (!result.rowCount) return { ok: false, reason: "not_found" };
    const given = crypto.createHash("sha256").update(String(revokeKey || "")).digest();
    const want = Buffer.from(result.rows[0].revoke_hash, "hex");
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return { ok: false, reason: "bad_key" };
    }
    await withTransaction(this.pool, context.tenantId, context.ownerId, (client) => client.query(
      "DELETE FROM forgex.shares WHERE token=$1 AND tenant_id=$2 AND owner_id=$3",
      [String(token || ""), context.tenantId, context.ownerId]
    ));
    this.map.delete(String(token || ""));
    this._size = Math.max(0, this._size - 1);
    return { ok: true };
  }

  async _evict(client, tenantId, ownerId) {
    const deleted = await client.query(
      `DELETE FROM forgex.shares
       WHERE tenant_id=$1 AND owner_id=$2 AND token IN (
         SELECT token FROM forgex.shares
         WHERE tenant_id=$1 AND owner_id=$2
         ORDER BY created_at_utc ASC, token ASC
         OFFSET $3
       )
       RETURNING token`,
      [tenantId, ownerId, MAX_SHARES]
    );
    for (const row of deleted.rows || []) {
      this.map.delete(row.token);
      this._size = Math.max(0, this._size - 1);
    }
  }

  async sweep(now) {
    const at = new Date(now || Date.now());
    await Promise.all([...this.seenTenants.values()].map(({ tenantId, ownerId }) =>
      withTransaction(this.pool, tenantId, ownerId, async (client) => {
        await client.query(
          "DELETE FROM forgex.shares WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc < $3",
          [tenantId, ownerId, at]
        );
      }).catch((error) => this.log.warn("share sweep failed", { error: error.message }))
    ));
    for (const [token, record] of this.map) {
      if (Date.now() > record.expiresAt) {
        this.map.delete(token);
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

module.exports = { PostgresShareStore };
