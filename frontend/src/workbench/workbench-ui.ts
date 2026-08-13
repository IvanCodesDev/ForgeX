/* 宿主 UI 适配层：js/ui.js（FXUI）在 React 入口的接替者。
   旧 FXUI 的全部 UI 区域（cockpit / telemetry / nav / uploads / params / overlays /
   四个流程页 / 洞察面板）已由 React 组件承担；本类只保留 FXUI 在「全区接管」
   模式下仍然存活的引擎联动职责，行为与旧实现逐项对齐：

   - toast / confirmAction：转发为 bus 事件，汇入宿主浮层队列（useOverlays 消费）；
   - renderCtx：currentNav 同步 + `ctx-page-refresh` 刷新事件（已迁页面订阅后回读引擎重渲；
     未挂载的页面没有订阅者，事件自然惰性，等价于旧实现的「面板隐藏时跳过重渲」）；
   - state 事件：待机 ghost 显隐联动 + 模型页随状态机刷新（旧 _onState 的存活分支）；
   - sliced 事件：切片页刷新转发（旧 _bindBus 的存活分支）；
   - exportModel / builtins：纯引擎逻辑（导出与内置模型目录），不碰面板 DOM。 */
import * as exporter from "../engine/exporter";
import type { GcodeExportSettings, GeometryLike } from "../engine/exporter";
import * as models from "../engine/models";
import type { BuiltModel } from "../engine/models";
import type { SliceResultOut } from "../engine/slicer";
import type { BuiltinModel, LegacyEventBus, LegacySim, LegacyUi } from "../legacy/engine";

export class WorkbenchUi implements LegacyUi {
  /** 最近一次渲染的流程页；面板关闭后仍保留，与旧 FXUI 行为一致。 */
  currentNav = "import";

  private readonly sim: LegacySim;
  private readonly bus: LegacyEventBus;
  private readonly unsubscribe: Array<() => void>;
  private builtinCache: BuiltinModel[] | null = null;

  constructor(sim: LegacySim, bus: LegacyEventBus) {
    this.sim = sim;
    this.bus = bus;
    this.unsubscribe = [
      bus.on("state", () => {
        // printer 随 setPrinterModel 更换，每次事件时重新取引用
        this.sim.printer.showGhost(this.sim.state === "idle");
        if (this.currentNav === "import") this.bus.emit("ctx-page-refresh", "import");
      }),
      bus.on("sliced", () => {
        if (this.currentNav === "slice") this.bus.emit("ctx-page-refresh", "slice");
      }),
    ];
  }

  renderCtx(nav: string): void {
    this.currentNav = nav;
    this.bus.emit("ctx-page-refresh", nav);
  }

  toast(message: string, kind?: string): void {
    this.bus.emit("toast", { msg: message, type: kind });
  }

  confirmAction(title: string, text: string, onOk: () => void): void {
    this.bus.emit("confirm", { title, text, onOk });
  }

  /** 内置工程模型目录（惰性构建一次，与旧 _builtins 缓存口径一致）。 */
  builtins(): BuiltinModel[] {
    if (!this.builtinCache) this.builtinCache = models.createBuiltins();
    return this.builtinCache;
  }

  /* 成品导出：stl / obj（模型三角网格）· gcode（真实切片路径）· source-gcode（导入源文件）。
     逻辑自 ui.js _exportModel 逐行迁移，仅换直接 import 与类型。 */
  exportModel(format: string): void {
    const sim = this.sim;
    if (!sim.model) return this.toast("请先载入模型", "warn");
    const base = sim.model.name.replace(/\s+/g, "_");
    try {
      if (format === "source-gcode") {
        const source = sim.importedToolpath?.sourceText;
        if (!source) return this.toast("原始 G-code 不在当前会话中", "warn");
        exporter.download(base, source, "text/plain;charset=utf-8");
        this.toast(`原始 G-code 已下载：${base}`, "ok");
        return;
      }
      if (format === "gcode") {
        if (!sim.slice) return this.toast("尚未切片，无法导出 G-code", "warn");
        const gcodeText = exporter.gcode(
          sim.slice as unknown as SliceResultOut,
          sim.settings as unknown as GcodeExportSettings,
          {
            model: sim.model.name,
            printer: sim.printer.MODEL_NAME || "FORGE-X",
            densityG: sim.material.densityG,
            bedSize: sim.printer.BED_SIZE || 256,
          }
        );
        exporter.download(
          `${base}_${sim.settings.layerHeight.toFixed(2)}mm_${sim.settings.material}.gcode`,
          gcodeText,
          "text/plain;charset=utf-8"
        );
        this.toast(`G-code 已导出：${sim.slice.totalLayers} 层 · ${(gcodeText.length / 1024).toFixed(0)} KB`, "ok");
        return;
      }
      const geometry = models.buildGeometry(sim.model as unknown as BuiltModel);
      // BufferGeometry 必有 position 属性；THREE 的索引签名类型无法表达这一点
      const triangles = exporter.trianglesFromGeometry(geometry as unknown as GeometryLike, sim.tf.scale || 1);
      geometry.dispose();
      if (format === "stl") {
        exporter.download(`${base}.stl`, exporter.stlFromTriangles(triangles, sim.model.name), "model/stl");
      } else {
        exporter.download(
          `${base}.obj`,
          exporter.objFromTriangles(triangles, sim.model.name),
          "text/plain;charset=utf-8"
        );
      }
      this.toast(
        `${format.toUpperCase()} 已导出：${triangles.length.toLocaleString()} 三角面（含 ${sim.tf.scale.toFixed(2)}× 缩放）`,
        "ok"
      );
    } catch (error) {
      console.error("[export]", error);
      this.toast("导出失败：" + String((error as Error)?.message ?? error), "err");
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }
}
