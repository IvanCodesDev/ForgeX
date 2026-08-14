"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { PostgresKnowledgeStore } = require("../server/services/postgres-knowledge");

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
    if (/set_config\('app\.tenant_id'/i.test(text)) return { rows: [], rowCount: 1 };
    if (/SELECT 1 FROM forgex\.knowledge_docs LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^DELETE FROM forgex\.knowledge_docs/i.test(text)) {
      if (/id IN/i.test(text)) return { rows: [], rowCount: 0 };
      this.pool.rows = this.pool.rows.filter((item) => !(item.tenant_id === params[0] && item.owner_id === params[1]));
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT \* FROM forgex\.knowledge_docs/i.test(text)) {
      const rows = this.pool.rows
        .filter((item) => item.tenant_id === params[0] && item.owner_id === params[1])
        .sort((a, b) => new Date(a.created_at_utc) - new Date(b.created_at_utc));
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO forgex\.knowledge_docs/i.test(text)) {
      const [id, tenantId, ownerId, name, body, createdAt, expiresAt] = params;
      this.pool.rows.push({
        id, tenant_id: tenantId, owner_id: ownerId, name, text: body,
        created_at_utc: createdAt, expires_at_utc: expiresAt,
      });
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
  const store = new PostgresKnowledgeStore(cfg, { warn() {} }, pool);
  await store.ready();
  const created = await store.create("process.md", "翘边：首层附着失效。", "tenant-alpha");
  assert.ok(created.id.startsWith("kb_"));
  assert.strictEqual(created.owner, created.ownerId);
  assert.strictEqual(store.all("tenant-alpha").length, 1);
  assert.strictEqual(store.all("tenant-beta").length, 0);
  await store.ready("tenant-alpha");
  assert.strictEqual(store.all("tenant-alpha")[0].text, "翘边：首层附着失效。");
  assert.strictEqual(store.size, 1);
  await store.close();
  console.log("PostgreSQL knowledge boundary PASS: 7/7");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
