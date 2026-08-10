import { useEffect, useRef } from "react";
import { ViewerEngine } from "../../engine/ViewerEngine";
import type { GcodeBounds, PreviewLayer } from "./gcode-types";

interface GcodeViewerProps {
  readonly layer: PreviewLayer | null;
  readonly bounds: GcodeBounds | null;
}

export function GcodeViewer({ layer, bounds }: GcodeViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<ViewerEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ViewerEngine(canvas);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => engineRef.current?.setLayer(layer, bounds), [layer, bounds]);

  return (
    <div className="gcode-viewer">
      <canvas ref={canvasRef} aria-label="当前 G-code 层的三维路径预览" />
      {!layer ? <p>导入 G-code 后显示逐层路径</p> : null}
    </div>
  );
}
