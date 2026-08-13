import { describe, expect, it, vi } from "vitest";
import type { AnalyticsAuthorityResponse, AnalyticsReport } from "../generated/forgex-api";
import type { InsightReport } from "../legacy/engine";
import {
  AnalyticsAuthorityUnsupportedError,
  ANALYTICS_AUTHORITY_MAX_ROWS,
  buildAnalyticsAuthorityRequest,
  compareAnalyticsReports,
  parseAnalyticsAuthorityResponse,
  requestAnalyticsAuthorityReport,
  resolveAnalyticsAuthorityMode,
  sanitizeAnalyticsRows,
  toInsightReport,
} from "./analytics-authority";

function env(authority?: string, apiBase?: string, auth: { apiKey?: string } = {}): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(authority ? { VITE_ANALYTICS_AUTHORITY: authority as "browser" | "shadow" | "dotnet" } : {}),
    ...(apiBase ? { VITE_API_BASE: apiBase } : {}),
    ...(auth.apiKey ? { VITE_NODE_API_KEY: auth.apiKey } : {}),
  };
}

const REPORT: AnalyticsReport = {
  schemaVersion: 1,
  title: "故障率分析",
  verdict: "BAD 的故障率显著高于 OK",
  confidence: "high",
  sections: [{ h: "结论", lines: ["BAD 故障率 40%", "OK 故障率 5%"] }],
  chart: {
    kind: "bar-rate",
    title: "各机台故障率",
    items: [
      { label: "BAD", value: 0.4, ciLo: 0.22, ciHi: 0.61, weak: false },
      { label: "OK", value: 0.05, ciLo: 0.01, ciHi: 0.24, weak: false },
    ],
  },
  evidence: [{ claim: "BAD 故障率 40%", method: "wilson", n: 20, statistic: 0.4, ci95: [0.22, 0.61], pValue: 0.004 }],
  intent: "fail-rate",
  intentMatched: true,
  rowCount: 2,
  engine: "local-rules",
  provenance: null,
  highlight: { type: "machine", id: "BAD" },
};

const AUTHORITY: AnalyticsAuthorityResponse = {
  schemaVersion: "1.0",
  engine: { name: "forgex-analytics-csharp", version: "1.4.0" },
  report: REPORT,
};

