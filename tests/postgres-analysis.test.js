"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { PostgresAnalysisStore } = require("../server/services/postgres-analysis");

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
    if (/set_config\('app\.tenant_id'/i.test(text)) return { rows: [], rowCount: 1 };
    if (/SELECT 1 FROM forgex\.node_analysis_tasks LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^DELETE FROM forgex\.node_analysis_tasks/i.test(text)) {
      const cutoff = new Date(params[2]);
      this.pool.rows = this.pool.rows.filter((row) => !(row.tenant_id === params[0]
        && row.owner_id === params[1] && new Date(row.expires_at_utc) <= cutoff));
      return { rows: [], rowCount: 0 };
    }
    if (/^UPDATE forgex\.node_analysis_tasks/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^SELECT \* FROM forgex\.node_analysis_tasks/i.test(text)) {
      const rows = this.pool.rows
        .filter((row) => row.tenant_id === params[0] && row.owner_id === params[1])
        .sort((a, b) => new Date(a.created_at_utc) - new Date(b.created_at_utc));
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO forgex\.node_analysis_tasks/i.test(text)) {
      const [id, tenantId, ownerId, question, datasourceId, engine, provider, credentialScope,
        status, progress, phase, message, reportJson, errorMessage, upstreamTaskId, eventsJson,
        createdAt, finishedAt, expiresAt, updatedAt] = params;
      const row = {
        id, tenant_id: tenantId, owner_id: ownerId, question, datasource_id: datasourceId,
        engine, provider, credential_scope: credentialScope, status, progress, phase, message,
        report_json: JSON.parse(reportJson), error_message: errorMessage,
        upstream_task_id: upstreamTaskId, events_json: JSON.parse(eventsJson),
        created_at_utc: createdAt, finished_at_utc: finishedAt,
        expires_at_utc: expiresAt, updated_at_utc: updatedAt,
      };
      const existing = this.pool.rows.findIndex((item) => item.id === id);
      if (existing >= 0) this.pool.rows[existing] = Object.assign({}, this.pool.rows[existing], row);
      else this.pool.rows.push(row);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  release() {}
}

class FakePool {
  constructor() {
    this.rows = [];
  }

  async connect() {
    return new FakeClient(this);
  }
}

async function main() {
  const pool = new FakePool();
  const cfg = getConfig({
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: pool,
    taskTtlMs: 60_000,
    forceMock: true,
    probeProvider: false,
  });
  const store = new PostgresAnalysisStore(cfg, { warn() {} }, pool);
  const context = store.context("tenant-alpha");
  const task = {
    id: "t_analysis_001",
    caller: "tenant-alpha",
    tenantId: context.tenantId,
    ownerId: context.ownerId,
    question: "任务历史",
    datasourceId: "ds_1",
    engine: "server-rules",
    provider: "server-rules",
    credentialScope: context.tenantId,
    status: "done",
    report: { summary: "ok" },
    error: null,
    upstreamTaskId: null,
    events: [{ seq: 1, stage: "done", progress: 1, message: "完成" }],
    createdAt: Date.now() - 100,
    finishedAt: Date.now(),
  };
  await store.ready("tenant-alpha");
  await store.save(task);

  const restoredStore = new PostgresAnalysisStore(cfg, { warn() {} }, pool);
  const restored = await restoredStore.ready("tenant-alpha");
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].id, task.id);
  assert.strictEqual(restored[0].status, "done");
  assert.deepStrictEqual(restored[0].report, task.report);
  assert.strictEqual(restored[0].events[0].progress, 1);
  assert.deepStrictEqual(await restoredStore.ready("tenant-beta"), []);
  await store.close();
  await restoredStore.close();
  console.log("PostgreSQL analysis task boundary PASS: 8/8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
