import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createEngine,
  exposeDebugHandle,
  legacyImportServices,
  legacyUtil,
  type LegacyEventBus,
  type LegacyScene,
  type LegacySim,
  type LegacyUi,
} from "../legacy/engine";
import { WorkbenchUi } from "./workbench-ui";

const BOOT_ANIMATION_MS = 1600;

export interface LogRow {
  readonly id: number;
  readonly time: string;
  readonly lv: string;
  readonly msg: string;
}

/** 事件日志缓冲：装配引擎后立即订阅，启动日志因此不会先于消费者到达而丢失。 */
export interface LogFeed {
  readonly rows: LogRow[];
  clear(): void;
}

const LOG_LIMIT = 240;

export interface WorkbenchHandles {
  fx: LegacyScene;
  sim: LegacySim;
  ui: LegacyUi;
  bus: LegacyEventBus;
  logFeed: LogFeed;
}

function describeBootFailure(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  return message.includes("THREE")
    ? "核心组件加载失败，请检查文件是否完整。"
    : "当前浏览器或显卡驱动不支持 WebGL（或已被禁用）。";
}

/** 服务模式下只拉取已人工审核发布的 active 校准包；离线降级是预期路径。 */
function syncReviewedCalibrations(ui: LegacyUi): void {
  const { apiClient, calibrationRegistry } = legacyImportServices();

  void apiClient
    .probe()
    .then((available) => (available ? apiClient.pullCalibrations() : []))
    .then((bundles) => {
      let changed = 0;
      for (const bundle of bundles) {
        try {
          calibrationRegistry.importBundle(bundle);
          changed++;
        } catch (error) {
          if (!/revision 必须高于/.test(String((error as Error)?.message ?? error))) {
            console.warn("[calibration-sync]", error);
          }
        }
      }
      if (changed) {
        if (ui.currentNav === "import") ui.renderCtx("import");
        ui.toast(`已同步 ${changed} 个服务端审核校准包`, "ok");
      }
    })
    .catch(() => {
      /* 本地 bundle 保持可用 */
    });
}

/**
 * 引擎启动引导，与旧入口 js/main.js 的 boot 顺序一致。
 * 引擎持有 WebGL 上下文且没有完整销毁路径，因此按工作台单例装配一次；
 * StrictMode 的重复调用由 ref 守卫拦截，不会产生第二个渲染器。
 */
export function useLegacyWorkbench(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const handlesRef = useRef<WorkbenchHandles | null>(null);
  const [handles, setHandles] = useState<WorkbenchHandles | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (handlesRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let booted: WorkbenchHandles;
    try {
      legacyImportServices().profiles.syncCostProfile();

      const { fx, bus, sim } = createEngine(canvas);
      fx.onTick = (dt, t) => sim.tick(dt, t);

      /* UI 区域全部由 React 组件承担；WorkbenchUi 只保留引擎联动职责（见其文件头）。 */
      const ui = new WorkbenchUi(sim, bus);

      /* 日志订阅必须先于下面的启动日志发出，缓冲由监控浮层消费。 */
      const rows: LogRow[] = [];
      let logSeq = 0;
      const { nowHMS } = legacyUtil();
      bus.on("log", (payload) => {
        const { lv, msg } = (payload ?? {}) as { lv?: string; msg?: string };
        if (!msg) return;
        rows.push({ id: ++logSeq, time: nowHMS(), lv: lv || "info", msg });
        if (rows.length > LOG_LIMIT) rows.shift();
      });
      const logFeed: LogFeed = {
        rows,
        clear() {
          rows.length = 0;
        },
      };

      booted = { fx, sim, ui, bus, logFeed };
    } catch (error) {
      console.error("[FORGE·X] 初始化失败：", error);
      setFallback(describeBootFailure(error));
      return;
    }

    handlesRef.current = booted;
    exposeDebugHandle(booted);
    setHandles(booted);
    const { sim, ui, bus } = booted;

    sim.setModel(ui.builtins()[0], true);
    ui.renderCtx("import");

    bus.emit("state", "idle");
    sim.log("ok", "FORGE·X 仿真系统初始化完成 · FX-256 已联机（模拟）");
    sim.log("info", "运动系统自检通过 · XY 皮带张力正常 · 三丝杆同步就绪");
    sim.log("info", "载入默认模型「行星齿轮」，切片完成，等待任务指令");
    sim.log("info", "智造洞察已就绪 · 内置示例生产数据 · 顶部「洞察」可开始数据分析");

    syncReviewedCalibrations(ui);

    const bootTimer = window.setTimeout(() => document.body.classList.remove("boot"), BOOT_ANIMATION_MS);

    return () => {
      window.clearTimeout(bootTimer);
    };
  }, [canvasRef]);

  return { handles, fallback };
}
