// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuiltInAnalyticsDatasets, runAnalyticsQuestion } from "./analytics-model";
import {
  buildAnalyticsAuthorityRequest,
  compareAnalyticsReports,
  requestAnalyticsAuthority,
  useAnalyticsAuthority,
} from "./analytics-authority";

const env: ImportMetaEnv = {
  BASE_URL: "/",
  MODE: "test",
  DEV: false,
  PROD: false,
  SSR: false,
  VITE_NODE_API_KEY: "node-browser-key",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analytics authority boundary", () => {
  const dataset = listBuiltInAnalyticsDatasets()[0]!;
  const question = "哪台机故障率最高，主要故障是什么？";
  const browserReport = runAnalyticsQuestion(question, dataset);

  it("builds a versioned request from normalized rows and provenance", () => {
    const request = buildAnalyticsAuthorityRequest(question, dataset);
    expect(request.schemaVersion).toBe("1.0");
    expect(request.rows).toHaveLength(dataset.rows.length);
    expect(request.provenance?.rowCount).toBe(dataset.rows.length);
    expect(request.rows[0]).not.toHaveProperty("unexpected");
  });

  it("compares all browser fields while tolerating extra authority fields", () => {
    const exact = compareAnalyticsReports(browserReport, { ...browserReport, authorityOnly: true });
    expect(exact.differences).toEqual([]);
    expect(exact.comparedFields).toBeGreaterThan(20);

    const mismatch = compareAnalyticsReports(browserReport, { ...browserReport, verdict: "changed" });
    expect(mismatch.differences).toEqual([expect.objectContaining({ field: "$.verdict", actual: '"changed"' })]);
  });

  it("posts only to the generated Node route with Node credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
          report: browserReport,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const result = await requestAnalyticsAuthority(
      "https://node.example.test",
      question,
      dataset,
      new AbortController().signal,
      env
    );
    expect(result.engineVersion).toBe("1.3.0");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://node.example.test/api/v1/analytics/reports");
    expect(new Headers(init?.headers).get("X-API-Key")).toBe("node-browser-key");
    expect(init?.credentials).toBe("same-origin");
  });

  it("reports a matched shadow run without replacing the browser report", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
          report: browserReport,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { result } = renderHook(() => useAnalyticsAuthority("shadow", "", env));
    await act(async () => {
      await result.current.run(question, dataset, browserReport);
    });
    await waitFor(() => expect(result.current.state.status).toBe("matched"));
    expect(result.current.state).toEqual(
      expect.objectContaining({ status: "matched", engineVersion: "1.3.0", differences: [] })
    );
  });

  it("keeps offline shadow mode at zero requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useAnalyticsAuthority("shadow", null, env));
    await act(async () => {
      await result.current.run(question, dataset, browserReport);
    });
    expect(result.current.state.status).toBe("offline");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
