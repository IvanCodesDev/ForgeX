"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { PostgresShareStore } = require("../server/services/postgres-share");

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
    if (/set_config\('app\.(tenant_id|owner_id|share_public)'/i.test(text)) {
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 1 FROM forgex\.shares LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^INSERT INTO forgex\.shares/i.test(text)) {
      const [token, tenantId, ownerId, revokeHash, reportJson, question, engine,
        upstreamTaskId, createdAt, expiresAt] = params;
      const row = {
        token, tenant_id: tenantId, owner_id: ownerId, revoke_hash: revokeHash,
        report_json: JSON.parse(reportJson), question, engine,
        upstream_task_id: upstreamTaskId, created_at_utc: createdAt,
        expires_at_utc: expiresAt, access_count: 0, last_accessed_at_utc: null,
      };
      this.pool.rows.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT \* FROM forgex\.shares WHERE token=\$1/i.test(text)) {
      const row = this.pool.rows.find((item) => item.token === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^UPDATE forgex\.shares/i.test(text)) {
      const row = this.pool.rows.find((item) => item.token === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.access_count += 1;
      row.last_accessed_at_utc = params[1];
      return { rows: [{ access_count: row.access_count, last_accessed_at_utc: row.last_accessed_at_utc }], rowCount: 1 };
    }
    if (/^SELECT revoke_hash FROM forgex\.shares/i.test(text)) {
      const row = this.pool.rows.find((item) => item.token === params[0]
        && item.tenant_id === params[1] && item.owner_id === params[2]);
      return { rows: row ? [{ revoke_hash: row.revoke_hash }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^DELETE FROM forgex\.shares/i.test(text)) {
      if (/token IN/i.test(text)) return { rows: [], rowCount: 0 };
      const before = this.pool.rows.length;
      if (params.length >= 3) {
        this.pool.rows = this.pool.rows.filter((item) => !(item.token === params[0]
          && item.tenant_id === params[1] && item.owner_id === params[2]));
      } else {
        this.pool.rows = this.pool.rows.filter((item) => !(item.tenant_id === params[0]
          && item.owner_id === params[1]));
      }
      return { rows: [], rowCount: before - this.pool.rows.length };
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
    shareTtlMs: 60_000,
    forceMock: true,
    probeProvider: false,
  });
  const store = new PostgresShareStore(cfg, { warn() {} }, pool);
  await store.ready();

  const task = {
    caller: "tenant-alpha",
    report: { summary: "ok", score: 0.92 },
    question: "分享测试",
    engine: "server-rules",
    upstreamTaskId: "task-1",
  };
  const created = await store.create(task);
  assert.strictEqual(created.token.length, 18);
  assert.strictEqual(created.revokeKey.length, 18);
  assert.strictEqual(store.size, 1);

  const first = await store.get(created.token);
  assert.deepStrictEqual(first.report, task.report);
  assert.strictEqual(first.accessCount, 1);
  assert.ok(first.lastAccessedAt);
  assert.strictEqual((await store.revoke(created.token, "wrong", "tenant-alpha")).reason, "bad_key");
  assert.strictEqual((await store.revoke(created.token, created.revokeKey, "tenant-beta")).reason, "not_found");
  assert.deepStrictEqual(await store.revoke(created.token, created.revokeKey, "tenant-alpha"), { ok: true });
  assert.strictEqual(await store.get(created.token), null);
  await store.close();
  console.log("PostgreSQL share boundary PASS: 8/8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
