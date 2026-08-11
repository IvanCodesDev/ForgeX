/* 校准发布 API：公开读取 active bundle；候选提交与审核使用彼此独立的角色密钥。 */
"use strict";

const { HttpError, readJson, sendJson } = require("../lib/http");

function submitter(req, rc, auth) {
  if (!auth.enabled) {
    throw new HttpError(503, "校准候选提交接口未启用：请先配置 API_KEYS");
  }
  const identity = auth.identify(req, rc.ip);
  if (!identity.authenticated) {
    throw new HttpError(401, "校准候选提交需要有效 API Key");
  }
  return identity.keyId;
}

function reviewer(req, auth) {
  if (!auth.reviewEnabled) {
    throw new HttpError(503, "校准审核接口未启用：请先配置 CALIBRATION_REVIEW_KEYS");
  }
  if (!auth.keyOf(req)) {
    throw new HttpError(401, "校准审核需要审核密钥");
  }
  const identity = auth.identifyReviewer(req);
  if (!identity.authenticated) {
    // 普通 API key 是有效调用凭据，但不代表审核授权；统一返回 403，且不披露
    // 审核 key 列表或匹配细节。
    throw new HttpError(403, "当前凭据没有校准审核权限");
  }
  return identity.keyId;
}

function register(router, ctx) {
  const { calibrations, auth } = ctx;

  router.add("GET", /^\/api\/calibrations$/, (_req, res) => {
    sendJson(res, 200, {
      format: "forgex-calibration-catalog",
      version: 1,
      items: calibrations.listApproved(),
    });
  });

  router.add("GET", /^\/api\/calibrations\/submissions$/, (req, res) => {
    reviewer(req, auth);
    sendJson(res, 200, { submissions: calibrations.listSubmissions() });
  });

  router.add("POST", /^\/api\/calibrations\/submissions$/, async (req, res, _m, rc) => {
    const actor = submitter(req, rc, auth);
    const body = await readJson(req, 2 * 1024 * 1024 + 64 * 1024);
    const record = calibrations.submit(body.bundle, actor, body.note);
    sendJson(res, 201, {
      id: record.id,
      revision: record.revision,
      status: record.status,
      digest: record.digest,
      submittedBy: record.submittedBy,
    });
  });

  router.add(
    "POST",
    /^\/api\/calibrations\/([A-Za-z0-9._-]+)\/revisions\/(\d+)\/review$/,
    async (req, res, m) => {
      const actor = reviewer(req, auth);
      const body = await readJson(req, 16 * 1024);
      const record = calibrations.review(m[1], Number(m[2]), body.decision, actor, body.reason);
      sendJson(res, 200, {
        id: record.id,
        revision: record.revision,
        status: record.status,
        reviewedBy: record.reviewedBy,
        reviewReason: record.reviewReason,
      });
    }
  );
}

module.exports = { register };
