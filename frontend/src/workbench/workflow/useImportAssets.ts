import { useCallback, useMemo, useRef, useState } from "react";
import {
  resolveAuthorityMode,
  type AuthorityAnalysisResponse,
  type GcodeAuthorityMode,
} from "../../authority/gcode-authority";
import { requestAuthorityJobAnalysis, type AuthorityJobProgress } from "../../authority/gcode-job-client";
import type { GcodeParseOptions } from "../../authority/gcode-types";
import {
  legacyImportServices,
  type CalibrationInfo,
  type GcodeImportState,
  type ImageModelState,
  type LegacySim,
  type MachineLogRecord,
  type MachineLogState,
  type ParsedGcode,
} from "../../legacy/engine";
import type { WorkbenchHandles } from "../useLegacyWorkbench";

/** 与旧实现一致的图片模型再生成防抖。 */
const IMAGE_REGEN_DEBOUNCE_MS = 280;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;

const INITIAL_IMAGE_STATE: ImageModelState = {
  img: null,
  name: "",
  mode: "relief",
  widthMm: 80,
  maxH: 8,
  invert: false,
  threshold: 0.5,
};

/** C# 权威分析的展示状态。browser 模式恒为 idle（零请求，与旧入口行为一致）。 */
export interface GcodeAuthorityState {
  readonly mode: GcodeAuthorityMode;
  readonly status: "idle" | "running" | "done" | "error";
  readonly phase: string;
  readonly progress: number;
  readonly jobId: string | null;
  readonly result: AuthorityAnalysisResponse | null;
  readonly error: string | null;
}

const AUTHORITY_IDLE: Omit<GcodeAuthorityState, "mode"> = {
  status: "idle",
  phase: "",
  progress: 0,
  jobId: null,
  result: null,
  error: null,
};

export interface ImportAssets {
  readonly image: ImageModelState;
  readonly gcode: GcodeImportState | null;
  readonly machineLog: MachineLogState | null;
  readonly authority: GcodeAuthorityState;
  handleImageFile(file: File): void;
  handleGcodeFile(file: File): void;
  handleMachineLogFile(file: File): void;
  handleProfileFile(file: File): void;
  handleCalibrationFile(file: File): void;
  updateImage(patch: Partial<ImageModelState>, options?: { debounce?: boolean }): void;
  /** 选择内置/图片以外的新几何时清空导入链（与旧 _gcodeState/_machineLogState 置空一致）。 */
  clearImportChain(): void;
  /** 材料切换改变导入 toolpath 的密度口径，对账与校准估算需按新 slice 重算。 */
  refreshAfterMaterialChange(): void;
}

function printLocked(sim: LegacySim): boolean {
  return !["idle", "done"].includes(sim.state);
}

/**
 * 模型页的资产状态：图片建模 / G-code 导入 / 真机日志。
 * 生命周期挂在工作台（切页保留），语义与旧 FXUI 实例字段一致；
 * 五个 hidden file input 的 change 由宿主绑定（遗留 _bindUpload 已按 uploads 区跳过）。
 */
