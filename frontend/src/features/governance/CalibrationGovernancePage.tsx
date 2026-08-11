import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import { createGovernanceClient, type GovernanceClient } from "./governance-client";
import type {
  CalibrationCatalog,
  CalibrationReviewDecision,
  CalibrationSubmission,
  PublishedCalibration,
} from "./governance-types";
import { KnownShareLookup } from "./KnownShareLookup";
import "./governance.css";

type LoadPhase = "idle" | "loading" | "ready" | "error";

interface ResourceState<T> {
  readonly phase: LoadPhase;
  readonly value: T;
  readonly message: string;
}

export interface CalibrationGovernancePageProps {
  readonly runtimeMode: RuntimeMode;
  readonly client?: GovernanceClient;
}

const EMPTY_CATALOG: CalibrationCatalog = {
  format: "forgex-calibration-catalog",
  version: 1,
  items: [],
};
function message(error: unknown): string {
  return error instanceof Error ? error.message : "校准治理请求失败";
}

function timestamp(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function percent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function CatalogItem({ item }: { readonly item: PublishedCalibration }) {
  return (
    <article className="governance-card">
      <header>
        <div>
          <h3>
            {item.id} <small>r{item.revision}</small>
          </h3>
          <p>
            {item.bundle.provenance} · {item.bundle.source.license} · {item.bundle.models.length} 个模型
          </p>
        </div>
        <span className="governance-status governance-status-approved">active</span>
      </header>
      <dl className="governance-metadata">
        <div>
          <dt>批准时间</dt>
          <dd>{timestamp(item.approvedAt)}</dd>
        </div>
        <div>
          <dt>审核主体</dt>
          <dd>{item.approvedBy}</dd>
        </div>
        <div className="governance-digest">
          <dt>发布摘要</dt>
          <dd>
            <code>{item.digest}</code>
          </dd>
        </div>
      </dl>
      <p className="muted">来源说明：{item.bundle.source.note}</p>
      <div className="governance-models">
        {item.bundle.models.map((model) => (
          <section key={model.id} aria-label={`${model.id} 校准证据`}>
            <h4>{model.id}</h4>
            <p>
              {model.scope.machineId} · {model.scope.firmware} · {model.scope.material ?? "全部材料"}
            </p>
            <dl>
              <div>
                <dt>样本 / 留出</dt>
                <dd>
                  {model.coefficients.sampleCount} / {model.validation.holdoutSamples}
                </dd>
              </div>
              <div>
                <dt>MAPE / 门槛</dt>
                <dd>
                  {percent(model.validation.mape)} / {percent(model.thresholds.maxMape)}
                </dd>
              </div>
              <div>
                <dt>中位偏差 / 门槛</dt>
                <dd>
                  {percent(model.validation.medianBias)} / ±{percent(model.thresholds.maxBias)}
                </dd>
              </div>
              <div>
                <dt>训练集摘要</dt>
                <dd title={model.trainingSetSha256}>
                  <code>{model.trainingSetSha256.slice(0, 12)}…</code>
                </dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
    </article>
  );
}

interface SubmissionCardProps {
  readonly submission: CalibrationSubmission;
  readonly reason: string;
  readonly busy: boolean;
  readonly onReason: (value: string) => void;
  readonly onReview: (decision: CalibrationReviewDecision) => void;
}

function SubmissionCard({ submission, reason, busy, onReason, onReview }: SubmissionCardProps) {
  const pending = submission.status === "pending";
  const reasonId = `review-reason-${submission.id}-${submission.revision}`;
  return (
    <article className="governance-card governance-submission">
      <header>
        <div>
          <h3>
            {submission.id} <small>r{submission.revision}</small>
          </h3>
          <p>
            提交于 {timestamp(submission.createdAt)} · {submission.bundle.models.length} 个候选模型
          </p>
        </div>
        <span className={`governance-status governance-status-${submission.status}`}>{submission.status}</span>
      </header>
      <dl className="governance-metadata">
        <div>
          <dt>提交主体</dt>
          <dd>{submission.submittedBy}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{submission.bundle.provenance}</dd>
        </div>
        <div>
          <dt>备注</dt>
          <dd>{submission.note || "—"}</dd>
        </div>
      </dl>
      {pending ? (
        <div className="governance-review-form">
          <label htmlFor={reasonId}>
            审核原因（至少 10 个字符）
            <textarea
              id={reasonId}
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => onReason(event.currentTarget.value)}
            />
          </label>
          <div>
            <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => onReview("approve")}>
              批准并发布
            </button>
            <button
              type="button"
              className="governance-reject"
              disabled={busy || reason.trim().length < 10}
              onClick={() => onReview("reject")}
            >
              拒绝候选
            </button>
          </div>
          <p className="muted">服务端将重新校验 active 门槛，并禁止提交者审批自己的候选。</p>
        </div>
      ) : (
        <p className="muted">
          {submission.reviewedBy ? `审核主体：${submission.reviewedBy}` : "已完成审核"}
          {submission.reviewReason ? ` · ${submission.reviewReason}` : ""}
        </p>
      )}
    </article>
  );
}

export function CalibrationGovernancePage({ runtimeMode, client: suppliedClient }: CalibrationGovernancePageProps) {
  const client = useMemo(() => suppliedClient ?? createGovernanceClient(runtimeMode), [runtimeMode, suppliedClient]);
  const controllerRef = useRef<AbortController | null>(null);
  const reviewControllerRef = useRef<AbortController | null>(null);
  const [catalog, setCatalog] = useState<ResourceState<CalibrationCatalog>>({
    phase: client.mode === "offline" ? "ready" : "idle",
    value: EMPTY_CATALOG,
    message: "",
  });
  const [submissions, setSubmissions] = useState<ResourceState<readonly CalibrationSubmission[]>>({
    phase: "idle",
    value: [],
    message: "",
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    if (client.mode === "offline") {
      setCatalog({ phase: "ready", value: EMPTY_CATALOG, message: "离线模式不请求服务端目录。" });
      setSubmissions({ phase: "ready", value: [], message: "离线模式不请求审核队列。" });
      return;
    }

    setCatalog((current) => ({ ...current, phase: "loading", message: "" }));
    setSubmissions((current) => ({
      ...current,
      phase: client.canReview ? "loading" : "ready",
      message: client.canReview ? "" : "浏览器治理页固定为只读；审核队列仅向受信后台的专用身份开放。",
    }));

    const catalogPromise = client
      .loadCatalog(controller.signal)
      .then((value) => setCatalog({ phase: "ready", value, message: "" }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setCatalog((current) => ({ ...current, phase: "error", message: message(error) }));
      });
    const submissionsPromise = client.canReview
      ? client
          .loadSubmissions(controller.signal)
          .then((value) => setSubmissions({ phase: "ready", value, message: "" }))
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              setSubmissions((current) => ({ ...current, phase: "error", message: message(error) }));
            }
          })
      : Promise.resolve();

    await Promise.all([catalogPromise, submissionsPromise]);
  }, [client]);

  useEffect(() => {
    void refresh();
    return () => {
      controllerRef.current?.abort();
      reviewControllerRef.current?.abort();
    };
  }, [refresh]);

  const review = async (submission: CalibrationSubmission, decision: CalibrationReviewDecision) => {
    const key = submission.key;
    const reason = reasons[key]?.trim() ?? "";
    if (reason.length < 10) {
      setReviewMessage("审核原因至少需要 10 个字符。");
      return;
    }
    reviewControllerRef.current?.abort();
    const controller = new AbortController();
    reviewControllerRef.current = controller;
    setReviewing(key);
    setReviewMessage("");
    try {
      const result = await client.reviewSubmission(
        { id: submission.id, revision: submission.revision, decision, reason },
        controller.signal
      );
      setReviewMessage(`${result.id} r${result.revision} 已${result.status === "approved" ? "批准发布" : "拒绝"}。`);
      await refresh();
    } catch (error) {
      if (!controller.signal.aborted) setReviewMessage(message(error));
    } finally {
      if (!controller.signal.aborted) setReviewing("");
    }
  };

  return (
    <div className="page-stack governance-page">
      <section className="hero-panel">
        <p className="eyebrow">CALIBRATION / GOVERNANCE / STAGE 2</p>
        <h1>已发布模型、验证证据与人工审核队列保持同一条治理链。</h1>
        <p className="hero-copy">
          公开目录只读取服务端已批准的 active bundle；浏览器端不承载审核密钥，人工审核由受信后台的专用身份执行，
          服务端继续强制四眼复核、版本单调与准入门槛。
        </p>
      </section>

      {client.mode === "offline" ? (
        <section className="panel governance-offline" aria-labelledby="governance-offline-heading">
          <p className="eyebrow">OFFLINE / READ ONLY</p>
          <h2 id="governance-offline-heading">离线预览不连接校准发布服务</h2>
          <p>
            此模式只说明治理流程，不拉取公开目录、审核队列或分享页。切换到服务模式后才能核验发布摘要和服务端审计状态。
          </p>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="governance-catalog-heading">
        <div className="panel-heading governance-heading">
          <div>
            <p className="eyebrow">PUBLIC CATALOG / ACTIVE ONLY</p>
            <h2 id="governance-catalog-heading">已发布校准目录</h2>
          </div>
          <button
            type="button"
            disabled={catalog.phase === "loading" || client.mode === "offline"}
            onClick={() => void refresh()}
          >
            {catalog.phase === "loading" ? "正在同步…" : "刷新目录"}
          </button>
        </div>
        {catalog.phase === "error" ? (
          <p className="error-copy" role="alert">
            {catalog.message}
          </p>
        ) : catalog.phase === "loading" && !catalog.value.items.length ? (
          <p role="status">正在读取已审核目录…</p>
        ) : catalog.value.items.length ? (
          <div className="governance-list">
            {catalog.value.items.map((item) => (
              <CatalogItem key={`${item.id}@${item.revision}`} item={item} />
            ))}
          </div>
        ) : (
          <p className="muted" role="status">
            {client.mode === "offline" ? "离线模式不含服务端发布记录。" : "服务端当前没有已发布校准 bundle。"}
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="governance-review-heading">
        <div className="panel-heading governance-heading">
          <div>
            <p className="eyebrow">REVIEW QUEUE / TRUSTED BACK OFFICE ONLY</p>
            <h2 id="governance-review-heading">候选审核队列</h2>
          </div>
          <span className={`governance-access governance-access-${client.canReview ? "reviewer" : "readonly"}`}>
            {client.canReview ? "受信审核会话" : "浏览器只读"}
          </span>
        </div>
        {submissions.message ? (
          <p
            className={submissions.phase === "error" ? "error-copy" : "muted"}
            role={submissions.phase === "error" ? "alert" : "status"}
          >
            {submissions.message}
          </p>
        ) : null}
        {submissions.phase === "loading" ? <p role="status">正在核验凭据并读取审核队列…</p> : null}
        {submissions.phase === "ready" && client.canReview && !submissions.value.length ? (
          <p className="muted">审核队列为空。</p>
        ) : null}
        {submissions.value.length ? (
          <div className="governance-list">
            {submissions.value.map((submission) => (
              <SubmissionCard
                key={submission.key}
                submission={submission}
                reason={reasons[submission.key] ?? ""}
                busy={reviewing === submission.key}
                onReason={(value) => setReasons((current) => ({ ...current, [submission.key]: value }))}
                onReview={(decision) => void review(submission, decision)}
              />
            ))}
          </div>
        ) : null}
        {reviewMessage ? (
          <p className={/已批准发布|已拒绝/.test(reviewMessage) ? "governance-success" : "error-copy"} role="status">
            {reviewMessage}
          </p>
        ) : null}
      </section>

      <KnownShareLookup client={client} />
    </div>
  );
}
