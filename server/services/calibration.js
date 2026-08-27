/* 服务端校准发布仓库。
 *
 * 浏览器本地 bundle 解决个人工作流；这里解决多人环境中的候选提交、人工审核、
 * active 发布、revision 单调性与审计记录。整个状态写入一个 JsonFile，因此一次
 * approve 对“提交状态 + 当前发布版本”的修改只产生一次原子 rename。
 */
"use strict";

const crypto = require("crypto");
const path = require("path");
const { HttpError } = require("../lib/http");
const { JsonFile } = require("../lib/store");
const { createRulesEngine } = require("./rules-engine");

const FORMAT = "forgex-calibration-service-state";
const VERSION = 1;
const MAX_SUBMISSIONS = 200;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function digest(bundle) {
  return crypto.createHash("sha256").update(stable(bundle)).digest("hex");
}

function submissionKey(id, revision) {
  return String(id) + "@" + String(revision);
}

class CalibrationStore {
  constructor(cfg, log, rulesEngine) {
    // 校准包验证走异步规则引擎边界（node 模式即 classic calibration-registry，语义不变）
    this.engine = rulesEngine || createRulesEngine({ config: cfg });
    const file = cfg.dataDir ? path.join(cfg.dataDir, "calibrations.json") : "";
    this.file = new JsonFile(
      file,
      { format: FORMAT, version: VERSION, submissions: {}, approved: {} },
      log
    );
    const data = this.file.data;
    if (
      data.format !== FORMAT ||
      data.version !== VERSION ||
      !data.submissions ||
      typeof data.submissions !== "object" ||
      !data.approved ||
      typeof data.approved !== "object"
    ) {
      this.file.data = { format: FORMAT, version: VERSION, submissions: {}, approved: {} };
    }
  }

  _save() {
    this.file.save();
  }

  _event(action, actor, reason) {
    return {
      action,
      at: Date.now(),
      actor: String(actor || "unknown"),
      reason: String(reason || "").slice(0, 500),
    };
  }

  async submit(rawBundle, actor, note) {
    const checked = await this.engine.validateBundle(rawBundle);
    if (!checked.ok) throw new HttpError(400, checked.errors.join("；"));
    if (!["real-anonymized", "real-consented"].includes(rawBundle.provenance)) {
      throw new HttpError(400, "服务端只接受具有真实数据来源声明的候选校准包");
    }
    if (!rawBundle.models.every((model) => model.status === "candidate")) {
      throw new HttpError(400, "提交到审批队列的模型必须全部为 candidate");
    }

    const key = submissionKey(rawBundle.id, rawBundle.revision);
    if (this.file.data.submissions[key]) {
      throw new HttpError(409, "该 bundle revision 已经提交");
    }
    const current = this.file.data.approved[rawBundle.id];
    if (current && current.bundle.revision >= rawBundle.revision) {
      throw new HttpError(409, "新提交的 revision 必须高于当前已发布版本");
    }

    const now = Date.now();
    const record = {
      key,
      id: rawBundle.id,
      revision: rawBundle.revision,
      status: "pending",
      digest: digest(rawBundle),
      bundle: clone(rawBundle),
      createdAt: now,
      updatedAt: now,
      submittedBy: actor,
      note: String(note || "").slice(0, 500),
      events: [this._event("submitted", actor, note)],
    };
    this.file.data.submissions[key] = record;
    this._evict();
    this._save();
    return clone(record);
  }

  async review(id, revision, decision, actor, reason) {
    const key = submissionKey(id, revision);
    const record = this.file.data.submissions[key];
    if (!record) throw new HttpError(404, "校准包提交不存在");
    if (record.status !== "pending") throw new HttpError(409, "该提交已经完成审核");
    if (!["approve", "reject"].includes(decision)) {
      throw new HttpError(400, "decision 必须是 approve 或 reject");
    }
    if (String(reason || "").trim().length < 10) {
      throw new HttpError(400, "审核原因至少需要 10 个字符");
    }
    if (decision === "approve" && record.submittedBy === actor) {
      throw new HttpError(409, "提交者不能审批自己提交的校准包");
    }

    if (decision === "approve") {
      const published = clone(record.bundle);
      published.models.forEach((model) => {
        model.status = "active";
      });
      const checked = await this.engine.validateBundle(published);
      if (!checked.ok) {
        throw new HttpError(409, "候选模型未达到 active 准入条件：" + checked.errors.join("；"));
      }
      const current = this.file.data.approved[published.id];
      if (current && current.bundle.revision >= published.revision) {
        throw new HttpError(409, "审批版本不高于当前已发布版本");
      }
      this.file.data.approved[published.id] = {
        id: published.id,
        revision: published.revision,
        digest: digest(published),
        bundle: published,
        approvedAt: Date.now(),
        approvedBy: actor,
      };
      record.status = "approved";
    } else {
      record.status = "rejected";
    }
    record.updatedAt = Date.now();
    record.reviewedBy = actor;
    record.reviewReason = String(reason).slice(0, 500);
    record.events.push(this._event(decision === "approve" ? "approved" : "rejected", actor, reason));
    this._save();
    return clone(record);
  }

  listApproved() {
    return Object.values(this.file.data.approved)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  listSubmissions() {
    return Object.values(this.file.data.submissions)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  _evict() {
    const records = Object.values(this.file.data.submissions);
    if (records.length <= MAX_SUBMISSIONS) return;
    const removable = records
      .filter((record) => record.status !== "pending")
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let excess = records.length - MAX_SUBMISSIONS;
    for (const record of removable) {
      if (excess-- <= 0) break;
      delete this.file.data.submissions[record.key];
    }
  }

  get approvedCount() {
    return Object.keys(this.file.data.approved).length;
  }

  get pendingCount() {
    return Object.values(this.file.data.submissions).filter((record) => record.status === "pending")
      .length;
  }
}

/** 兼容旧引用的同步验证入口：等价于 node 模式规则引擎（惰性拉起 classic registry）。 */
function validateBundle(bundle) {
  require("../../frontend/classic/js/time-calibration.js");
  require("../../frontend/classic/js/calibration-registry.js");
  return globalThis.FXCalibrationRegistry.validateBundle(bundle);
}

module.exports = { CalibrationStore, digest, validateBundle };
