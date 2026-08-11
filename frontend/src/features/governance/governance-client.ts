import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import type {
  CalibrationAuditEvent,
  CalibrationBundle,
  CalibrationCatalog,
  CalibrationModel,
  CalibrationReviewInput,
  CalibrationReviewResult,
  CalibrationSubmission,
  PublishedCalibration,
} from "./governance-types";

const REQUEST_TIMEOUT_MS = 8_000;
const CALIBRATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHARE_TOKEN = /^[a-f0-9]{18}$/;

export type GovernanceClientMode = "offline" | "remote-public" | "remote-reviewer";

export interface GovernanceClient {
  readonly mode: GovernanceClientMode;
  readonly canReview: boolean;
  loadCatalog(signal?: AbortSignal): Promise<CalibrationCatalog>;
  loadSubmissions(signal?: AbortSignal): Promise<readonly CalibrationSubmission[]>;
  reviewSubmission(input: CalibrationReviewInput, signal?: AbortSignal): Promise<CalibrationReviewResult>;
  shareHref(token: string): string | null;
}

export class GovernanceContractError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GovernanceContractError";
  }
}

export class GovernanceRequestError extends Error {
  public constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GovernanceRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contract(message: string): never {
  throw new GovernanceContractError(`校准治理接口契约无效：${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) contract(`${path} 必须是对象`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") contract(`${path} 必须是字符串`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = string(value, path).trim();
  if (!parsed) contract(`${path} 不能为空`);
  return parsed;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) contract(`${path} 必须是有限数值`);
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const parsed = number(value, path);
  if (!Number.isInteger(parsed) || parsed < minimum) contract(`${path} 必须是不小于 ${minimum} 的整数`);
  return parsed;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) contract(`${path} 必须是数组`);
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) contract(`${path} 必须是 ${String(expected)}`);
  return expected;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) contract(`${path} 取值无效`);
  return value as T[number];
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return string(value, path);
}

function parseScope(value: unknown, path: string): CalibrationModel["scope"] {
  const source = record(value, path);
  const material = optionalString(source.material, `${path}.material`);
  return {
    machineId: nonEmptyString(source.machineId, `${path}.machineId`),
    firmware: nonEmptyString(source.firmware, `${path}.firmware`),
    ...(material === undefined ? {} : { material: nonEmptyString(material, `${path}.material`) }),
  };
}

function parseModel(value: unknown, path: string): CalibrationModel {
  const source = record(value, path);
  const coefficients = record(source.coefficients, `${path}.coefficients`);
  const validation = record(source.validation, `${path}.validation`);
  const thresholds = record(source.thresholds, `${path}.thresholds`);
  const trainingSetSha256 = string(source.trainingSetSha256, `${path}.trainingSetSha256`);
  if (!SHA256.test(trainingSetSha256)) contract(`${path}.trainingSetSha256 必须是 SHA-256`);

  return {
    id: nonEmptyString(source.id, `${path}.id`),
    status: enumValue(
      source.status,
      ["candidate", "active", "retired", "demonstration-only"] as const,
      `${path}.status`
    ),
    scope: parseScope(source.scope, `${path}.scope`),
    algorithm: literal(source.algorithm, "theil-sen", `${path}.algorithm`),
    trainedAt: nonEmptyString(source.trainedAt, `${path}.trainedAt`),
    coefficients: {
      motionScale: number(coefficients.motionScale, `${path}.coefficients.motionScale`),
      fixedOverheadSec: number(coefficients.fixedOverheadSec, `${path}.coefficients.fixedOverheadSec`),
      sampleCount: integer(coefficients.sampleCount, `${path}.coefficients.sampleCount`, 3),
    },
    validation: {
      holdoutSamples: integer(validation.holdoutSamples, `${path}.validation.holdoutSamples`),
      mape: number(validation.mape, `${path}.validation.mape`),
      maxApe: number(validation.maxApe, `${path}.validation.maxApe`),
      medianBias: number(validation.medianBias, `${path}.validation.medianBias`),
      evaluatedAt: nonEmptyString(validation.evaluatedAt, `${path}.validation.evaluatedAt`),
    },
    thresholds: {
      maxMape: number(thresholds.maxMape, `${path}.thresholds.maxMape`),
      maxBias: number(thresholds.maxBias, `${path}.thresholds.maxBias`),
      minDriftSamples: integer(thresholds.minDriftSamples, `${path}.thresholds.minDriftSamples`, 3),
    },
    trainingSetSha256,
  };
}

function parseBundle(value: unknown, path: string): CalibrationBundle {
  const source = record(value, path);
  const id = string(source.id, `${path}.id`);
  if (!CALIBRATION_ID.test(id)) contract(`${path}.id 格式无效`);
  const provenance = enumValue(
    source.provenance,
    ["real-anonymized", "real-consented", "synthetic-conformance"] as const,
    `${path}.provenance`
  );
  const bundleSource = record(source.source, `${path}.source`);
  const models = array(source.models, `${path}.models`).map((model, index) =>
    parseModel(model, `${path}.models[${index}]`)
  );
  if (!models.length) contract(`${path}.models 不能为空`);
  return {
    format: literal(source.format, "forgex-calibration-bundle", `${path}.format`),
    version: literal(source.version, 1, `${path}.version`),
    id,
    revision: integer(source.revision, `${path}.revision`, 1),
    createdAt: nonEmptyString(source.createdAt, `${path}.createdAt`),
    provenance,
    source: {
      license: nonEmptyString(bundleSource.license, `${path}.source.license`),
      note: nonEmptyString(bundleSource.note, `${path}.source.note`),
    },
    models,
  };
}

function parsePublished(value: unknown, path: string): PublishedCalibration {
  const source = record(value, path);
  const digest = string(source.digest, `${path}.digest`);
  if (!SHA256.test(digest)) contract(`${path}.digest 必须是 SHA-256`);
  const bundle = parseBundle(source.bundle, `${path}.bundle`);
  const id = string(source.id, `${path}.id`);
  const revision = integer(source.revision, `${path}.revision`, 1);
  if (id !== bundle.id || revision !== bundle.revision) contract(`${path} 与 bundle 标识不一致`);
  return {
    id,
    revision,
    digest,
    bundle,
    approvedAt: integer(source.approvedAt, `${path}.approvedAt`),
    approvedBy: nonEmptyString(source.approvedBy, `${path}.approvedBy`),
  };
}

export function parseCalibrationCatalog(value: unknown): CalibrationCatalog {
  const source = record(value, "catalog");
  return {
    format: literal(source.format, "forgex-calibration-catalog", "catalog.format"),
    version: literal(source.version, 1, "catalog.version"),
    items: array(source.items, "catalog.items").map((item, index) => parsePublished(item, `catalog.items[${index}]`)),
  };
}

function parseEvent(value: unknown, path: string): CalibrationAuditEvent {
  const source = record(value, path);
  return {
    action: enumValue(source.action, ["submitted", "approved", "rejected"] as const, `${path}.action`),
    at: integer(source.at, `${path}.at`),
    actor: nonEmptyString(source.actor, `${path}.actor`),
    reason: string(source.reason, `${path}.reason`),
  };
}

function parseSubmission(value: unknown, path: string): CalibrationSubmission {
  const source = record(value, path);
  const id = nonEmptyString(source.id, `${path}.id`);
  const revision = integer(source.revision, `${path}.revision`, 1);
  const bundle = parseBundle(source.bundle, `${path}.bundle`);
  if (id !== bundle.id || revision !== bundle.revision) contract(`${path} 与 bundle 标识不一致`);
  const digest = string(source.digest, `${path}.digest`);
  if (!SHA256.test(digest)) contract(`${path}.digest 必须是 SHA-256`);
  const reviewedBy = optionalString(source.reviewedBy, `${path}.reviewedBy`);
  const reviewReason = optionalString(source.reviewReason, `${path}.reviewReason`);
  return {
    key: nonEmptyString(source.key, `${path}.key`),
    id,
    revision,
    status: enumValue(source.status, ["pending", "approved", "rejected"] as const, `${path}.status`),
    digest,
    bundle,
    createdAt: integer(source.createdAt, `${path}.createdAt`),
    updatedAt: integer(source.updatedAt, `${path}.updatedAt`),
    submittedBy: nonEmptyString(source.submittedBy, `${path}.submittedBy`),
    note: string(source.note, `${path}.note`),
    events: array(source.events, `${path}.events`).map((event, index) => parseEvent(event, `${path}.events[${index}]`)),
    ...(reviewedBy === undefined ? {} : { reviewedBy }),
    ...(reviewReason === undefined ? {} : { reviewReason }),
  };
}

export function parseCalibrationSubmissions(value: unknown): readonly CalibrationSubmission[] {
  const source = record(value, "submissions");
  return array(source.submissions, "submissions.submissions").map((item, index) =>
    parseSubmission(item, `submissions.submissions[${index}]`)
  );
}

export function parseCalibrationReviewResult(
  value: unknown,
  expected: Pick<CalibrationReviewInput, "id" | "revision" | "decision">
): CalibrationReviewResult {
  const source = record(value, "review");
  const parsed: CalibrationReviewResult = {
    id: nonEmptyString(source.id, "review.id"),
    revision: integer(source.revision, "review.revision", 1),
    status: enumValue(source.status, ["approved", "rejected"] as const, "review.status"),
    reviewedBy: nonEmptyString(source.reviewedBy, "review.reviewedBy"),
    reviewReason: nonEmptyString(source.reviewReason, "review.reviewReason"),
  };
  const expectedStatus = expected.decision === "approve" ? "approved" : "rejected";
  if (parsed.id !== expected.id || parsed.revision !== expected.revision || parsed.status !== expectedStatus) {
    contract("review 响应与请求标识或决定不一致");
  }
  return parsed;
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (isRecord(body)) {
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail.trim();
  }
  return `请求失败（HTTP ${response.status}）`;
}

function accessMessage(status: number, message: string): string {
  if (status === 401) return `审核凭据未通过服务端验证：${message}`;
  if (status === 403) return `当前身份没有执行此治理动作的权限：${message}`;
  if (status === 409) return `治理状态冲突：${message}`;
  if (status === 503) return `服务端尚未启用校准审核：${message}`;
  return message;
}

async function requestJson(base: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("校准治理请求超时"));
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(base + path, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      const message = await errorMessage(response);
      throw new GovernanceRequestError(response.status, accessMessage(response.status, message));
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new GovernanceContractError("校准治理接口没有返回有效 JSON", { cause: error });
    }
  } catch (error) {
    if (timedOut) throw new GovernanceRequestError(408, "校准治理请求超时");
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function normalizedShareToken(token: string): string | null {
  const normalized = token.trim().toLowerCase();
  return SHARE_TOKEN.test(normalized) ? normalized : null;
}

export function createGovernanceClient(runtimeMode: RuntimeMode): GovernanceClient {
  if (runtimeMode.kind === "offline") {
    return {
      mode: "offline",
      canReview: false,
      async loadCatalog() {
        return { format: "forgex-calibration-catalog", version: 1, items: [] };
      },
      async loadSubmissions() {
        return [];
      },
      async reviewSubmission() {
        throw new GovernanceRequestError(0, "离线模式只展示治理边界，不执行服务端审核。");
      },
      shareHref() {
        return null;
      },
    };
  }

  const base = runtimeMode.apiBase.replace(/\/+$/, "");
  return {
    mode: "remote-public",
    canReview: false,
    async loadCatalog(signal) {
      return parseCalibrationCatalog(
        await requestJson(base, "/api/calibrations", { headers: { Accept: "application/json" } }, signal)
      );
    },
    async loadSubmissions() {
      throw new GovernanceRequestError(403, "浏览器治理页固定为只读；审核队列仅向受信后台的专用审核身份开放。");
    },
    async reviewSubmission() {
      throw new GovernanceRequestError(403, "浏览器治理页固定为只读；发布审核必须在受信后台完成。");
    },
    shareHref(token) {
      const normalized = normalizedShareToken(token);
      return normalized ? `${base}/share/${normalized}` : null;
    },
  };
}
