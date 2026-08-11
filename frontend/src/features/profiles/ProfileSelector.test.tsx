// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileSelector } from "./ProfileSelector";
import { useProfileSelection } from "./useProfileSelection";

function Harness() {
  const controller = useProfileSelection();
  return (
    <>
      <ProfileSelector value={controller.value} actions={controller.actions} />
      <output data-testid="options">{JSON.stringify(controller.value.options)}</output>
      <output data-testid="dirty">{String(controller.value.dirty)}</output>
    </>
  );
}

describe("ProfileSelector", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("is controlled by the hook and exposes valid resolved options", () => {
    render(<Harness />);
    expect(screen.getByLabelText("机器 Profile")).toHaveValue("corexy");
    expect(screen.getByLabelText("材料 Profile")).toHaveValue("PLA");
    expect(screen.getByTestId("options")).toHaveTextContent(
      JSON.stringify({ bedSize: 256, densityG: 1.24, origin: "corner" })
    );
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");

    fireEvent.change(screen.getByLabelText("机器 Profile"), { target: { value: "delta" } });
    fireEvent.change(screen.getByLabelText("材料 Profile"), { target: { value: "PETG" } });
    expect(screen.getByTestId("options")).toHaveTextContent(
      JSON.stringify({ bedSize: 260, densityG: 1.27, origin: "center" })
    );
  });

  it("reports validation errors, dirty state and restores Profile-derived values", () => {
    render(<Harness />);
    const density = screen.getByLabelText("材料密度（g/cm³）");
    fireEvent.change(density, { target: { value: "8" } });
    expect(density).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/材料密度必须在 0.2–5/)).toBeInTheDocument();
    expect(screen.getByTestId("options")).toHaveTextContent("null");
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "恢复 Profile 参数" }));
    expect(screen.getByTestId("options")).toHaveTextContent(
      JSON.stringify({ bedSize: 256, densityG: 1.24, origin: "corner" })
    );
    expect(screen.getByTestId("dirty")).toHaveTextContent("false");
  });

  it("rejects an oversized local import without replacing the catalog", async () => {
    render(<Harness />);
    const file = new File([], "large-profile.json", { type: "application/json" });
    Object.defineProperty(file, "size", { value: 2 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText(/导入社区 Profile JSON/), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("FILE_TOO_LARGE");
    expect(screen.getByLabelText("机器 Profile")).toHaveValue("corexy");
  });
});
