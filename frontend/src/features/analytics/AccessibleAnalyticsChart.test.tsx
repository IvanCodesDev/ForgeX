// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { AccessibleAnalyticsChart } from "./AccessibleAnalyticsChart";

afterEach(cleanup);

describe("AccessibleAnalyticsChart", () => {
  it("renders an SVG description and an equivalent data table", () => {
    render(
      <AccessibleAnalyticsChart
        chart={{
          kind: "bar-rate",
          title: "材料失败率",
          items: [
            { label: "ABS", value: 0.4, hint: "8/20 · 95%CI 20%–60%" },
            { label: "PLA", value: 0.05, weak: true },
          ],
        }}
      />
    );

    expect(screen.getByRole("img", { name: /材料失败率/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "材料失败率数据表" });
    expect(within(table).getByRole("rowheader", { name: "ABS" })).toBeInTheDocument();
    expect(within(table).getByText("40%")).toBeInTheDocument();
    expect(within(table).getByText("样本量不足，仅作线索")).toBeInTheDocument();
  });
});
