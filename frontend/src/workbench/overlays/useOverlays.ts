import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchHandles } from "../useLegacyWorkbench";

/** toast 节奏与容量沿用旧实现：2600ms 开始退场、3100ms 移除、最多同屏 4 条。 */
const TOAST_OUT_MS = 2600;
const TOAST_REMOVE_MS = 3100;
const TOAST_MAX = 4;
const ENTER_ANIMATION_MS = 360;

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly kind: string;
  readonly leaving: boolean;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly text: string;
  readonly onOk: () => void;
}

interface PanelState {
  readonly open: boolean;
  readonly entering: boolean;
}

export interface Overlays {
  readonly toasts: ReadonlyArray<ToastItem>;
  readonly confirm: ConfirmRequest | null;
  readonly aboutOpen: boolean;
  readonly param: PanelState;
  readonly monitor: PanelState;
  resolveConfirm(accepted: boolean): void;
  openAbout(): void;
  closeAbout(): void;
  toggleParam(): void;
  toggleMonitor(): void;
}

/**
 * 浮层的唯一真相源：toast 队列、确认弹窗、关于弹窗、两块浮动面板的开合。
 * 遗留侧的 toast()/_confirm() 在接管模式下转发为 bus 事件汇入这里；
 * 故障事件沿用旧行为——提示之余自动展开监控浮层便于排查。
 */
export function useOverlays(handles: WorkbenchHandles | null): Overlays {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastItem>>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [param, setParam] = useState<PanelState>({ open: false, entering: false });
  const [monitor, setMonitor] = useState<PanelState>({ open: false, entering: false });
  const toastSeq = useRef(0);

  const pushToast = useCallback((message: string, kind?: string) => {
    const id = ++toastSeq.current;
    setToasts((current) => [...current, { id, message, kind: kind || "info", leaving: false }].slice(-TOAST_MAX));
    window.setTimeout(
      () => setToasts((current) => current.map((t) => (t.id === id ? { ...t, leaving: true } : t))),
      TOAST_OUT_MS
    );
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_REMOVE_MS);
  }, []);

  const settleEntering = useCallback((set: typeof setParam) => {
    window.setTimeout(() => set((current) => ({ ...current, entering: false })), ENTER_ANIMATION_MS);
  }, []);

  const openPanel = useCallback(
    (set: typeof setParam) => {
      set((current) => (current.open ? current : { open: true, entering: true }));
      settleEntering(set);
    },
    [settleEntering]
  );

  const togglePanel = useCallback(
    (set: typeof setParam) => {
      set((current) => (current.open ? { open: false, entering: false } : { open: true, entering: true }));
      settleEntering(set);
    },
    [settleEntering]
  );

  useEffect(() => {
    if (!handles) return;
    const bus = handles.bus;
    const offToast = bus.on("toast", (payload) => {
      const { msg, type } = (payload ?? {}) as { msg?: string; type?: string };
      if (msg) pushToast(msg, type);
    });
    const offConfirm = bus.on("confirm", (payload) => {
      const request = payload as ConfirmRequest | undefined;
      if (request?.title) setConfirm(request);
    });
    const offFault = bus.on("fault", (payload) => {
      const fault = payload as { name?: string } | undefined;
      pushToast(`故障：${fault?.name ?? ""}`, "err");
      openPanel(setMonitor); // 故障时自动展开日志，便于排查
    });
    const offDone = bus.on("done", () =>
      pushToast("打印完成，成品已就绪 — 「质量」页查看实测报告，「模型」页可导出 STL / OBJ / G-code", "ok")
    );
    return () => {
      offToast();
      offConfirm();
      offFault();
      offDone();
    };
  }, [handles, pushToast, openPanel]);

  const resolveConfirm = useCallback(
    (accepted: boolean) => {
      if (accepted) confirm?.onOk();
      setConfirm(null);
    },
    [confirm]
  );

  return {
    toasts,
    confirm,
    aboutOpen,
    param,
    monitor,
    resolveConfirm,
    openAbout: useCallback(() => setAboutOpen(true), []),
    closeAbout: useCallback(() => setAboutOpen(false), []),
    toggleParam: useCallback(() => togglePanel(setParam), [togglePanel]),
    toggleMonitor: useCallback(() => togglePanel(setMonitor), [togglePanel]),
  };
}
