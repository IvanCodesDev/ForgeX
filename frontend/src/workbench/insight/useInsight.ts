import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  AnalyticsAuthorityUnsupportedError,
  compareAnalyticsReports,
  requestAnalyticsAuthorityReport,
  resolveAnalyticsAuthorityMode,
  toInsightReport,
  type AnalyticsAuthorityMode,
} from "../../authority/analytics-authority";
import {
  legacyInsightServices,
  legacyUtil,
  type DatasetProvenance,
  type InsightChartItem,
  type InsightReport,
  type InsightStore,
} from "../../legacy/engine";
import type { WorkbenchHandles } from "../useLegacyWorkbench";

const ENTER_ANIMATION_MS = 360;
const DEEP_LINK_DELAY_MS = 700;
/** 云端任务事件很多，只保留最近 8 条，避免面板被撑爆。 */
const STAGE_LIMIT = 8;
const HISTORY_LIMIT = 5;
const CSV_MAX_BYTES = 4 * 1024 * 1024;

export interface ProgressStage {
  readonly id: number;
  readonly message: string;
}

export interface HistoryEntry {
  readonly q: string;
  readonly at: string;
}

export type EngineMode = "local" | "server-rules" | "ai";

export interface Insight {
  readonly open: boolean;
  readonly entering: boolean;
  readonly store: InsightStore | null;
  readonly storeVersion: number;
  readonly busy: boolean;
  readonly stages: ReadonlyArray<ProgressStage>;
  readonly progress: number;
  readonly report: InsightReport | null;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly engineMode: EngineMode;
  readonly authorityMode: AnalyticsAuthorityMode;
  readonly fleetOn: boolean;
  readonly question: string;
  setQuestion(value: string): void;
  close(): void;
  ask(question: string): void;
  handleCsvFile(file: File): void;
  showFleet(items: ReadonlyArray<InsightChartItem>, targetId: string): void;
  exitFleet(): void;
  highlightMachine(id: string): void;
  viewportMatches(id: string): boolean;
  shareReport(taskId: string): Promise<void>;
}

/**
 * 智造洞察的唯一真相源，职责与遗留 FXInsight 一一对应：
 * 面板开合与导航互斥、数据集 Store、引擎路由（后端可用走后端，否则本地规则引擎）、
 * 真实事件驱动的进度、报告与历史、仿真采集、3D 机群联动、深链直达。
 */
