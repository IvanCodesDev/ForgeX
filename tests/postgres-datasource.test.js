"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { createApp } = require("../server/index");
const { PostgresDatasourceStore } = require("../server/services/postgres-datasource");

const CSV = [
  "job_id,date,machine_id,model_name,material,layer_height_mm,duration_min,filament_g,cost_fen,status,fail_reason,energy_kwh",
  "J1,2026-08-01,FX-01,bracket,PLA,0.2,30,8,1.2,success,,0.1",
].join("\n");

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
    if (/set_config\('app\.(tenant_id|share_public)'/i.test(text)) return { rows: [], rowCount: 1 };
    if (/FROM forgex\.calibration_releases/i.test(text) && /AS approved/i.test(text)) {
      return { rows: [{ approved: 0, pending: 0 }], rowCount: 1 };
    }
    if (/SELECT 1 FROM forgex\.datasources LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT 1 FROM forgex\.knowledge_docs LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT 1 FROM forgex\.shares LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT 1 FROM forgex\.node_analysis_tasks LIMIT 0/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT \* FROM forgex\.datasources WHERE tenant_id=\$1 AND owner_id=\$2 AND cache_key=\$3/i.test(text)) {
      const row = this.pool.rows.find((item) => item.tenant_id === params[0] && item.owner_id === params[1] && item.cache_key === params[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/SELECT \* FROM forgex\.datasources WHERE id=\$1 AND tenant_id=\$2 AND owner_id=\$3/i.test(text)) {
      const row = this.pool.rows.find((item) => item.id === params[0] && item.tenant_id === params[1] && item.owner_id === params[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT INTO forgex\.datasources/i.test(text)) {
      const [id, tenantId, ownerId, name, csv, rowsJson, contentSha256, cacheKey, warningsJson, provenanceJson, createdAt, expiresAt] = params;
      const row = {
        id, tenant_id: tenantId, owner_id: ownerId, name, csv,
        rows_json: JSON.parse(rowsJson), content_sha256: contentSha256, cache_key: cacheKey,
        warnings_json: JSON.parse(warningsJson), provenance_json: JSON.parse(provenanceJson),
        created_at_utc: createdAt, expires_at_utc: expiresAt,
      };
      this.pool.rows.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/^DELETE FROM forgex\.datasources/i.test(text)) {
      if (/id IN/i.test(text)) return { rows: [], rowCount: 0 };
      if (params.length === 3) {
        this.pool.rows = this.pool.rows.filter((item) => item.id !== params[2]);
        return { rows: [], rowCount: 1 };
      }
      this.pool.rows = this.pool.rows.filter((item) => !(item.tenant_id === params[0] && item.owner_id === params[1]));
      return { rows: [], rowCount: 0 };
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
    dataDir: "",
    taskTtlMs: 60_000,
    forceMock: true,
    probeProvider: false,
  });
  const store = new PostgresDatasourceStore(cfg, { warn() {} }, pool);
  await store.ready();

  const first = await store.create("jobs.csv", CSV, null, "tenant-alpha");
  assert.ok(first.id.startsWith("ds_"));
  assert.strictEqual(first.rows.length, 1);
  assert.strictEqual(first.owner, first.ownerId);

  const duplicate = await store.create("renamed.csv", CSV, null, "tenant-alpha");
  assert.strictEqual(duplicate.id, first.id);
  assert.strictEqual(duplicate.deduplicated, true);

  const sameTenant = await store.get(first.id, "tenant-alpha");
  assert.strictEqual(sameTenant.id, first.id);
  assert.strictEqual(await store.get(first.id, "tenant-beta"), null);
  assert.strictEqual(store.size, 2, "sample plus one persisted datasource");

  await store.close();

  const app = createApp({
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: pool,
    dataDir: "",
    forceMock: true,
    probeProvider: false,
    rateLimitMs: 0,
    logLevel: "error",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/datasource`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "route.csv", csv: CSV }),
  });
  assert.strictEqual(response.status, 201);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.strictEqual(health.status, 200);
  assert.strictEqual((await health.json()).persistence, "postgres");
  await app.close();
  console.log("PostgreSQL datasource boundary PASS: 10/10");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
