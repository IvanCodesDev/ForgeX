import { useCallback, useEffect, useState } from "react";
import type { WorkbenchHandles } from "../useLegacyWorkbench";
import type { WorkflowNavId } from "./nav-items";

/** 与旧 _openPanel 的入场动画时长一致。 */
const ENTER_ANIMATION_MS = 360;

export interface WorkflowNav {
  /** 最近一次进入的流程页；关闭面板后标题仍保留该页，与旧行为一致。 */
  readonly lastNav: WorkflowNavId;
  readonly open: boolean;
  readonly entering: boolean;
  openNav(id: WorkflowNavId): void;
  close(): void;
  toggleInsight(pill: HTMLElement): void;
}

/**
 * 上下文面板开合与流程胶囊高亮的唯一真相源。
 * 需要关闭面板的旁路（洞察面板互斥等）通过 `ctx-close-request` 事件汇入；
 * 面板内容由 ContextPanel 按页渲染。
 */
export function useWorkflowNav(handles: WorkbenchHandles | null): WorkflowNav {
  const [lastNav, setLastNav] = useState<WorkflowNavId>("import");
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    handles?.sim.printer.hideSlicePreview(); // 收起面板时同步清掉视口路径预览
  }, [handles]);

  useEffect(() => {
    if (!handles) return;
    return handles.bus.on("ctx-close-request", close);
  }, [handles, close]);

  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => setEntering(false), ENTER_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [entering]);

  /* renderCtx 在 DOM 提交后调用：页面组件先挂载，刷新事件才有订阅者；
     它只做 currentNav 同步与页级刷新事件（见 WorkbenchUi.renderCtx）。 */
  useEffect(() => {
    if (!handles || !open) return;
    handles.ui.renderCtx(lastNav);
  }, [handles, open, lastNav]);

  const openNav = useCallback(
    (id: WorkflowNavId) => {
      if (!handles) return;
      // 再点当前激活项 = 收起面板（保持视口纯净）
      if (open && lastNav === id) {
        close();
        return;
      }
      if (!open) setEntering(true);
      setLastNav(id);
      setOpen(true);
      handles.bus.emit("ctx-open", id); // 通知洞察面板互斥收起
    },
    [handles, open, lastNav, close]
  );

  const toggleInsight = useCallback(
    (pill: HTMLElement) => {
      // 洞察是独立面板（数据分析域），开合与自身高亮由 FXInsight 接管
      handles?.bus.emit("insight-toggle", pill);
    },
    [handles]
  );

  return { lastNav, open, entering, openNav, close, toggleInsight };
}
