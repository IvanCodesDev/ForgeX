import { useEffect, useRef } from "react";
import { ViewerEngine } from "../../engine/ViewerEngine";
import type { AuthorityToolpathLayerView, GcodeBounds, PreviewLayer } from "./gcode-types";

interface GcodeViewerProps {
  readonly layer: PreviewLayer | null;
  readonly authorityLayer?: AuthorityToolpathLayerView | null;
  readonly bounds: GcodeBounds | null;
}

export function GcodeViewer({ layer, authorityLayer = null, bounds }: GcodeViewerProps) {
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

  useEffect(() => {
    if (authorityLayer) engineRef.current?.setAuthorityLayer(authorityLayer, bounds);
    else engineRef.current?.setLayer(layer, bounds);
  }, [authorityLayer, layer, bounds]);

  return (
    <div className="gcode-viewer">
      <canvas ref={canvasRef} aria-label="当前 G-code 层的三维路径预览" />
      {!layer && !authorityLayer ? <p>导入 G-code 后显示逐层路径</p> : null}
    </div>
  );
}
