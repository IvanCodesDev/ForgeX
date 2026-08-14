"use strict";

const { createPool, withTransaction, closePool } = require("../lib/postgres");
const { storageId } = require("../lib/identity");

function mapRecord(row) {
  const events = Array.isArray(row.events_json) ? row.events_json : [];
  const report = row.report_json || null;
  return {
    id: row.id,
    question: row.question,
    datasourceId: row.datasource_id,
    engine: row.engine,
    provider: row.provider,
    providerImpl: null,
    credentialScope: row.credential_scope,
    status: row.status,
    events,
    evSeq: events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0),
    report,
    error: row.error_message || null,
    upstreamTaskId: row.upstream_task_id || null,
    cached: !!(report && report.cached),
    shared: false,
    caller: row.tenant_id,
    tenantId: row.tenant_id,
    ownerId: row.owner_id,
    degraded: false,
    subscribers: new Set(),
    createdAt: new Date(row.created_at_utc).getTime(),
    finishedAt: row.finished_at_utc ? new Date(row.finished_at_utc).getTime() : 0,
  };
}

class PostgresAnalysisStore {
  constructor(cfg, log, pool) {
    this.cfg = cfg;
    this.ttlMs = Math.max(1, Number(cfg.taskTtlMs) || 60 * 60 * 1000);
    this.log = log || { info() {}, warn() {}, error() {} };
    this.pool = pool || cfg.postgresPool || createPool(cfg);
    this.ownsPool = !pool && !cfg.postgresPool;
    this.probePromise = null;
    this.readyPromises = new Map();
    this.seenTenants = new Map();
    this.saveQueues = new Map();
    this.pendingSaves = new Set();
  }

  context(owner) {
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

  async _probe() {
    if (!this.probePromise) {
      this.probePromise = withTransaction(this.pool, "tn_local", "ow_local", async (client) => {
        await client.query("SELECT 1 FROM forgex.node_analysis_tasks LIMIT 0");
      }).catch((error) => {
        this.probePromise = null;
        throw error;
      });
    }
    return this.probePromise;
  }

  async ready(owner) {
    await this._probe();
    if (owner == null) return [];
    const context = this.context(owner);
    const key = `${context.tenantId}\0${context.ownerId}`;
    if (!this.readyPromises.has(key)) {
      const pending = withTransaction(this.pool, context.tenantId, context.ownerId, async (client) => {
        await client.query(
          "DELETE FROM forgex.node_analysis_tasks WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc <= $3",
          [context.tenantId, context.ownerId, new Date()]
        );
        // A Node process cannot safely resume an in-flight provider call after restart.
        await client.query(
          "UPDATE forgex.node_analysis_tasks SET status='failed', error_message=$3, finished_at_utc=$4, progress=1, phase='recovered', updated_at_utc=$4 WHERE tenant_id=$1 AND owner_id=$2 AND status='running'",
          [context.tenantId, context.ownerId, "服务重启时任务中断", new Date()]
        );
        const result = await client.query(
          "SELECT * FROM forgex.node_analysis_tasks WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at_utc ASC, id ASC",
          [context.tenantId, context.ownerId]
        );
        return result.rows.map(mapRecord);
      }).catch((error) => {
        this.readyPromises.delete(key);
        throw error;
      });
      this.readyPromises.set(key, pending);
    }
    return this.readyPromises.get(key);
  }

  _snapshot(task) {
    const events = Array.isArray(task.events) ? task.events : [];
    const last = events[events.length - 1] || {};
    const context = task.tenantId && task.ownerId
      ? this.context({ tenantId: task.tenantId, ownerId: task.ownerId })
      : this.context(task.caller);
    return {
      context,
      id: String(task.id),
      question: String(task.question || ""),
      datasourceId: String(task.datasourceId || ""),
      engine: String(task.engine || "local"),
      provider: String(task.provider || task.engine || "local"),
      credentialScope: String(task.credentialScope || "global"),
      status: task.status === "done" || task.status === "failed" ? task.status : "running",
      progress: Math.max(0, Math.min(1, Number(last.progress) || (task.status === "done" ? 1 : 0))),
      phase: String(last.stage || last.phase || (task.status === "done" ? "done" : "running")).slice(0, 64),
      message: String(last.message || ""),
      report: task.report || null,
      error: task.error || null,
      upstreamTaskId: task.upstreamTaskId || null,
      events,
      createdAt: Number(task.createdAt) || Date.now(),
      finishedAt: Number(task.finishedAt) || null,
      expiresAt: (Number(task.createdAt) || Date.now()) + this.ttlMs,
      updatedAt: Date.now(),
    };
  }

  async _save(task) {
    const snapshot = this._snapshot(task);
    const { context } = snapshot;
    await withTransaction(this.pool, context.tenantId, context.ownerId, (client) => client.query(
      `INSERT INTO forgex.node_analysis_tasks
        (id, tenant_id, owner_id, question, datasource_id, engine, provider, credential_scope,
         status, progress, phase, message, report_json, error_message, upstream_task_id,
         events_json, created_at_utc, finished_at_utc, expires_at_utc, updated_at_utc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17,$18,$19,$20)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, progress=EXCLUDED.progress, phase=EXCLUDED.phase,
         message=EXCLUDED.message, report_json=EXCLUDED.report_json,
         error_message=EXCLUDED.error_message, upstream_task_id=EXCLUDED.upstream_task_id,
         events_json=EXCLUDED.events_json, finished_at_utc=EXCLUDED.finished_at_utc,
         expires_at_utc=EXCLUDED.expires_at_utc, updated_at_utc=EXCLUDED.updated_at_utc`,
      [snapshot.id, context.tenantId, context.ownerId, snapshot.question, snapshot.datasourceId,
        snapshot.engine, snapshot.provider, snapshot.credentialScope, snapshot.status, snapshot.progress,
        snapshot.phase, snapshot.message, JSON.stringify(snapshot.report), snapshot.error,
        snapshot.upstreamTaskId, JSON.stringify(snapshot.events), new Date(snapshot.createdAt),
        snapshot.finishedAt ? new Date(snapshot.finishedAt) : null, new Date(snapshot.expiresAt),
        new Date(snapshot.updatedAt)]
    ));
  }

  save(task) {
    const id = String(task.id);
    const previous = this.saveQueues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this._save(task));
    this.saveQueues.set(id, next);
    this.pendingSaves.add(next);
    const cleanup = () => {
      this.pendingSaves.delete(next);
      if (this.saveQueues.get(id) === next) this.saveQueues.delete(id);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async sweep(now) {
    const at = new Date(now || Date.now());
    await Promise.all([...this.seenTenants.values()].map(({ tenantId, ownerId }) =>
      withTransaction(this.pool, tenantId, ownerId, (client) => client.query(
        "DELETE FROM forgex.node_analysis_tasks WHERE tenant_id=$1 AND owner_id=$2 AND expires_at_utc < $3",
        [tenantId, ownerId, at]
      )).catch((error) => this.log.warn("analysis task sweep failed", { error: error.message }))
    ));
  }

  async close() {
    await Promise.all([...this.pendingSaves]);
    await closePool(this.pool, this.ownsPool);
  }
}

module.exports = { PostgresAnalysisStore };