/** 与 REPORT 同构的本地规则引擎报告（双跑对照的另一条腿）。 */
function localReport(): InsightReport {
  return {
    title: REPORT.title,
    engine: "local-rules",
    rowCount: REPORT.rowCount,
    verdict: REPORT.verdict,
    confidence: REPORT.confidence,
    sections: REPORT.sections.map((section) => ({ h: section.h, lines: [...section.lines] })),
    chart: {
      kind: "bar-rate",
      title: "各机台故障率",
      items: REPORT.chart!.items.map((item) => ({ ...item })),
    },
    evidence: REPORT.evidence.map((item) => ({
      claim: item.claim,
      method: item.method,
      n: item.n,
      statistic: item.statistic!,
      ci95: [item.ci95![0]!, item.ci95![1]!],
      pValue: item.pValue!,
    })),
    highlight: { ...REPORT.highlight! },
    ...({ intent: REPORT.intent, intentMatched: REPORT.intentMatched } as Partial<InsightReport>),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("resolveAnalyticsAuthorityMode", () => {
  it("defaults to browser and honours explicit shadow/dotnet", () => {
    expect(resolveAnalyticsAuthorityMode(env())).toBe("browser");
    expect(resolveAnalyticsAuthorityMode(env("unexpected"))).toBe("browser");
    expect(resolveAnalyticsAuthorityMode(env("shadow"))).toBe("shadow");
    expect(resolveAnalyticsAuthorityMode(env("dotnet"))).toBe("dotnet");
  });

  it("forces browser mode when the runtime is offline", () => {
    expect(resolveAnalyticsAuthorityMode(env("dotnet"), { protocol: "file:" })).toBe("browser");
    expect(resolveAnalyticsAuthorityMode(env("dotnet", "offline"), { protocol: "https:" })).toBe("browser");
  });
});

describe("sanitizeAnalyticsRows", () => {
  it("keeps contract keys, null-fills invalid values and drops unknown keys", () => {
    const rows = sanitizeAnalyticsRows([
      {
        machine_id: "BAD",
        status: "fail",
        fail_reason: "堵料",
        duration_min: 100,
        layer_height_mm: "not-a-number",
        internal_only: "drop-me",
      },
    ]);
    expect(rows).toEqual([
      {
        status: "fail",
        job_id: null,
        date: null,
        machine_id: "BAD",
        model_name: null,
        material: null,
        fail_reason: "堵料",
        layer_height_mm: null,
        duration_min: 100,
        filament_g: null,
        cost_fen: null,
        energy_kwh: null,
      },
    ]);
  });

  it("rejects rows outside the authority contract as unsupported", () => {
    expect(() => sanitizeAnalyticsRows([])).toThrow(AnalyticsAuthorityUnsupportedError);
    expect(() => sanitizeAnalyticsRows([{ status: "unknown" }])).toThrow(AnalyticsAuthorityUnsupportedError);
    expect(() => sanitizeAnalyticsRows(["not-an-object"])).toThrow(AnalyticsAuthorityUnsupportedError);
    const oversized = Array.from({ length: ANALYTICS_AUTHORITY_MAX_ROWS + 1 }, () => ({ status: "success" }));
    expect(() => sanitizeAnalyticsRows(oversized)).toThrow(AnalyticsAuthorityUnsupportedError);
  });
});

describe("buildAnalyticsAuthorityRequest", () => {
  it("trims the question and never echoes browser provenance", () => {
    const request = buildAnalyticsAuthorityRequest("  哪台机故障率最高  ", [{ status: "success" }]);
    expect(request.schemaVersion).toBe("1.0");
    expect(request.question).toBe("哪台机故障率最高");
    expect(request.provenance).toBeNull();
    expect(request.rows).toHaveLength(1);
  });

  it("rejects blank or oversized questions as unsupported", () => {
    expect(() => buildAnalyticsAuthorityRequest("   ", [{ status: "success" }])).toThrow(
      AnalyticsAuthorityUnsupportedError
    );
    expect(() => buildAnalyticsAuthorityRequest("长".repeat(501), [{ status: "success" }])).toThrow(
      AnalyticsAuthorityUnsupportedError
    );
  });
});

describe("parseAnalyticsAuthorityResponse", () => {
  it("accepts a contract-complete response byte for byte", () => {
    expect(parseAnalyticsAuthorityResponse(clone(AUTHORITY))).toEqual(AUTHORITY);
  });

  it("rejects wrapper drift", () => {
    const wrongEngine = clone(AUTHORITY) as { engine: { name: string } };
    wrongEngine.engine.name = "someone-else";
    expect(() => parseAnalyticsAuthorityResponse(wrongEngine)).toThrow(/engine\.name/);

    const wrongSchema = clone(AUTHORITY) as { schemaVersion: string };
    wrongSchema.schemaVersion = "2.0";
    expect(() => parseAnalyticsAuthorityResponse(wrongSchema)).toThrow(/schemaVersion/);
  });

  it("rejects report drift field by field", () => {
    const wrongReportEngine = clone(AUTHORITY) as { report: { engine: string } };
    wrongReportEngine.report.engine = "ai";
    expect(() => parseAnalyticsAuthorityResponse(wrongReportEngine)).toThrow(/report\.engine/);

    const wrongChartKind = clone(AUTHORITY) as { report: { chart: { kind: string } } };
    wrongChartKind.report.chart.kind = "pie";
    expect(() => parseAnalyticsAuthorityResponse(wrongChartKind)).toThrow(/chart\.kind/);

    const wrongCi = clone(AUTHORITY) as unknown as { report: { evidence: Array<{ ci95: unknown }> } };
    wrongCi.report.evidence[0]!.ci95 = [0.22];
    expect(() => parseAnalyticsAuthorityResponse(wrongCi)).toThrow(/ci95/);

    const wrongLine = clone(AUTHORITY) as unknown as { report: { sections: Array<{ lines: unknown[] }> } };
    wrongLine.report.sections[0]!.lines = [42];
    expect(() => parseAnalyticsAuthorityResponse(wrongLine)).toThrow(/lines\[0\]/);

    const wrongRowCount = clone(AUTHORITY) as { report: { rowCount: unknown } };
    wrongRowCount.report.rowCount = -1;
    expect(() => parseAnalyticsAuthorityResponse(wrongRowCount)).toThrow(/rowCount/);
  });
});

describe("requestAnalyticsAuthorityReport", () => {
  const ROWS = [
    { machine_id: "BAD", status: "fail", fail_reason: "堵料", internal_only: "drop-me" },
    { machine_id: "OK", status: "success" },
  ];

  it("posts sanitized JSON to the Node proxy and validates the echo", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(AUTHORITY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestAnalyticsAuthorityReport(
      "哪台机故障率最高",
      ROWS,
      env("dotnet", "https://node.example.test/", { apiKey: "node-key" })
    );
    expect(response).toEqual(AUTHORITY);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://node.example.test/api/v1/analytics/reports",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request.headers).get("X-API-Key")).toBe("node-key");
    const body = JSON.parse(String(request.body)) as { rows: Array<Record<string, unknown>>; provenance: unknown };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).not.toHaveProperty("internal_only");
    expect(body.provenance).toBeNull();
  });

  it("maps problem+json failures to stable error codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "analytics_authority_disabled", detail: "已关闭" }), { status: 503 })
        )
    );
    await expect(requestAnalyticsAuthorityReport("问题", ROWS, env("dotnet"))).rejects.toThrow(
      "analytics_authority_disabled: 已关闭"
    );
  });

  it("rejects an authority that reports a different row count", async () => {
    const tampered = clone(AUTHORITY);
    (tampered.report as { rowCount: number }).rowCount = 3;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(tampered), { status: 200 })));
    await expect(requestAnalyticsAuthorityReport("问题", ROWS, env("dotnet"))).rejects.toThrow(/rowCount=3/);
  });
});