export function useImportAssets(handles: WorkbenchHandles | null): ImportAssets {
  const [image, setImage] = useState<ImageModelState>(INITIAL_IMAGE_STATE);
  const [gcode, setGcode] = useState<GcodeImportState | null>(null);
  const [machineLog, setMachineLog] = useState<MachineLogState | null>(null);
  const authorityMode = resolveAuthorityMode(import.meta.env);
  const [authority, setAuthority] = useState<GcodeAuthorityState>({ mode: authorityMode, ...AUTHORITY_IDLE });
  const imageRef = useRef(image);
  imageRef.current = image;
  const gcodeRef = useRef(gcode);
  gcodeRef.current = gcode;
  const regenTimer = useRef<number | null>(null);
  const authorityAbort = useRef<AbortController | null>(null);

  const sim = handles?.sim ?? null;
  const ui = handles?.ui ?? null;

  /* dotnet 模式：提交 C# 异步作业（SSE 进度 + 轮询兜底），完整校验通过后原子呈现权威摘要；
     失败保留浏览器解析并明示。browser 模式零请求，与旧入口完全一致。 */
  const requestAuthority = useCallback(
    (file: File, options: GcodeParseOptions) => {
      if (authorityMode !== "dotnet") return;
      authorityAbort.current?.abort();
      const controller = new AbortController();
      authorityAbort.current = controller;
      setAuthority({ mode: authorityMode, ...AUTHORITY_IDLE, status: "running", phase: "queued" });
      const onProgress = (progress: AuthorityJobProgress) =>
        setAuthority((current) =>
          current.status === "running"
            ? { ...current, jobId: progress.jobId, phase: progress.phase, progress: progress.progress }
            : current
        );
      requestAuthorityJobAnalysis(file, options, import.meta.env, controller.signal, {
        onAccepted: (jobId) => setAuthority((current) => ({ ...current, jobId })),
        onProgress,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          setAuthority((current) => ({ ...current, status: "done", progress: 1, result, error: null }));
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.error("[gcode-authority]", error);
          setAuthority((current) => ({
            ...current,
            status: "error",
            error: String((error as Error)?.message ?? error),
          }));
        });
    },
    [authorityMode]
  );

  const calibrationFor = useCallback(
    (parsed: ParsedGcode, log: MachineLogRecord, record: boolean): CalibrationInfo | null => {
      if (!sim) return null;
      const { calibrationRegistry, timeCalibration } = legacyImportServices();
      const model = calibrationRegistry.match({
        machineId: log.machineId,
        firmware: log.firmware,
        material: sim.settings.material,
      });
      if (!model) return null;
      const observation = timeCalibration.fromPair(parsed, log, {
        id: log.jobId || log.name,
        machineId: log.machineId,
        firmware: log.firmware,
      });
      return {
        model,
        estimate: calibrationRegistry.estimate(model, parsed.stats.timeSec),
        drift: record ? calibrationRegistry.recordObservation(model, observation) : calibrationRegistry.drift(model),
      };
    },
    [sim]
  );

  const clearImportChain = useCallback(() => {
    setGcode(null);
    setMachineLog(null);
    authorityAbort.current?.abort();
    setAuthority({ mode: authorityMode, ...AUTHORITY_IDLE });
  }, [authorityMode]);

  const regenerateImageModel = useCallback(
    (state: ImageModelState) => {
      if (!sim || !ui || !state.img) return;
      if (printLocked(sim)) {
        ui.toast("打印中不可更换模型", "warn");
        return;
      }
      const { models } = legacyImportServices();
      const model = models.fromImage(state.img, {
        mode: state.mode,
        widthMm: state.widthMm,
        maxH: state.maxH,
        invert: state.invert,
        threshold: state.threshold,
        name: state.name.replace(/\.[^.]+$/, ""),
      });
      // 从其他模型切换到图片模型时重置摆放；仅调参数时保留
      const firstLoad = !sim.model || sim.model.id !== "image";
      clearImportChain();
      sim.setModel(model, firstLoad);
    },
    [sim, ui, clearImportChain]
  );

  const updateImage = useCallback(
    (patch: Partial<ImageModelState>, options?: { debounce?: boolean }) => {
      const next = { ...imageRef.current, ...patch };
      setImage(next);
      if (regenTimer.current !== null) window.clearTimeout(regenTimer.current);
      if (options?.debounce) {
        regenTimer.current = window.setTimeout(() => regenerateImageModel(next), IMAGE_REGEN_DEBOUNCE_MS);
      } else {
        regenerateImageModel(next);
      }
    },
    [regenerateImageModel]
  );

  const handleImageFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      if (!/^image\//.test(file.type)) return ui.toast("仅支持图片文件（PNG / JPG / WebP）", "err");
      if (file.size > MAX_IMAGE_BYTES) return ui.toast("图片超过 20MB，请压缩后重试", "err");
      if (printLocked(sim)) return ui.toast("打印中不可更换模型", "warn");
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          if (!img.naturalWidth || !img.naturalHeight) return ui.toast("无法读取图片尺寸，请换一张图", "err");
          updateImage({ img, name: file.name });
          ui.toast(`「${file.name}」已转为3D模型并切片`, "ok");
        };
        img.onerror = () => ui.toast("图片解析失败", "err");
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    },
    [sim, ui, updateImage]
  );

  const handleGcodeFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      const { gcodeParser } = legacyImportServices();
      if (!/\.(gcode|gco|gc)$/i.test(file.name || "")) return ui.toast("请选择 .gcode / .gco / .gc 文件", "err");
      if (file.size > gcodeParser.MAX_BYTES)
        return ui.toast(`G-code 超过 ${Math.round(gcodeParser.MAX_BYTES / 1024 / 1024)}MB`, "err");
      if (printLocked(sim)) return ui.toast("打印中不可导入 G-code", "warn");
      const reader = new FileReader();
      reader.onerror = () => ui.toast("G-code 文件读取失败", "err");
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        gcodeParser
          .sha256(buffer)
          .then((sha256) => {
            const sourceText = new TextDecoder("utf-8").decode(new Uint8Array(buffer));
            const origin = String(sim.printer.KIN_TAG || "").toLowerCase() === "delta" ? "center" : "corner";
            const parsed = gcodeParser.parse(sourceText, {
              densityG: sim.material.densityG,
              bedSize: sim.printer.BED_SIZE || 256,
              origin,
            });
            parsed.sha256 = sha256;
            const reconcile = gcodeParser.reconcile(parsed);
            sim.loadImportedToolpath(parsed, { name: file.name, sourceText });
            /* 几何随导入固化：setGcode 触发重渲，参数面板锁定标签随 React 状态立即生效 */
            setGcode({ name: file.name, parsed, reconcile, sha256 });
            setMachineLog(null);
            ui.toast(`已解析 ${parsed.totalLayers} 层真实 G-code · SHA-256 ${sha256.slice(0, 12)}…`, "ok");
            requestAuthority(file, { densityG: sim.material.densityG, bedSize: sim.printer.BED_SIZE || 256, origin });
          })
          .catch((error) => {
            console.error("[gcode-import]", error);
            ui.toast("G-code 导入失败：" + String((error as Error)?.message ?? error), "err");
          });
      };
      reader.readAsArrayBuffer(file);
    },
    [sim, ui, requestAuthority]
  );

  const handleMachineLogFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      const current = gcodeRef.current;
      if (!sim.importedToolpath || !current) return ui.toast("请先导入要复盘的 G-code", "warn");
      const { machineLog: machineLogService, timeCalibration } = legacyImportServices();
      if (!/\.(json|csv)$/i.test(file.name || "")) return ui.toast("真机日志仅支持 JSON / CSV", "err");
      if (file.size > machineLogService.MAX_BYTES)
        return ui.toast(`真机日志超过 ${Math.round(machineLogService.MAX_BYTES / 1024 / 1024)}MB`, "err");
      const reader = new FileReader();
      reader.onerror = () => ui.toast("真机日志读取失败", "err");
      reader.onload = () => {
        try {
          const log = machineLogService.parse(String(reader.result), { name: file.name });
          const binding = machineLogService.verifyGcodeBinding(current.parsed, log);
          if (binding.status === "invalid" || binding.status === "unavailable" || binding.status === "mismatch") {
            throw new Error(binding.message);
          }
          log.gcodeBinding = binding;
          if (!binding.verified) log.warnings.push(binding.message);
          const comparison = machineLogService.compare(current.parsed, log);
          const observation = timeCalibration.observation(current.parsed, log);
          const calibration = calibrationFor(current.parsed, log, true);
          setMachineLog({ log, comparison, observation, calibration, binding });
          ui.toast(`真机日志已接入：生成 ${comparison.length} 项计划/实测对比`, "ok");
        } catch (error) {
          console.error("[machine-log]", error);
          ui.toast("真机日志导入失败：" + String((error as Error)?.message ?? error), "err");
        }
      };
      reader.readAsText(file);
    },
    [sim, ui, calibrationFor]
  );

  const handleCalibrationFile = useCallback(
    (file: File) => {
      if (!ui) return;
      const { calibrationRegistry } = legacyImportServices();
      if (!/\.json$/i.test(file.name || "")) return ui.toast("校准包必须是 JSON 文件", "err");
      if (file.size > calibrationRegistry.MAX_BYTES) return ui.toast("校准包 JSON 超过 2MB", "err");
      const reader = new FileReader();
      reader.onerror = () => ui.toast("校准包读取失败", "err");
      reader.onload = () => {
        try {
          const imported = calibrationRegistry.importBundle(JSON.parse(String(reader.result)));
          const current = gcodeRef.current;
          setMachineLog((previous) =>
            previous && current
              ? { ...previous, calibration: calibrationFor(current.parsed, previous.log, false) }
              : previous
          );
          ui.toast(`校准包已导入：${imported.id} r${imported.revision} · ${imported.models.length} 个模型`, "ok");
        } catch (error) {
          console.error("[calibration-import]", error);
          ui.toast("校准包导入失败：" + String((error as Error)?.message ?? error), "err");
        }
      };
      reader.readAsText(file);
    },
    [ui, calibrationFor]
  );

  const handleProfileFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      const { profiles } = legacyImportServices();
      if (!/\.json$/i.test(file.name || "")) return ui.toast("Profile 必须是 JSON 文件", "err");
      if (file.size > MAX_PROFILE_BYTES) return ui.toast("Profile JSON 超过 2MB", "err");
      if (printLocked(sim)) return ui.toast("打印中不可导入 Profile", "warn");
      const reader = new FileReader();
      reader.onerror = () => ui.toast("Profile 文件读取失败", "err");
      reader.onload = () => {
        try {
          const added = profiles.importBundle(JSON.parse(String(reader.result)));
          handles?.bus.emit("params-refresh"); // 宿主参数面板按新机型/材料清单重渲
          ui.toast(`Profile 已导入：${added.machines.length} 个机型 · ${added.materials.length} 种材料`, "ok");
        } catch (error) {
          console.error("[profile-import]", error);
          ui.toast("Profile 导入失败：" + String((error as Error)?.message ?? error), "err");
        }
      };
      reader.readAsText(file);
    },
    [sim, ui, handles]
  );

  const refreshAfterMaterialChange = useCallback(() => {
    if (!sim || !sim.importedToolpath || !gcodeRef.current) return;
    const { gcodeParser, machineLog: machineLogService, timeCalibration } = legacyImportServices();
    /* 导入模式下 sim.slice 即解析后的 toolpath（loadImportedToolpath 的口径），与旧实现一致。 */
    const parsed = sim.slice as unknown as ParsedGcode;
    setGcode((previous) => (previous ? { ...previous, reconcile: gcodeParser.reconcile(parsed) } : previous));
    setMachineLog((previous) =>
      previous
        ? {
            ...previous,
            comparison: machineLogService.compare(parsed, previous.log),
            observation: timeCalibration.observation(parsed, previous.log),
            calibration: calibrationFor(parsed, previous.log, false),
          }
        : previous
    );
  }, [sim, calibrationFor]);

  return useMemo(
    () => ({
      image,
      gcode,
      machineLog,
      authority,
      handleImageFile,
      handleGcodeFile,
      handleMachineLogFile,
      handleProfileFile,
      handleCalibrationFile,
      updateImage,
      clearImportChain,
      refreshAfterMaterialChange,
    }),
    [
      image,
      gcode,
      machineLog,
      authority,
      handleImageFile,
      handleGcodeFile,
      handleMachineLogFile,
      handleProfileFile,
      handleCalibrationFile,
      updateImage,
      clearImportChain,
      refreshAfterMaterialChange,
    ]
  );
}
