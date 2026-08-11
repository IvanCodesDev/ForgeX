// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_QUESTIONS, listBuiltInAnalyticsDatasets, runAnalyticsQuestion } from "./analytics-model";
import { AnalyticsPage } from "./AnalyticsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnalyticsPage", () => {
  it("shows an auditable local-rules report and preserves the dataset source warning", () => {
    render(<AnalyticsPage />);

    expect(screen.getByText("浏览器 JS 规则引擎（非 AI）")).toBeInTheDocument();
    expect(screen.getByLabelText("数据来源声明")).toHaveTextContent("物理机群仿真");
    expect(screen.getByLabelText("数据来源声明")).toHaveTextContent("非真实产线数据");
    expect(screen.getByLabelText("数据集关键指标")).toHaveTextContent("400");
    expect(screen.getByRole("button", { name: "导出 JSON" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeEnabled();
  });

  it("switches to the explicitly labelled synthetic fixture and validates blank questions", () => {
    render(<AnalyticsPage />);

    fireEvent.change(screen.getByLabelText("当前数据集"), { target: { value: "synthetic-demo-v1" } });
    expect(screen.getByLabelText("数据来源声明")).toHaveTextContent("概率合成演示");
    expect(screen.getByLabelText("数据来源声明")).toHaveTextContent("预先写入");

    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "运行规则分析" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入要分析的问题");
  });

  it("keeps the browser report visible while shadow comparison succeeds", async () => {
    const dataset = listBuiltInAnalyticsDatasets()[0]!;
    const report = runAnalyticsQuestion(ANALYTICS_QUESTIONS[0], dataset);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
          report,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    render(<AnalyticsPage authorityMode="shadow" apiBase="" />);

    expect(await screen.findByText(/字段级比对一致/)).toBeInTheDocument();
    expect(screen.getByText("浏览器 JS 规则引擎（非 AI）")).toBeInTheDocument();
    expect(screen.getByText(/引擎版本：1.3.0/)).toBeInTheDocument();
  });

  it("switches the displayed report source to C# only after an exact dotnet match", async () => {
    const dataset = listBuiltInAnalyticsDatasets()[0]!;
    const report = runAnalyticsQuestion(ANALYTICS_QUESTIONS[0], dataset);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
          report,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    render(<AnalyticsPage authorityMode="dotnet" apiBase="" />);

    expect(await screen.findByText(/C# 权威报告已启用/)).toBeInTheDocument();
    expect(screen.getByText("C# 权威规则引擎 v1.3.0")).toBeInTheDocument();
    expect(screen.queryByText("浏览器 JS 规则引擎（非 AI）")).not.toBeInTheDocument();
  });

  it("keeps the browser report when dotnet returns a field mismatch", async () => {
    const dataset = listBuiltInAnalyticsDatasets()[0]!;
    const report = runAnalyticsQuestion(ANALYTICS_QUESTIONS[0], dataset);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          engine: { name: "forgex-analytics-csharp", version: "1.3.0" },
          report: { ...report, verdict: "drifted" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    render(<AnalyticsPage authorityMode="dotnet" apiBase="" />);

    expect(await screen.findByText(/页面保留浏览器 JS 回退结果/)).toBeInTheDocument();
    expect(screen.getByText("浏览器 JS 规则引擎（非 AI）")).toBeInTheDocument();
    expect(screen.getByText(report.verdict)).toBeInTheDocument();
    expect(screen.queryByText("drifted")).not.toBeInTheDocument();
  });
});
