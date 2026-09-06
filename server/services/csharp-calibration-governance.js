/* 校准治理（候选提交 / 审批 / 目录）的 C# 权威门面（CALIBRATION_GOVERNANCE_AUTHORITY=csharp）。

   身份仍由 Node routes/calibration.js 判定（submitter / reviewer 的 401 / 403 / 503 不出本进程），
   本门面只把已解析的 actor（keyId）经可信通道的 X-ForgeX-Actor-* 头交给 ForgeX.Api，
   状态机、去重、版本单调、四眼原则与存储全部在 C# 侧执行。
   C# 的 problem+json 原样映射为 HttpError(status, title)，文案与 Node 存储层一致。 */
"use strict";
const { HttpError } = require("../lib/http");
const { authorityRequest, authorityProblem, AuthorityUnavailableError } = require("../lib/authority-client");

const UNAVAILABLE = "校准服务暂不可用，请稍后再试";

/* 校准治理是部署级单租户：C# 侧按 Calibrations:TenantId 存储，这里的 tenant/owner 头只用于
   通过可信通道的形状校验并留下审计线索，取值与 §7.3 一致（"key:" + keyId 的匿名化哈希）。 */
function identityFor(actor) {
  const value = "key:" + String(actor || "");
  return { tenantId: value, caller: value };
}

class CsharpCalibrationGovernanceStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || { info() {}, warn() {}, error() {} };
  }

  async _call(identity, method, pathname, payload, headers) {
    try {
      return await authorityRequest(this.cfg, identity, method, pathname, payload, { headers });
    } catch (error) {
      if (error instanceof AuthorityUnavailableError) {
        this.log.warn("calibration governance authority unreachable", { method, pathname, error: error.message });
        throw new HttpError(502, UNAVAILABLE);
      }
      throw error;
    }
  }

  _reject(response, context) {
    const problem = authorityProblem(response);
    if (problem && problem.status >= 400 && problem.status < 500 && problem.title) {
      throw new HttpError(problem.status, problem.title);
    }
    if (response.status === 404) throw new HttpError(404, "校准包提交不存在");
    this.log.warn("calibration governance authority rejected", { context, status: response.status });
    throw new HttpError(502, UNAVAILABLE);
  }

  _actorHeaders(actor, role) {
    return { "x-forgex-actor-key-id": String(actor || ""), "x-forgex-actor-role": role };
  }

  async listApproved() {
    // 公开目录：不注入任何身份上下文。
    const response = await this._call(null, "GET", "/api/v1/calibrations", null);
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || !Array.isArray(parsed.items)) this._reject(response, "catalog");
    return parsed.items;
  }

  async listSubmissions(actor) {
    const response = await this._call(identityFor(actor), "GET", "/api/v1/calibrations/submissions", null,
      this._actorHeaders(actor, "reviewer"));
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || !Array.isArray(parsed.submissions)) this._reject(response, "submissions");
    return parsed.submissions;
  }

  async submit(bundle, actor, note) {
    const response = await this._call(identityFor(actor), "POST", "/api/v1/calibrations/submissions",
      { bundle, note }, this._actorHeaders(actor, "submitter"));
    const parsed = response.status === 201 ? response.json() : null;
    if (!parsed || typeof parsed.id !== "string") this._reject(response, "submit");
    return parsed;
  }

  async review(id, revision, decision, actor, reason) {
    const pathname = "/api/v1/calibrations/" + encodeURIComponent(String(id)) +
      "/revisions/" + encodeURIComponent(String(revision)) + "/review";
    const response = await this._call(identityFor(actor), "POST", pathname,
      { decision, reason }, this._actorHeaders(actor, "reviewer"));
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || typeof parsed.id !== "string") this._reject(response, "review");
    return parsed;
  }

  async stats() {
    const response = await this._call(null, "GET", "/api/v1/calibrations/stats", null);
    const parsed = response.status === 200 ? response.json() : null;
    if (!parsed || typeof parsed.approved !== "number") this._reject(response, "stats");
    return { approved: parsed.approved, pending: parsed.pending };
  }
}

module.exports = { CsharpCalibrationGovernanceStore };
