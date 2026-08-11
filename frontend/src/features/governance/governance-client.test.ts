import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMode } from "../../app/runtime/runtime-mode";
import {
  createGovernanceClient,
  GovernanceContractError,
  parseCalibrationCatalog,
  parseCalibrationReviewResult,
  parseCalibrationSubmissions,
} from "./governance-client";
import { calibrationCatalog, calibrationSubmission } from "./governance-test-fixtures";

const REMOTE: RuntimeMode = { kind: "remote", apiBase: "https://api.example.test", reason: "configured-api" };
const OFFLINE: RuntimeMode = { kind: "offline", apiBase: null, reason: "file-protocol" };

afterEach(() => vi.unstubAllGlobals());

describe("governance client", () => {
  it("keeps offline governance and share lookup at zero network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createGovernanceClient(OFFLINE);

    await expect(client.loadCatalog()).resolves.toEqual({
      format: "forgex-calibration-catalog",
      version: 1,
      items: [],
    });
    await expect(client.loadSubmissions()).resolves.toEqual([]);
    await expect(
      client.reviewSubmission({ id: "factory-line-a", revision: 2, decision: "approve", reason: "reviewed evidence" })
    ).rejects.toMatchObject({ status: 0 });
    expect(client.shareHref("0123456789abcdef01")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses the public active catalog without requesting the restricted queue", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(Response.json(calibrationCatalog()))
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGovernanceClient(REMOTE);

    await expect(client.loadCatalog()).resolves.toMatchObject({
      format: "forgex-calibration-catalog",
      items: [
        {
          id: "factory-line-a",
          bundle: { models: [{ status: "active", validation: { holdoutSamples: 6, mape: 0.1 } }] },
        },
      ],
    });
    await expect(client.loadSubmissions()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/api/calibrations");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(client.shareHref(" 0123456789ABCDEF01 ")).toBe("https://api.example.test/share/0123456789abcdef01");
    expect(client.shareHref("../share/anything")).toBeNull();
  });

  it("keeps browser governance read-only and never calls restricted review endpoints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createGovernanceClient(REMOTE);

    expect(client.mode).toBe("remote-public");
    expect(client.canReview).toBe(false);
    await expect(client.loadSubmissions()).rejects.toMatchObject({ status: 403 });
    await expect(
      client.reviewSubmission({
        id: "factory-line-a",
        revision: 2,
        decision: "approve",
        reason: "Independent validation evidence was reviewed.",
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed evidence and identifiers instead of trusting server JSON", () => {
    const malformed = calibrationCatalog() as unknown as {
      items: Array<{ digest: string; bundle: { models: Array<{ validation: { mape: unknown } }> } }>;
    };
    malformed.items[0]!.bundle.models[0]!.validation.mape = "0.1";
    expect(() => parseCalibrationCatalog(malformed)).toThrowError(GovernanceContractError);
    expect(() =>
      parseCalibrationCatalog({ ...calibrationCatalog(), items: [{ ...calibrationCatalog().items[0], id: "other" }] })
    ).toThrow("与 bundle 标识不一致");
  });

  it("rejects submission and review responses whose identifiers drift from the signed bundle or request", () => {
    const submission = calibrationSubmission() as unknown as {
      id: string;
      bundle: { id: string };
    };
    submission.id = "other-line";
    expect(() => parseCalibrationSubmissions({ submissions: [submission] })).toThrow("与 bundle 标识不一致");

    expect(() =>
      parseCalibrationReviewResult(
        {
          id: "factory-line-a",
          revision: 3,
          status: "approved",
          reviewedBy: "key-reviewer-2",
          reviewReason: "Independent validation evidence was reviewed.",
        },
        { id: "factory-line-a", revision: 2, decision: "approve" }
      )
    ).toThrow("与请求标识或决定不一致");
  });

  it("forwards caller cancellation to the in-flight request", async () => {
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request-aborted")), { once: true });
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = createGovernanceClient(REMOTE).loadCatalog(controller.signal);

    controller.abort();

    await expect(request).rejects.toThrow("request-aborted");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