describe("compareAnalyticsReports", () => {
  it("passes when both legs agree within stage4 tolerances", () => {
    const diff = compareAnalyticsReports(localReport(), clone(REPORT));
    expect(diff).toEqual({ pass: true, mismatches: [] });
  });

  it("tolerates float noise below 1e-9 relative and flags anything above", () => {
    const noisy = clone(REPORT) as unknown as { evidence: Array<{ statistic: number }> };
    noisy.evidence[0]!.statistic = 0.4 + 4e-11;
    expect(compareAnalyticsReports(localReport(), noisy as unknown as AnalyticsReport).pass).toBe(true);

    const drifted = clone(REPORT) as unknown as { evidence: Array<{ statistic: number }> };
    drifted.evidence[0]!.statistic = 0.4000001;
    const diff = compareAnalyticsReports(localReport(), drifted as unknown as AnalyticsReport);
    expect(diff.pass).toBe(false);
    expect(diff.mismatches.some((entry) => entry.includes("evidence[0].statistic"))).toBe(true);
  });

  it("reports text, chart and highlight drift with field paths", () => {
    const changed = clone(REPORT) as unknown as {
      verdict: string;
      chart: { items: Array<{ value: number }> };
      highlight: unknown;
    };
    changed.verdict = "换了一个结论";
    changed.chart.items[0]!.value = 0.5;
    changed.highlight = null;
    const diff = compareAnalyticsReports(localReport(), changed as unknown as AnalyticsReport);
    expect(diff.pass).toBe(false);
    expect(diff.mismatches.some((entry) => entry.startsWith("verdict"))).toBe(true);
    expect(diff.mismatches.some((entry) => entry.startsWith("chart.items[0].value"))).toBe(true);
    expect(diff.mismatches.some((entry) => entry.startsWith("highlight"))).toBe(true);
  });
});

describe("toInsightReport", () => {
  it("marks the authority origin and backfills browser provenance", () => {
    const provenance = { synthetic: true, badge: "演示", note: "内置机群", source: "sim-farm" };
    const mapped = toInsightReport(clone(AUTHORITY), { provenance, elapsedMs: 128 });
    expect(mapped.engine).toBe("dotnet-authority");
    expect(mapped.elapsedMs).toBe(128);
    expect(mapped.provenance).toEqual(provenance);
    expect(mapped.title).toBe(REPORT.title);
    expect(mapped.chart?.items).toHaveLength(2);
    expect(mapped.evidence?.[0]).toMatchObject({ claim: REPORT.evidence[0]!.claim, ci95: [0.22, 0.61] });
    expect(mapped.highlight).toEqual({ type: "machine", id: "BAD" });
    expect(mapped).toMatchObject({ intent: "fail-rate", intentMatched: true, authorityEngineVersion: "1.4.0" });
  });

  it("converts null chart and highlight into absent optionals", () => {
    const bare = clone(AUTHORITY);
    (bare.report as { chart: null }).chart = null;
    (bare.report as { highlight: null }).highlight = null;
    const mapped = toInsightReport(bare, { elapsedMs: 5 });
    expect(mapped.chart).toBeUndefined();
    expect(mapped.highlight).toBeUndefined();
    expect(mapped.provenance).toBeUndefined();
  });
});
