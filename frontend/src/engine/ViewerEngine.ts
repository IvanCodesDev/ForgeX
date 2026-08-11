import {
  AxesHelper,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GridHelper,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type ColorRepresentation,
  type Material,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AuthorityToolpathLayerView, GcodeBounds, PreviewLayer } from "../features/gcode/gcode-types";

const COLORS: Readonly<Record<string, ColorRepresentation>> = {
  perimeter: 0xe7ebf1,
  solid: 0xff642e,
  infill: 0x768195,
  support: 0x66a3ff,
  skirt: 0x535d6d,
};

export class ViewerEngine {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private layerObject: LineSegments | null = null;
  private disposed = false;

  public constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.camera.position.set(180, 160, 180);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", this.render);

    const grid = new GridHelper(280, 14, 0x3e4858, 0x242b36);
    grid.position.y = -0.03;
    this.scene.add(grid);
    this.scene.add(new AxesHelper(28));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  public setLayer(layer: PreviewLayer | null, bounds: GcodeBounds | null): void {
    this.disposeLayer();
    if (!layer || !bounds) {
      this.render();
      return;
    }

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const positions: number[] = [];
    const colors: number[] = [];
    for (const path of layer.paths) {
      const color = new Color(COLORS[path.type] ?? 0xaab3c1);
      for (let index = 1; index < path.points.length; index++) {
        const before = path.points[index - 1];
        const current = path.points[index];
        if (!before || !current) continue;
        // Preserve the legacy viewer convention: machine (x, y, z) -> Three (x, z, -y).
        positions.push(before[0] - centerX, layer.z, -(before[1] - centerY));
        positions.push(current[0] - centerX, layer.z, -(current[1] - centerY));
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.94 });
    this.layerObject = new LineSegments(geometry, material);
    this.scene.add(this.layerObject);

    this.frameLayer(bounds, layer.z);
  }

  public setAuthorityLayer(layer: AuthorityToolpathLayerView | null, bounds: GcodeBounds | null): void {
    this.disposeLayer();
    if (!layer || !bounds) {
      this.render();
      return;
    }

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const positions = new Float32Array(layer.segmentCount * 6);
    const colors = new Float32Array(layer.segmentCount * 6);
    for (let index = 0; index < layer.segmentCount; index += 1) {
      const coordinateOffset = index * 4;
      const vertexOffset = index * 6;
      positions[vertexOffset] = (layer.coordinates[coordinateOffset] ?? 0) - centerX;
      positions[vertexOffset + 1] = layer.z;
      positions[vertexOffset + 2] = -((layer.coordinates[coordinateOffset + 1] ?? 0) - centerY);
      positions[vertexOffset + 3] = (layer.coordinates[coordinateOffset + 2] ?? 0) - centerX;
      positions[vertexOffset + 4] = layer.z;
      positions[vertexOffset + 5] = -((layer.coordinates[coordinateOffset + 3] ?? 0) - centerY);

      const pathType = layer.pathTypes[layer.pathTypeIndexes[index] ?? -1] ?? "unknown";
      const color = new Color(COLORS[pathType] ?? 0xaab3c1);
      colors.set([color.r, color.g, color.b, color.r, color.g, color.b], vertexOffset);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.94 });
    this.layerObject = new LineSegments(geometry, material);
    this.scene.add(this.layerObject);

    this.frameLayer(bounds, layer.z);
  }

  private frameLayer(bounds: GcodeBounds, z: number): void {
    const span = Math.max(40, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    this.camera.near = Math.max(0.1, span / 1000);
    this.camera.far = span * 20;
    this.camera.position.set(span * 0.72, span * 0.88, span * 0.72);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, Math.max(0, z * 0.35), 0);
    this.controls.update();
    this.render();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.removeEventListener("change", this.render);
    this.controls.dispose();
    this.disposeLayer();
    this.scene.traverse((object) => {
      if (object instanceof Line || object instanceof Mesh) {
        object.geometry.dispose();
        this.disposeMaterial(object.material);
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private readonly render = (): void => {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth ?? this.canvas.clientWidth);
    const height = Math.max(1, parent?.clientHeight ?? this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private disposeLayer(): void {
    if (!this.layerObject) return;
    this.scene.remove(this.layerObject);
    this.layerObject.geometry.dispose();
    this.disposeMaterial(this.layerObject.material);
    this.layerObject = null;
  }

  private disposeMaterial(material: Material | readonly Material[]): void {
    const materials = Array.isArray(material) ? material : [material];
    for (const item of materials) item.dispose();
  }
}
