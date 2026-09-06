/* PostgreSQL 校准治理存储的边界测试（假 pool）。
 *
 * 真正的 SQL 行为由 CI 的 PostgreSQL service（Stage 8.6a 双跑门禁）覆盖；这里只锁定
 * 与 file 态 CalibrationStore 的**文案与校验顺序一致性**（Stage 8.6a A6）：
 *   - 校验错误用「；」拼接、「审批队列」措辞、「提交者不能审批自己提交的校准包」；
 *   - review 先判 404 / 已审 409，再校验 decision 与 reason；
 *   - 容量淘汰 SQL 保持「最早完成审核者先淘汰」。 */
"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { PostgresCalibrationStore } = require("../server/services/postgres-calibration");

function candidate(id, revision) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id,
    revision,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized production pairs submitted for independent calibration review.",
    },
    models: [
      {
        id: id + "-pla",
        status: "candidate",
        scope: { machineId: "FX-P8-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.18, fixedOverheadSec: 80, sampleCount: 12 },
        validation: { holdoutSamples: 6, mape: 0.08, maxApe: 0.16, medianBias: 0.02, evaluatedAt: "2026-07-28T00:00:00Z" },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "c".repeat(64),
      },
    ],
  };
}

class FakeClient {
  constructor(pool) {
    this.pool = pool;
  }

