/* 校准发布 API：公开读取 active bundle；候选提交和审核必须使用已配置 API Key。 */
"use strict";

const { HttpError, readJson, sendJson } = require("../lib/http");

function reviewer(req, rc, auth) {
  if (!auth.enabled) {
    throw new HttpError(503, "校准审批写接口未启用：请先配置 API_KEYS");
  }
  const identity = auth.identify(req, rc.ip);
  if (!identity.authenticated) {
    throw new HttpError(401, "校准审批需要有效 API Key");
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

  router.add("GET", /^\/api\/calibrations\/submissions$/, (req, res, _m, rc) => {
    reviewer(req, rc, auth);
    sendJson(res, 200, { submissions: calibrations.listSubmissions() });
  });

  router.add("POST", /^\/api\/calibrations\/submissions$/, async (req, res, _m, rc) => {
    const actor = reviewer(req, rc, auth);
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
    async (req, res, m, rc) => {
      const actor = reviewer(req, rc, auth);
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
