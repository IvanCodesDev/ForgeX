// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsPage } from "./AnalyticsPage";

afterEach(cleanup);

describe("AnalyticsPage", () => {
  it("shows an auditable local-rules report and preserves the dataset source warning", () => {
    render(<AnalyticsPage />);

    expect(screen.getByText("本地规则引擎（非 AI）")).toBeInTheDocument();
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
});
