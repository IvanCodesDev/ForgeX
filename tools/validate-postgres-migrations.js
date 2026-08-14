"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const databaseRoot = path.join(root, "backend", "database", "postgresql");
const manifestPath = path.join(databaseRoot, "manifest.json");

function fail(message) {
  throw new Error(`PostgreSQL migration gate: ${message}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.engine !== "postgresql") {
  fail("unsupported manifest schema or engine");
}
if (!Number.isInteger(manifest.minimumMajorVersion) || manifest.minimumMajorVersion < 15) {
  fail("minimumMajorVersion must be PostgreSQL 15 or newer");
}
if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
  fail("at least one migration is required");
}

const requiredV1Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.schema_migrations",
  "CREATE TABLE IF NOT EXISTS forgex.gcode_analysis_jobs",
  "tenant_id varchar(35) NOT NULL",
  "owner_id varchar(35) NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_gcode_jobs_tenant_owner_idempotency",
  "CREATE TABLE IF NOT EXISTS forgex.gcode_job_events",
  "ENABLE ROW LEVEL SECURITY",
  "CREATE POLICY gcode_jobs_tenant_owner_policy",
  "CREATE POLICY gcode_job_events_tenant_owner_policy",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
  "INSERT INTO forgex.schema_migrations",
];
const requiredV2Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.calibration_submissions",
  "CREATE TABLE IF NOT EXISTS forgex.calibration_releases",
  "UNIQUE (tenant_id, owner_id, bundle_id, revision)",
  "calibration_submissions_tenant_owner_policy",
  "calibration_releases_tenant_policy",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
];
const requiredV3Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.datasources",
  "rows_json jsonb NOT NULL",
  "content_sha256 char(64) NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_datasources_tenant_owner_cache",
  "datasources_tenant_owner_policy",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
];
const requiredV4Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.knowledge_docs",
  "text text NOT NULL",
  "CREATE INDEX IF NOT EXISTS ix_knowledge_docs_tenant_owner_created",
  "knowledge_docs_tenant_owner_policy",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
];
const requiredV5Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.shares",
  "access_count bigint NOT NULL",
  "last_accessed_at_utc",
  "CREATE POLICY shares_public_read_policy",
  "CREATE POLICY shares_owner_write_policy",
  "current_setting('app.share_public', true)",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
];
const requiredV6Fragments = [
  "CREATE TABLE IF NOT EXISTS forgex.node_analysis_tasks",
  "events_json jsonb NOT NULL",
  "CREATE INDEX IF NOT EXISTS ix_node_tasks_tenant_owner_created",
  "node_analysis_tasks_tenant_owner_policy",
  "current_setting('app.tenant_id', true)",
  "current_setting('app.owner_id', true)",
];

const checks = [];
for (const [index, migration] of manifest.migrations.entries()) {
  const expectedVersion = index + 1;
  if (migration.version !== expectedVersion) fail(`migration sequence expected ${expectedVersion}`);
  if (!/^[a-z0-9_]{1,64}$/.test(migration.name)) fail(`invalid migration name at version ${expectedVersion}`);
  if (migration.transactional !== true) fail(`migration ${expectedVersion} must be transactional`);
  if (migration.rollbackPolicy !== "retain-schema")
    fail(`migration ${expectedVersion} rollback policy must retain schema`);
  if (!/^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(migration.file))
    fail(`invalid migration path at version ${expectedVersion}`);
  const expectedFile = `migrations/${String(migration.version).padStart(4, "0")}_${migration.name}.sql`;
  if (migration.file !== expectedFile) fail(`migration ${expectedVersion} filename does not match version/name`);

  const migrationPath = path.resolve(databaseRoot, migration.file);
  if (!migrationPath.startsWith(databaseRoot + path.sep)) fail(`migration ${expectedVersion} escapes database root`);
  const bytes = fs.readFileSync(migrationPath);
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== migration.sha256) fail(`migration ${expectedVersion} SHA-256 mismatch`);

  const sql = bytes.toString("utf8");
  if (!/^BEGIN;\s/u.test(sql) || !/\sCOMMIT;\s*$/u.test(sql))
    fail(`migration ${expectedVersion} is not transaction bounded`);
  if (/\b(?:DROP|TRUNCATE)\b/iu.test(sql)) fail(`migration ${expectedVersion} contains destructive DDL`);
  const registration = new RegExp(`VALUES\\s*\\(\\s*${migration.version}\\s*,\\s*'${migration.name}'\\s*\\)`, "iu");
  if (!registration.test(sql)) fail(`migration ${expectedVersion} does not register its manifest identity`);
  if (migration.version === 1) {
    for (const fragment of requiredV1Fragments) {
      if (!sql.includes(fragment)) fail(`migration 1 missing required contract: ${fragment}`);
    }
  }
  if (migration.version === 2) {
    for (const fragment of requiredV2Fragments) {
      if (!sql.includes(fragment)) fail(`migration 2 missing required contract: ${fragment}`);
    }
  }
  if (migration.version === 3) {
    for (const fragment of requiredV3Fragments) {
      if (!sql.includes(fragment)) fail(`migration 3 missing required contract: ${fragment}`);
    }
  }
  if (migration.version === 4) {
    for (const fragment of requiredV4Fragments) {
      if (!sql.includes(fragment)) fail(`migration 4 missing required contract: ${fragment}`);
    }
  }
  if (migration.version === 5) {
    for (const fragment of requiredV5Fragments) {
      if (!sql.includes(fragment)) fail(`migration 5 missing required contract: ${fragment}`);
    }
  }
  if (migration.version === 6) {
    for (const fragment of requiredV6Fragments) {
      if (!sql.includes(fragment)) fail(`migration 6 missing required contract: ${fragment}`);
    }
  }
  checks.push({ version: migration.version, file: migration.file, sha256: actualSha256, bytes: bytes.length });
}

process.stdout.write(`${JSON.stringify({ result: "pass", schemaVersion: manifest.schemaVersion, checks }, null, 2)}\n`);
