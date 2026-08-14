"use strict";

const crypto = require("crypto");
const { HttpError } = require("../lib/http");
const { createPool, withTransaction, closePool } = require("../lib/postgres");
const { digest, validateBundle } = require("./calibration");

const MAX_SUBMISSIONS = 200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalId(value, prefix) {
  return value === `${prefix}local` || (value && value.startsWith(prefix) && /^[a-f0-9]{32}$/.test(value.slice(prefix.length)));
}

function ownerIdFor(tenantId) {
  if (tenantId === "tn_local") return "ow_local";
  return "ow_" + crypto.createHash("sha256").update(tenantId).digest("hex").slice(0, 32);
}

function mapRecord(row) {
  return {
    key: row.key,
    id: row.bundle_id,
    revision: row.revision,
    status: row.status,
    digest: row.digest,
    bundle: row.bundle_json,
    createdAt: new Date(row.created_at_utc).getTime(),
    updatedAt: new Date(row.updated_at_utc).getTime(),
    submittedBy: row.submitted_by,
    note: row.note || "",
    reviewedBy: row.reviewed_by || undefined,
    reviewReason: row.review_reason || undefined,
    events: row.events_json || [],
  };
}

class PostgresCalibrationStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
    this.pool = cfg.postgresPool || createPool(cfg);
    this.ownsPool = !cfg.postgresPool;
    this.tenantId = cfg.postgresTenantId || "tn_local";
    this.ownerId = cfg.postgresOwnerId || ownerIdFor(this.tenantId);
    if (!canonicalId(this.tenantId, "tn_") || !canonicalId(this.ownerId, "ow_")) {
      throw new Error("PostgreSQL calibration tenant/owner context is invalid");
    }
    this._approvedCount = 0;
    this._pendingCount = 0;
  }

  _event(action, actor, reason) {
    return { action, at: Date.now(), actor: String(actor || "unknown"), reason: String(reason || "").slice(0, 500) };
  }

  _validateSubmit(rawBundle) {
    const checked = validateBundle(rawBundle);
    if (!checked.ok) throw new HttpError(400, checked.errors.join(", "));
    if (!["real-anonymized", "real-consented"].includes(rawBundle.provenance)) {
      throw new HttpError(400, "服务端只接受具有真实数据来源声明的候选校准包");
    }
    if (!rawBundle.models.every((model) => model.status === "candidate")) {
      throw new HttpError(400, "提交到审核队列的模型必须全部为 candidate");
    }
  }

  async submit(rawBundle, actor, note) {
    this._validateSubmit(rawBundle);
    const bundle = clone(rawBundle);
    const key = `${bundle.id}@${bundle.revision}`;
    return withTransaction(this.pool, this.tenantId, this.ownerId, async (client) => {
      const existing = await client.query(
        "SELECT key FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND key=$3",
        [this.tenantId, this.ownerId, key]
      );
      if (existing.rowCount) throw new HttpError(409, "该 bundle revision 已经提交");
      const current = await client.query(
        "SELECT revision FROM forgex.calibration_releases WHERE tenant_id=$1 AND bundle_id=$2",
        [this.tenantId, bundle.id]
      );
      if (current.rowCount && current.rows[0].revision >= bundle.revision) {
        throw new HttpError(409, "新提交的 revision 必须高于当前已发布版本");
      }
      const now = new Date();
      const record = {
        key,
        id: bundle.id,
        revision: bundle.revision,
        status: "pending",
        digest: digest(bundle),
        bundle,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
        submittedBy: actor,
        note: String(note || "").slice(0, 500),
        events: [this._event("submitted", actor, note)],
      };
      await client.query(
        `INSERT INTO forgex.calibration_submissions
          (tenant_id, owner_id, key, bundle_id, revision, status, digest, bundle_json,
           created_at_utc, updated_at_utc, submitted_by, note, events_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,$10,$11,$12::jsonb)`,
        [this.tenantId, this.ownerId, key, bundle.id, bundle.revision, record.status, record.digest,
          JSON.stringify(bundle), now, actor, record.note, JSON.stringify(record.events)]
      );
      await this._evict(client);
      this._pendingCount++;
      return clone(record);
    });
  }

  async review(id, revision, decision, actor, reason) {
    const key = `${id}@${revision}`;
    if (!["approve", "reject"].includes(decision)) throw new HttpError(400, "decision 必须是 approve 或 reject");
    if (String(reason || "").trim().length < 10) throw new HttpError(400, "审核原因至少需要 10 个字符");
    return withTransaction(this.pool, this.tenantId, this.ownerId, async (client) => {
      const found = await client.query(
        "SELECT * FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND key=$3 FOR UPDATE",
        [this.tenantId, this.ownerId, key]
      );
      if (!found.rowCount) throw new HttpError(404, "校准包提交不存在");
      const record = mapRecord(found.rows[0]);
      if (record.status !== "pending") throw new HttpError(409, "该提交已经完成审核");
      if (decision === "approve" && record.submittedBy === actor) {
        throw new HttpError(409, "提交者不能审核自己的校准包");
      }

      if (decision === "approve") {
        const published = clone(record.bundle);
        published.models.forEach((model) => { model.status = "active"; });
        const checked = validateBundle(published);
        if (!checked.ok) throw new HttpError(409, "候选模型未达到 active 准入条件：" + checked.errors.join(", "));
        const current = await client.query(
          "SELECT revision FROM forgex.calibration_releases WHERE tenant_id=$1 AND bundle_id=$2 FOR UPDATE",
          [this.tenantId, published.id]
        );
        if (current.rowCount && current.rows[0].revision >= published.revision) {
          throw new HttpError(409, "审批版本不高于当前已发布版本");
        }
        await client.query(
          `INSERT INTO forgex.calibration_releases
            (tenant_id, owner_id, bundle_id, revision, digest, bundle_json, approved_at_utc, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
           ON CONFLICT (tenant_id, bundle_id) DO UPDATE SET
             owner_id=EXCLUDED.owner_id, revision=EXCLUDED.revision, digest=EXCLUDED.digest,
             bundle_json=EXCLUDED.bundle_json, approved_at_utc=EXCLUDED.approved_at_utc, approved_by=EXCLUDED.approved_by`,
          [this.tenantId, this.ownerId, published.id, published.revision, digest(published), JSON.stringify(published), new Date(), actor]
        );
        record.bundle = published;
      }

      record.status = decision === "approve" ? "approved" : "rejected";
      record.updatedAt = Date.now();
      record.reviewedBy = actor;
      record.reviewReason = String(reason).slice(0, 500);
      record.events.push(this._event(decision === "approve" ? "approved" : "rejected", actor, reason));
      await client.query(
        `UPDATE forgex.calibration_submissions
         SET status=$4, updated_at_utc=$5, reviewed_by=$6, review_reason=$7, bundle_json=$8::jsonb, events_json=$9::jsonb
         WHERE tenant_id=$1 AND owner_id=$2 AND key=$3`,
        [this.tenantId, this.ownerId, key, record.status, new Date(record.updatedAt), actor,
          record.reviewReason, JSON.stringify(record.bundle), JSON.stringify(record.events)]
      );
      if (record.status === "pending") this._pendingCount--;
      else this._pendingCount = Math.max(0, this._pendingCount - 1);
      return clone(record);
    });
  }

  async listApproved() {
    const result = await withTransaction(this.pool, this.tenantId, this.ownerId, (client) => client.query(
      "SELECT bundle_id, revision, digest, bundle_json, approved_at_utc, approved_by FROM forgex.calibration_releases WHERE tenant_id=$1 ORDER BY bundle_id",
      [this.tenantId]
    ));
    this._approvedCount = result.rowCount;
    return result.rows.map((row) => ({
      id: row.bundle_id,
      revision: row.revision,
      digest: row.digest,
      bundle: row.bundle_json,
      approvedAt: new Date(row.approved_at_utc).getTime(),
      approvedBy: row.approved_by,
    }));
  }

  async listSubmissions() {
    const result = await withTransaction(this.pool, this.tenantId, this.ownerId, (client) => client.query(
      "SELECT * FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at_utc DESC",
      [this.tenantId, this.ownerId]
    ));
    this._pendingCount = result.rows.filter((row) => row.status === "pending").length;
    return result.rows.map(mapRecord);
  }

  async stats() {
    const result = await withTransaction(this.pool, this.tenantId, this.ownerId, (client) => client.query(
      `SELECT
         (SELECT count(*)::int FROM forgex.calibration_releases WHERE tenant_id=$1) AS approved,
         (SELECT count(*)::int FROM forgex.calibration_submissions WHERE tenant_id=$1 AND owner_id=$2 AND status='pending') AS pending`,
      [this.tenantId, this.ownerId]
    ));
    this._approvedCount = result.rows[0].approved;
    this._pendingCount = result.rows[0].pending;
    return { approved: this._approvedCount, pending: this._pendingCount };
  }

  async _evict(client) {
    await client.query(
      `DELETE FROM forgex.calibration_submissions
       WHERE tenant_id=$1 AND owner_id=$2 AND key IN (
         SELECT key FROM forgex.calibration_submissions
         WHERE tenant_id=$1 AND owner_id=$2 AND status <> 'pending'
         ORDER BY updated_at_utc ASC
         LIMIT GREATEST((SELECT count(*) FROM forgex.calibration_submissions
                         WHERE tenant_id=$1 AND owner_id=$2) - $3, 0)
       )`,
      [this.tenantId, this.ownerId, MAX_SUBMISSIONS]
    );
  }

  sweep() {}

  get approvedCount() { return this._approvedCount; }
  get pendingCount() { return this._pendingCount; }

  async close() { await closePool(this.pool, this.ownsPool); }
}

module.exports = { PostgresCalibrationStore };
