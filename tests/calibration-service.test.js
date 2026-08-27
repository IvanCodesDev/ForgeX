/* P8 服务端校准候选、审核、发布、持久化与 API 契约。 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { CalibrationStore, digest } = require("../server/services/calibration");
const { createApp } = require("../server/index");

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-calibration-"));
  dirs.push(dir);
  return dir;
}
function cleanup() {
  dirs.forEach((dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      // 系统临时目录最终会由 OS 回收。
    }
  });
}
const quiet = { info() {}, warn() {}, error() {} };

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}
async function rejects(fn, status) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error && error.status === status;
  }
}
function candidate(id, revision) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id: id || "factory-p8",
    revision: revision || 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized production pairs submitted for independent calibration review.",
    },
    models: [
      {
        id: (id || "factory-p8") + "-pla",
        status: "candidate",
        scope: { machineId: "FX-P8-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.18, fixedOverheadSec: 80, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.16,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "c".repeat(64),
      },
    ],
  };
}

async function listen(app) {
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port));
  });
}
async function request(base, pathname, method, body, key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  const response = await fetch(base + pathname, {
    method: method || "GET",
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // 所有目标 API 都应返回 JSON；失败时 text 会进入断言详情。
  }
  return { status: response.status, json, text };
}

async function main() {
  console.log("\n[1] 服务状态机与原子发布");
  const dir = tmpDir();
  const store = new CalibrationStore({ dataDir: dir }, quiet);
  const first = candidate();
  check("内容摘要与 JSON 键顺序无关", digest(first) === digest(JSON.parse(JSON.stringify(first))));
  const pending = await store.submit(first, "reviewer-a", "Initial production candidate");
  check("候选进入 pending", pending.status === "pending" && store.pendingCount === 1);
  check("提交事件记录主体与时间", pending.events[0].actor === "reviewer-a" && pending.events[0].at > 0);
  check("同 bundle revision 不能重复提交", await rejects(() => store.submit(first, "x", "again"), 409));

  const synthetic = candidate("synthetic-p8", 1);
  synthetic.provenance = "synthetic-conformance";
  check("合成来源不能进入服务端审批", await rejects(() => store.submit(synthetic, "x", "no"), 400));
  const preactivated = candidate("active-p8", 1);
  preactivated.models[0].status = "active";
  check("客户端不能绕过审批直接提交 active", await rejects(() => store.submit(preactivated, "x", "no"), 400));

  const approved = await store.review(
    first.id,
    first.revision,
    "approve",
    "reviewer-b",
    "Holdout metrics and anonymization evidence reviewed."
  );
  check("审核后状态变为 approved", approved.status === "approved" && store.pendingCount === 0);
  const published = store.listApproved()[0];
  check("发布副本把 candidate 提升为 active", published.bundle.models[0].status === "active");
  check("发布保留 SHA-256 摘要与审核主体", /^[a-f0-9]{64}$/.test(published.digest) && published.approvedBy === "reviewer-b");
  check("提交与审核形成两条审计事件", approved.events.map((event) => event.action).join(",") === "submitted,approved");
  check("已审核提交不能二次审核", await rejects(
    () => store.review(first.id, 1, "reject", "reviewer-c", "Second review is forbidden."),
    409
  ));
  check("已发布 revision 不能倒退", await rejects(() => store.submit(candidate(first.id, 1), "x", "old"), 409));

  const second = candidate(first.id, 2);
  second.models[0].id = first.models[0].id;
  await store.submit(second, "reviewer-a", "Revision two candidate");
  await store.review(
    second.id,
    2,
    "approve",
    "reviewer-b",
    "Revision two holdout metrics were independently reviewed."
  );
  check("更高 revision 原子替换公开目录", store.listApproved().length === 1 && store.listApproved()[0].revision === 2);

  const poor = candidate("poor-p8", 1);
  poor.models[0].validation.holdoutSamples = 2;
  await store.submit(poor, "reviewer-a", "Insufficient holdout candidate");
  check(
    "审核时重新执行 active holdout 门槛",
    await rejects(
      () => store.review(poor.id, 1, "approve", "reviewer-b", "Insufficient holdout must be blocked."),
      409
    )
  );
  const rejectedCandidate = candidate("rejected-p8", 1);
  await store.submit(rejectedCandidate, "reviewer-a", "Candidate with disputed provenance");
  const rejected = await store.review(
    rejectedCandidate.id,
    1,
    "reject",
    "reviewer-b",
    "Source authorization could not be verified."
  );
  check("拒绝记录不会进入公开目录", rejected.status === "rejected" && store.approvedCount === 1);
  const restarted = new CalibrationStore({ dataDir: dir }, quiet);
  check("重启后发布版本与审计记录仍在", restarted.listApproved()[0].revision === 2 && restarted.listSubmissions().length === 4);

  console.log("\n[2] HTTP 鉴权与浏览器目录契约");
  const noKeyApp = createApp({
    dataDir: tmpDir(),
    apiKeys: "",
    calibrationReviewKeys: "",
    forceMock: true,
    probeProvider: false,
    rateLimitMs: 0,
    logLevel: "error",
  });
  const noKeyBase = "http://127.0.0.1:" + (await listen(noKeyApp));
  const emptyCatalog = await request(noKeyBase, "/api/calibrations", "GET");
  check("公开目录无需密钥且初始为空", emptyCatalog.status === 200 && emptyCatalog.json.items.length === 0);
  const disabledWrite = await request(noKeyBase, "/api/calibrations/submissions", "POST", {
    bundle: candidate("api-disabled", 1),
    note: "write disabled",
  });
  check("未配置 API_KEYS 时审批写接口关闭", disabledWrite.status === 503, disabledWrite.text);
  const disabledQueue = await request(noKeyBase, "/api/calibrations/submissions", "GET");
  check("未配置审核 key 时队列读取关闭", disabledQueue.status === 503, disabledQueue.text);
  await noKeyApp.close();

  const submitOnlyApp = createApp({
    dataDir: tmpDir(),
    apiKeys: "p8-submit-only",
    calibrationReviewKeys: "",
    forceMock: true,
    probeProvider: false,
    rateLimitMs: 0,
    logLevel: "error",
  });
  const submitOnlyBase = "http://127.0.0.1:" + (await listen(submitOnlyApp));
  const submitWithoutReviewRole = await request(
    submitOnlyBase,
    "/api/calibrations/submissions",
    "POST",
    { bundle: candidate("api-submit-only", 1), note: "Submission remains available without reviewers" },
    "p8-submit-only"
  );
  check("只配置 API_KEYS 时仍可提交候选", submitWithoutReviewRole.status === 201, submitWithoutReviewRole.text);
  const queueWithoutReviewRole = await request(submitOnlyBase, "/api/calibrations/submissions", "GET", null, "p8-submit-only");
  check("未配置 CALIBRATION_REVIEW_KEYS 时队列关闭", queueWithoutReviewRole.status === 503, queueWithoutReviewRole.text);
  const reviewWithoutReviewRole = await request(
    submitOnlyBase,
    "/api/calibrations/api-submit-only/revisions/1/review",
    "POST",
    { decision: "approve", reason: "A general API key must not review this candidate." },
    "p8-submit-only"
  );
  check("未配置 CALIBRATION_REVIEW_KEYS 时审核关闭", reviewWithoutReviewRole.status === 503, reviewWithoutReviewRole.text);
  const publicWithoutReviewRole = await request(submitOnlyBase, "/api/calibrations", "GET");
  check(
    "审核角色未配置不影响公开目录",
    publicWithoutReviewRole.status === 200 && publicWithoutReviewRole.json.items.length === 0,
    publicWithoutReviewRole.text
  );
  await submitOnlyApp.close();

  const apiDir = tmpDir();
  const app = createApp({
    dataDir: apiDir,
    apiKeys: "p8-submitter,p8-distributor,p8-reviewer",
    calibrationReviewKeys: "p8-reviewer",
    forceMock: true,
    probeProvider: false,
    rateLimitMs: 0,
    logLevel: "error",
  });
  const base = "http://127.0.0.1:" + (await listen(app));
  const unauthorized = await request(base, "/api/calibrations/submissions", "POST", {
    bundle: candidate("api-p8", 1),
    note: "unauthorized",
  });
  check("无效身份不能提交候选", unauthorized.status === 401, unauthorized.text);
  const submitted = await request(
    base,
    "/api/calibrations/submissions",
    "POST",
    { bundle: candidate("api-p8", 1), note: "Authorized candidate submission" },
    "p8-submitter"
  );
  check("有效 API Key 可提交候选", submitted.status === 201 && submitted.json.status === "pending", submitted.text);
  check("响应只暴露 key 摘要标识", submitted.json.submittedBy && !submitted.text.includes("p8-submitter"), submitted.text);

  const ordinaryQueue = await request(base, "/api/calibrations/submissions", "GET", null, "p8-submitter");
  check("普通提交 key 不能读取审核队列", ordinaryQueue.status === 403, ordinaryQueue.text);
  const distributorQueue = await request(base, "/api/calibrations/submissions", "GET", null, "p8-distributor");
  check("可分发 API key 不能读取审核队列", distributorQueue.status === 403, distributorQueue.text);
  const distributorReview = await request(
    base,
    "/api/calibrations/api-p8/revisions/1/review",
    "POST",
    { decision: "approve", reason: "A distributable key must not approve candidates." },
    "p8-distributor"
  );
  check("可分发 API key 不能调用审核接口", distributorReview.status === 403, distributorReview.text);

  const queue = await request(base, "/api/calibrations/submissions", "GET", null, "p8-reviewer");
  check("审核者可查看完整候选与审计队列", queue.status === 200 && queue.json.submissions.length === 1);

  const selfSubmitted = await request(
    base,
    "/api/calibrations/submissions",
    "POST",
    { bundle: candidate("api-self-review", 1), note: "Reviewer-authored candidate for four-eyes regression" },
    "p8-reviewer"
  );
  check("受信审核 key 同时位于 API_KEYS 时可提交候选", selfSubmitted.status === 201, selfSubmitted.text);
  const selfReview = await request(
    base,
    "/api/calibrations/api-self-review/revisions/1/review",
    "POST",
    { decision: "approve", reason: "Submitter must not approve the same candidate." },
    "p8-reviewer"
  );
  check("审核 key 通过路由后仍由 store 禁止自我审批", selfReview.status === 409, selfReview.text);
  const review = await request(
    base,
    "/api/calibrations/api-p8/revisions/1/review",
    "POST",
    { decision: "approve", reason: "API holdout and provenance review completed." },
    "p8-reviewer"
  );
  check("审核 API 发布候选", review.status === 200 && review.json.status === "approved", review.text);
  const catalog = await request(base, "/api/calibrations", "GET");
  check(
    "公开目录只返回 active 发布副本",
    catalog.status === 200 &&
      catalog.json.items.length === 1 &&
      catalog.json.items[0].bundle.models[0].status === "active"
  );
  const health = await request(base, "/healthz", "GET");
  check("healthz 披露发布数和写接口状态", health.json.calibrations.approved === 1 && health.json.calibrations.writesEnabled);
  await app.close();

  cleanup();
  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  cleanup();
  console.error("测试框架异常：", error);
  process.exitCode = 1;
});
