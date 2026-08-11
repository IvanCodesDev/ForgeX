// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuthorityToolpathLayerView, GcodeBounds, PreviewLayer } from "./gcode-types";
import { GcodeViewer } from "./GcodeViewer";

const viewerSpies = vi.hoisted(() => ({
  construct: vi.fn(),
  setLayer: vi.fn(),
  setAuthorityLayer: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../../engine/ViewerEngine", () => ({
  ViewerEngine: class {
    public constructor(canvas: HTMLCanvasElement) {
      viewerSpies.construct(canvas);
    }

    public setLayer(layer: PreviewLayer | null, bounds: GcodeBounds | null): void {
      viewerSpies.setLayer(layer, bounds);
    }

    public setAuthorityLayer(layer: AuthorityToolpathLayerView | null, bounds: GcodeBounds | null): void {
      viewerSpies.setAuthorityLayer(layer, bounds);
    }

    public dispose(): void {
      viewerSpies.dispose();
    }
  },
}));

describe("GcodeViewer lifecycle", () => {
  it("owns one engine, updates the layer and disposes it on unmount", () => {
    const bounds = { minX: 0, maxX: 20, minY: 0, maxY: 20 };
    const layer: PreviewLayer = {
      index: 0,
      z: 0.2,
      sourcePathCount: 1,
      sourcePointCount: 2,
      paths: [
        {
          type: "perimeter",
          points: [
            [0, 0],
            [20, 20],
          ],
        },
      ],
    };
    const view = render(<GcodeViewer layer={null} bounds={null} />);

    expect(viewerSpies.construct).toHaveBeenCalledOnce();
    expect(viewerSpies.setLayer).toHaveBeenLastCalledWith(null, null);
    view.rerender(<GcodeViewer layer={layer} bounds={bounds} />);
    expect(viewerSpies.setLayer).toHaveBeenLastCalledWith(layer, bounds);

    view.unmount();
    expect(viewerSpies.dispose).toHaveBeenCalledOnce();
  });

  it("routes a decoded C# layer directly to the packed Three.js buffer path", () => {
    const bounds = { minX: 0, maxX: 20, minY: 0, maxY: 20 };
    const authorityLayer: AuthorityToolpathLayerView = {
      index: 0,
      z: 0.2,
      sourcePathCount: 1,
      sourceSegmentCount: 1,
      segmentCount: 1,
      coordinates: new Float32Array([0, 0, 20, 20]),
      pathTypeIndexes: new Uint8Array([0]),
      pathTypes: ["perimeter"],
    };

    const view = render(<GcodeViewer layer={null} authorityLayer={authorityLayer} bounds={bounds} />);
    expect(viewerSpies.setAuthorityLayer).toHaveBeenLastCalledWith(authorityLayer, bounds);
    view.unmount();
  });
});