export function useInsight(handles: WorkbenchHandles | null, closeContextPanel: () => void): Insight {
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<ReadonlyArray<ProgressStage>>([]);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<InsightReport | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [engineMode, setEngineMode] = useState<EngineMode>("local");
  const [fleetOn, setFleetOn] = useState(false);
  const [question, setQuestion] = useState("");
  const [storeVersion, bumpStore] = useReducer((version: number) => version + 1, 0);
  /* C# Analytics 权威三态（构建期常量）：browser 零请求；shadow 双跑对照；dotnet 权威优先。 */
  const authorityMode = resolveAnalyticsAuthorityMode(import.meta.env);

  const storeRef = useRef<InsightStore | null>(null);
  const stageSeq = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const blinkTimer = useRef<number | null>(null);

  const ui = handles?.ui ?? null;

  if (handles && !storeRef.current) {
    const { insightData } = legacyInsightServices();
    storeRef.current = new insightData.Store(handles.bus);
  }
  const store = storeRef.current;

  const show = useCallback(() => {
    closeContextPanel(); // 与左侧流程卡互斥
    setOpen(true);
    setEntering(true);
    window.setTimeout(() => setEntering(false), ENTER_ANIMATION_MS);
    bumpStore(); // show 时刷新数据集视图，与旧 _refreshData 一致
  }, [closeContextPanel]);

  const hide = useCallback(() => setOpen(false), []);

  // 导航互斥：点其他流程页关闭洞察；点「洞察」胶囊开关本面板
  useEffect(() => {
    if (!handles) return;
    const offToggle = handles.bus.on("insight-toggle", () => {
      if (openRef.current) hide();
      else show();
    });
    const offCtxOpen = handles.bus.on("ctx-open", hide);
    const offData = handles.bus.on("insight-data", bumpStore);
    return () => {
      offToggle();
      offCtxOpen();
      offData();
    };
  }, [handles, show, hide]);

  // 模拟器完成/故障中止 → 采集运行数据（自洽闭环）
  useEffect(() => {
    if (!handles || !store || !ui) return;
    return handles.bus.on("job-record", (payload) => {
      const d = (payload ?? {}) as { status?: string; fault?: unknown };
      const { insightData } = legacyInsightServices();
      // 归不了类就如实写「未知」，不猜——猜错会污染整个数据集的故障归因
      const reason = d.status === "fail" ? insightData.normalizeFault(d.fault) : "";
      const record = insightData.recordFromSim(handles.sim, d.status ?? "", reason);
      store.addSimRecord(record);
      ui.toast(`运行数据已采集 → 本机采集 ${record.machine_id}（共 ${store.sets.sim?.rows.length ?? 0} 条）`, "info");
      bumpStore();
    });
  }, [handles, store, ui]);

  // 后端探测：可用则切云端引擎标识
  useEffect(() => {
    if (!handles) return;
    const { apiClient } = legacyInsightServices();
    void apiClient.probe().then(() => {
      const ai = !!(apiClient.available && apiClient.capabilities?.ai);
      setEngineMode(!apiClient.available ? "local" : ai ? "ai" : "server-rules");
    });
  }, [handles]);

  const pushStage = useCallback((message: string, value?: number) => {
    setStages((current) => {
      const next = [...current, { id: ++stageSeq.current, message }];
      return next.length > STAGE_LIMIT ? next.slice(next.length - STAGE_LIMIT) : next;
    });
    if (typeof value === "number" && Number.isFinite(value)) {
      setProgress(Math.max(0, Math.min(1, value)));
    }
  }, []);

  const finishAsk = useCallback(() => {
    setBusy(false);
    setStages([]);
    setProgress(0);
  }, []);

  const pushHistory = useCallback((q: string) => {
    const { nowHMS } = legacyUtil();
    setHistory((current) => [{ q, at: nowHMS() }, ...current].slice(0, HISTORY_LIMIT));
  }, []);

  const ask = useCallback(
    (raw: string) => {
      if (!handles || !store || !ui) return;
      const q = String(raw || "").trim();
      if (!q) return ui.toast("先输入要分析的问题", "warn");
      if (busyRef.current) return;
      const rows = store.rows();
      if (!rows.length) return ui.toast("当前数据集为空，请先载入数据", "warn");

      setQuestion(q);
      setBusy(true);
      setReport(null);
      setStages([]);
      setProgress(0);

      const { insightEngine, apiClient, insightData } = legacyInsightServices();
      const provenance: DatasetProvenance = store.provenance();

      /* shadow 双跑：同一份数据后台送 C# 权威并逐字段对照（阶段 4 双跑标准）。
         只挂在本地规则引擎的计算腿上——它才是 C# 引擎的镜像对象；
         对照结果只进控制台，绝不改变展示（与 G-code shadow 不切主的纪律一致）。 */
      const shadowCompare = (localReport: InsightReport) => {
        if (authorityMode !== "shadow") return;
        requestAnalyticsAuthorityReport(q, rows, import.meta.env)
          .then((authority) => {
            const diff = compareAnalyticsReports(localReport, authority.report);
            if (diff.pass) {
              console.info(
                `[insight shadow] C# 权威对照一致（engine ${authority.engine.version} · ${rows.length} 行）`
              );
            } else {
              console.warn(`[insight shadow] C# 权威对照发现 ${diff.mismatches.length} 处差异`, diff.mismatches);
            }
          })
          .catch((error) => {
            if (error instanceof AnalyticsAuthorityUnsupportedError) {
              console.info("[insight shadow] 数据集不在 C# 权威契约内，跳过对照：" + (error as Error).message);
            } else {
              console.warn("[insight shadow] C# 权威对照请求失败", error);
            }
          });
      };

      /* 本地规则引擎：同步计算，毫秒级返回。不插入任何人造延时或假分步。 */
      const askLocal = (fallbackFrom?: string) => {
        const t0 = Date.now();
        try {
          const localReport = insightEngine.analyze(q, rows, { provenance });
          localReport.elapsedMs = Date.now() - t0;
          if (fallbackFrom) localReport.fallbackFrom = fallbackFrom;
          finishAsk();
          pushHistory(q);
          setReport(localReport);
          shadowCompare(localReport);
        } catch (error) {
          console.error("[insight]", error);
          finishAsk();
          ui.toast("分析出错：" + String((error as Error)?.message ?? error), "err");
        }
      };

      /* dotnet 权威：完整校验通过后原子成为展示结果；失败回退本地规则并明示。 */
      const askAuthority = () => {
        const t0 = Date.now();
        pushStage(`提交 C# 权威分析（${rows.length} 行）`, 0.2);
        requestAnalyticsAuthorityReport(q, rows, import.meta.env)
          .then((authority) => {
            pushStage(`完成 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, 1);
            finishAsk();
            pushHistory(q);
            setReport(toInsightReport(authority, { provenance, elapsedMs: Date.now() - t0 }));
          })
          .catch((error) => {
            if (error instanceof AnalyticsAuthorityUnsupportedError) {
              // 超出契约（行数/字段/长度）不是故障：本地规则引擎本就是这类数据集的归宿
              console.info("[insight authority] " + (error as Error).message + "，改用本地规则引擎");
              askLocal();
              return;
            }
            console.error("[insight authority]", error);
            ui.toast(`C# 权威分析失败（${(error as Error).message}），已回退浏览器本地规则引擎`, "warn");
            askLocal("dotnet-authority");
          });
      };

      /* 调度：真 AI 管线是叙述能力，保留最高优先；规则计算在 dotnet 模式下以 C# 权威为默认
         （取代本地与 Node 规则腿），browser/shadow 维持原有本地行为。 */
      const wantAuthority = authorityMode === "dotnet" && engineMode !== "ai";
      if (!apiClient.available || wantAuthority) {
        if (wantAuthority) askAuthority();
        else askLocal();
        return;
      }

      const t0 = Date.now();
      pushStage(`上传数据集（${rows.length} 行）`, 0.05);
      apiClient
        .uploadDatasource(insightData.toCsv(rows), "print_jobs.csv", provenance)
        .then((ds) => {
          pushStage("提交分析任务", 0.12);
          return apiClient.analyze(q, ds.datasourceId);
        })
        .then(
          (task) =>
            new Promise<string>((resolve, reject) => {
              // 渲染后端真实推送的阶段事件
              apiClient.stream(
                task.taskId,
                (ev) => pushStage(ev.message || ev.stage || "处理中…", ev.progress),
                () => resolve(task.taskId),
                reject
              );
            })
        )
        .then((taskId) => {
          pushStage("拉取分析结果", 0.97);
          return apiClient.result(taskId);
        })
        .then((remoteReport) => {
          pushStage(`完成 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`, 1);
          remoteReport.elapsedMs = Date.now() - t0;
          // 后端不知道浏览器侧数据集的来源标记，这里补齐，保证报告始终带 provenance
          if (!remoteReport.provenance) remoteReport.provenance = provenance;
          finishAsk();
          pushHistory(q);
          setReport(remoteReport);
        })
        .catch((error) => {
          console.error("[insight remote]", error);
          finishAsk();
          ui.toast(`后端分析失败（${(error as Error).message}），已回退浏览器本地规则引擎`, "warn");
          askLocal("backend");
        });
    },
    [handles, store, ui, pushStage, finishAsk, pushHistory, authorityMode, engineMode]
  );

  const handleCsvFile = useCallback(
    (file: File) => {
      if (!store || !ui) return;
      if (file.size > CSV_MAX_BYTES) return ui.toast("CSV 超过 4MB，请精简后重试", "err");
      const reader = new FileReader();
      reader.onload = () => {
        const { insightData } = legacyInsightServices();
        const out = insightData.parseCsv(String(reader.result));
        if (!out.rows.length) return ui.toast("解析失败：" + (out.errors[0] || "无有效数据"), "err");
        store.setUpload(out.rows);
        let message = `已导入 ${out.rows.length} 条记录`;
        if (out.errors.length) message += `（${out.errors[0]}）`;
        ui.toast(message, "ok");
        bumpStore();
      };
      reader.onerror = () => ui.toast("文件读取失败", "err");
      reader.readAsText(file, "utf-8");
    },
    [store, ui]
  );

  /* 机群视图：色相 = 失败率，不透明度 = 证据强度（置信区间越宽越透明）。 */
  const showFleet = useCallback(
    (items: ReadonlyArray<InsightChartItem>, targetId: string) => {
      if (!handles || !ui) return;
      const fx = handles.fx;
      const fleet = fx.fleet;
      if (!fleet) return ui.toast("当前场景不支持机群视图", "warn");
      const { fleetView } = legacyInsightServices();
      const machines = fleetView.fromChartItems(items, targetId);
      fleet.build(machines).highlight(targetId).show(true);
      if (fx.printer) fx.printer.group.visible = false; // 与详细机型互斥，避免遮挡
      const view = fleet.focusTarget(targetId);
      fx.orbit?.setView(view.pos, view.target, false);
      setFleetOn(true);
      const weak = machines.filter((m) => !m.status.trustworthy).length;
      ui.toast(
        `机群视图：${machines.length} 台，已定位 ${targetId}` +
          (weak ? `（其中 ${weak} 台证据不足，显示为半透明）` : ""),
        "ok"
      );
    },
    [handles, ui]
  );

  const exitFleet = useCallback(() => {
    if (!handles) return;
    const fx = handles.fx;
    fx.fleet?.show(false).clear();
    if (fx.printer) fx.printer.group.visible = true;
    fx.setCameraPreset("overview");
    setFleetOn(false);
  }, [handles]);

  /** 结论指向的机台，是否就是视口里当前装载的这台机型 */
  const viewportMatches = useCallback(
    (machineId: string) => {
      const printer = handles?.fx.printer;
      const tag = printer && (printer.MODEL_TAG || printer.MODEL_NAME);
      return !!(tag && String(machineId || "").indexOf(String(tag)) === 0);
    },
    [handles]
  );

  const highlightMachine = useCallback(
    (id: string) => {
      const fx = handles?.fx;
      const printer = fx?.printer;
      if (!fx || !printer || !ui) return;
      fx.setCameraPreset("overview");
      const origin = printer.stateLED.material.color.getHex();
      let n = 0;
      if (blinkTimer.current !== null) window.clearInterval(blinkTimer.current);
      blinkTimer.current = window.setInterval(() => {
        printer.setStateLED(n % 2 ? origin : 0xff5f52);
        if (++n >= 9) {
          if (blinkTimer.current !== null) window.clearInterval(blinkTimer.current);
          printer.setStateLED(origin);
        }
      }, 240);
      ui.toast(`已高亮 ${id} 的状态灯`, "ok");
    },
    [handles, ui]
  );

  const shareReport = useCallback(
    async (taskId: string) => {
      if (!ui) return;
      const { apiClient } = legacyInsightServices();
      try {
        const out = await apiClient.share(taskId);
        const win = window.open(out.publicUrl, "_blank");
        if (win) ui.toast("分享页已在新窗口打开（24 小时有效）", "ok");
        else ui.toast("分享链接：" + out.publicUrl, "info");
      } catch (error) {
        ui.toast((error as Error).message, "err");
      }
    },
    [ui]
  );

  // #insight 锚点直达洞察面板；?q=问题 直达分析结果（可分享的演示链接）
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (!handles || deepLinkDone.current) return;
    const encodedQuestion = /[?&]q=([^&]+)/.exec(window.location.search)?.[1] ?? null;
    if (window.location.hash !== "#insight" && !encodedQuestion) return;
    deepLinkDone.current = true;
    const timer = window.setTimeout(() => {
      show();
      if (!encodedQuestion) return;
      try {
        ask(decodeURIComponent(encodedQuestion));
      } catch {
        /* 非法编码忽略 */
      }
    }, DEEP_LINK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [handles, show, ask]);

  return {
    open,
    entering,
    store,
    storeVersion,
    busy,
    stages,
    progress,
    report,
    history,
    engineMode,
    authorityMode,
    fleetOn,
    question,
    setQuestion,
    close: hide,
    ask,
    handleCsvFile,
    showFleet,
    exitFleet,
    highlightMachine,
    viewportMatches,
    shareReport,
  };
}