  async query(sql, params) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    const { submissions, releases } = this.pool;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
    if (/set_config\('app\.tenant_id'/i.test(text)) return { rows: [], rowCount: 1 };
    if (/^SELECT key FROM forgex\.calibration_submissions/i.test(text)) {
      const row = submissions.find((item) => item.key === params[2]);
      return { rows: row ? [{ key: row.key }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^SELECT revision FROM forgex\.calibration_releases/i.test(text)) {
      const row = releases.find((item) => item.bundle_id === params[1]);
      return { rows: row ? [{ revision: row.revision }] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT INTO forgex\.calibration_submissions/i.test(text)) {
      const [tenantId, ownerId, key, bundleId, revision, status, digest, bundleJson, now, submittedBy, note, eventsJson] = params;
      submissions.push({
        tenant_id: tenantId, owner_id: ownerId, key, bundle_id: bundleId, revision, status, digest,
        bundle_json: JSON.parse(bundleJson), created_at_utc: now, updated_at_utc: now,
        submitted_by: submittedBy, note, reviewed_by: null, review_reason: null, events_json: JSON.parse(eventsJson),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^DELETE FROM forgex\.calibration_submissions/i.test(text)) {
      this.pool.evictSql = text;
      return { rows: [], rowCount: 0 };
    }
    if (/^SELECT \* FROM forgex\.calibration_submissions WHERE tenant_id=\$1 AND owner_id=\$2 AND key=\$3 FOR UPDATE/i.test(text)) {
      const row = submissions.find((item) => item.key === params[2]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/^INSERT INTO forgex\.calibration_releases/i.test(text)) {
      const [tenantId, ownerId, bundleId, revision, digest, bundleJson, approvedAt, approvedBy] = params;
      const row = {
        tenant_id: tenantId, owner_id: ownerId, bundle_id: bundleId, revision, digest,
        bundle_json: JSON.parse(bundleJson), approved_at_utc: approvedAt, approved_by: approvedBy,
      };
      const index = releases.findIndex((item) => item.bundle_id === bundleId);
      if (index >= 0) releases[index] = row;
      else releases.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE forgex\.calibration_submissions SET status=\$4/i.test(text)) {
      const row = submissions.find((item) => item.key === params[2]);
      Object.assign(row, {
        status: params[3], updated_at_utc: params[4], reviewed_by: params[5], review_reason: params[6],
        bundle_json: JSON.parse(params[7]), events_json: JSON.parse(params[8]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT \* FROM forgex\.calibration_submissions WHERE tenant_id=\$1 AND owner_id=\$2 ORDER BY created_at_utc DESC/i.test(text)) {
      const rows = submissions.slice().sort((a, b) => b.created_at_utc - a.created_at_utc);
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT bundle_id, revision, digest, bundle_json, approved_at_utc, approved_by FROM forgex\.calibration_releases/i.test(text)) {
      const rows = releases.slice().sort((a, b) => (a.bundle_id < b.bundle_id ? -1 : a.bundle_id > b.bundle_id ? 1 : 0));
      return { rows, rowCount: rows.length };
    }
    if (/AS approved/i.test(text)) {
      return {
        rows: [{ approved: releases.length, pending: submissions.filter((item) => item.status === "pending").length }],
        rowCount: 1,
      };
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }

  release() {}
}

class FakePool {
  constructor() {
    this.submissions = [];
    this.releases = [];
    this.evictSql = "";
  }

  async connect() {
    return new FakeClient(this);
  }
}

async function rejectsWith(fn, status, message) {
  try {
    await fn();
  } catch (error) {
    assert.strictEqual(error.status, status, `expected ${status}, got ${error.status}: ${error.message}`);
    assert.strictEqual(error.message, message);
    return;
  }
  assert.fail(`expected HttpError ${status} ${message}`);
}

async function main() {
  const pool = new FakePool();
  const cfg = getConfig({
    persistenceProvider: "postgres",
    postgresUrl: "postgres://fake/forgex",
    postgresPool: pool,
    dataDir: "",
    forceMock: true,
    probeProvider: false,
  });
  const store = new PostgresCalibrationStore(cfg, { info() {}, warn() {}, error() {} });

  // 校验文案与 file 态一致：多条错误用「；」拼接，措辞为「审批队列」。
  const broken = candidate("pg-bundle", 1);
  broken.version = 2;
  broken.models = [];
  await rejectsWith(() => store.submit(broken, "11111111", ""), 400, "version 必须是 1；models 至少需要一项");
  const notCandidate = candidate("pg-bundle", 1);
  notCandidate.models[0].status = "active";
  await rejectsWith(() => store.submit(notCandidate, "11111111", ""), 400, "提交到审批队列的模型必须全部为 candidate");

  const submitted = await store.submit(candidate("pg-bundle", 1), "11111111", 42);
  assert.strictEqual(submitted.key, "pg-bundle@1");
  assert.strictEqual(submitted.note, "42");
  await rejectsWith(() => store.submit(candidate("pg-bundle", 1), "11111111", ""), 409, "该 bundle revision 已经提交");

  // review 顺序：404 / 已审 409 先于 decision、reason 校验。
  await rejectsWith(() => store.review("pg-bundle", 9, "maybe", "22222222", "short"), 404, "校准包提交不存在");
  await rejectsWith(() => store.review("pg-bundle", 1, "maybe", "22222222", "Reviewed the holdout metrics."), 400, "decision 必须是 approve 或 reject");
  await rejectsWith(() => store.review("pg-bundle", 1, "approve", "22222222", "short"), 400, "审核原因至少需要 10 个字符");
  await rejectsWith(
    () => store.review("pg-bundle", 1, "approve", "11111111", "Reviewed the holdout metrics."),
    409,
    "提交者不能审批自己提交的校准包"
  );
  const approved = await store.review("pg-bundle", 1, "approve", "22222222", "Reviewed the holdout metrics.");
  assert.strictEqual(approved.status, "approved");
  assert.strictEqual(approved.reviewedBy, "22222222");
  // 提交记录保留 candidate bundle（与 file 态一致）；active 副本只出现在 releases。
  assert.strictEqual(approved.bundle.models[0].status, "candidate");
  await rejectsWith(
    () => store.review("pg-bundle", 1, "reject", "22222222", "maybe"),
    409,
    "该提交已经完成审核"
  );
  await rejectsWith(() => store.submit(candidate("pg-bundle", 1), "33333333", ""), 409, "该 bundle revision 已经提交");
  await rejectsWith(() => store.submit(candidate("pg-bundle", 0), "33333333", ""), 400, "revision 必须是正整数");

  const catalog = await store.listApproved();
  assert.strictEqual(catalog.length, 1);
  assert.strictEqual(catalog[0].bundle.models[0].status, "active");
  assert.deepStrictEqual(await store.stats(), { approved: 1, pending: 0 });
  const submissions = await store.listSubmissions();
  assert.strictEqual(submissions.length, 1);
  assert.strictEqual(submissions[0].bundle.models[0].status, "candidate");
  assert.match(pool.evictSql, /status <> 'pending' ORDER BY updated_at_utc ASC LIMIT GREATEST/);

  await store.close();
  console.log("PostgreSQL calibration boundary PASS: 16/16");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
