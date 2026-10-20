import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MESH_AUTHORITY_IDLE,
  meshAuthorityEnabled,
  requestMeshAuthority,
  type MeshAuthorityState,
} from "../../authority/mesh-authority";
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
import { GcodeImportError, importGcodeFile, type GcodeImportHandle, type GcodeImportPhase } from "./gcode-import";
import { MeshImportError, importMeshFile, type MeshImportHandle, type MeshImportPhase } from "./mesh-import";
import { MAX_MESH_BYTES, createMeshModel, type MeshImportPayload } from "../../engine/mesh-import";
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

/** 浏览器侧 G-code 解析（Worker）的进行中状态；idle 表示无解析在途。 */
export interface GcodeImportProgressState {
  readonly status: "idle" | "parsing";
  readonly phase: GcodeImportPhase | null;
  readonly progress: number;
}

const GCODE_IMPORT_IDLE: GcodeImportProgressState = { status: "idle", phase: null, progress: 0 };

/** 浏览器网格与按原始文件指纹绑定的 C# 几何校验结果。 */
export interface MeshImportState {
  readonly name: string;
  readonly sha256: string;
  readonly via: "worker" | "main";
  readonly mesh: MeshImportPayload;
  readonly authority: MeshAuthorityState;
}

export interface MeshImportProgressState {
  readonly status: "idle" | "parsing";
  readonly phase: MeshImportPhase | null;
  readonly progress: number;
}

const MESH_IMPORT_IDLE: MeshImportProgressState = { status: "idle", phase: null, progress: 0 };

export interface ImportAssets {
  readonly image: ImageModelState;
  readonly gcode: GcodeImportState | null;
  readonly gcodeImport: GcodeImportProgressState;
  readonly mesh: MeshImportState | null;
  readonly meshImport: MeshImportProgressState;
  readonly machineLog: MachineLogState | null;
  readonly authority: GcodeAuthorityState;
  handleImageFile(file: File): void;
  handleGcodeFile(file: File): void;
  handleMeshFile(file: File): void;
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
  const [gcodeImport, setGcodeImport] = useState<GcodeImportProgressState>(GCODE_IMPORT_IDLE);
  const [mesh, setMesh] = useState<MeshImportState | null>(null);
  const [meshImport, setMeshImport] = useState<MeshImportProgressState>(MESH_IMPORT_IDLE);
  const [machineLog, setMachineLog] = useState<MachineLogState | null>(null);
  const authorityMode = resolveAuthorityMode(import.meta.env);
  const [authority, setAuthority] = useState<GcodeAuthorityState>({ mode: authorityMode, ...AUTHORITY_IDLE });
  const imageRef = useRef(image);
  imageRef.current = image;
  const gcodeRef = useRef(gcode);
  gcodeRef.current = gcode;
  const regenTimer = useRef<number | null>(null);
  const authorityAbort = useRef<AbortController | null>(null);
  const gcodeImportHandle = useRef<GcodeImportHandle | null>(null);
  const meshImportHandle = useRef<MeshImportHandle | null>(null);
  const meshAuthorityAbort = useRef<AbortController | null>(null);
  const machineLogReader = useRef<FileReader | null>(null);
  useEffect(
    () => () => {
      meshImportHandle.current?.cancel();
      meshAuthorityAbort.current?.abort();
      meshImportHandle.current = null;
      meshAuthorityAbort.current = null;
      machineLogReader.current?.abort();
      machineLogReader.current = null;
    },
    []
  );

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
      if (
        !sim ||
        !log.gcodeBinding?.verified ||
        log.actualTimeSec === null ||
        log.actualTimeSec <= 0 ||
        !(parsed.stats.timeSec > 0)
      )
        return null;
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

  const clearGcodeChain = useCallback(() => {
    machineLogReader.current?.abort();
    machineLogReader.current = null;
    gcodeImportHandle.current?.cancel();
    gcodeImportHandle.current = null;
    setGcodeImport(GCODE_IMPORT_IDLE);
    setGcode(null);
    gcodeRef.current = null;
    setMachineLog(null);
    authorityAbort.current?.abort();
    setAuthority({ mode: authorityMode, ...AUTHORITY_IDLE });
  }, [authorityMode]);

  const clearMeshChain = useCallback(() => {
    meshAuthorityAbort.current?.abort();
    meshImportHandle.current?.cancel();
    meshImportHandle.current = null;
    setMeshImport(MESH_IMPORT_IDLE);
    setMesh(null);
  }, []);

  const clearImportChain = useCallback(() => {
    clearGcodeChain();
    clearMeshChain();
  }, [clearGcodeChain, clearMeshChain]);

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

  /* 解析在 Web Worker 内流式完成（读取/SHA-256/分块解码/行解析/顶点缓冲，V1 §5.5），
     主线程只做分片装配与结果挂载；Worker 基建不可用时客户端自动退回旧同步路径。 */
  const handleGcodeFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      const { gcodeParser } = legacyImportServices();
      if (!/\.(gcode|gco|gc)$/i.test(file.name || "")) return ui.toast("请选择 .gcode / .gco / .gc 文件", "err");
      if (file.size > gcodeParser.MAX_BYTES)
        return ui.toast(`G-code 超过 ${Math.round(gcodeParser.MAX_BYTES / 1024 / 1024)}MB`, "err");
      if (printLocked(sim)) return ui.toast("打印中不可导入 G-code", "warn");
      const origin = String(sim.printer.KIN_TAG || "").toLowerCase() === "delta" ? "center" : "corner";
      const options = { densityG: sim.material.densityG, bedSize: sim.printer.BED_SIZE || 256, origin } as const;
      gcodeImportHandle.current?.cancel();
      setGcodeImport({ status: "parsing", phase: "read", progress: 0 });
      const handle = importGcodeFile(file, options, (progress) =>
        setGcodeImport({ status: "parsing", phase: progress.phase, progress: progress.progress })
      );
      gcodeImportHandle.current = handle;
      handle.promise
        .then(({ parsed, sourceText, sha256, toolpath }) => {
          if (gcodeImportHandle.current !== handle) return; // 已被更新的导入替换
          const legacyParsed = parsed as unknown as ParsedGcode;
          const reconcile = gcodeParser.reconcile(legacyParsed);
          clearMeshChain(); // 导入 toolpath 替换当前几何，网格摘要随之失效
          sim.loadImportedToolpath(legacyParsed, { name: file.name, sourceText, toolpath });
          /* 几何随导入固化：setGcode 触发重渲，参数面板锁定标签随 React 状态立即生效 */
          setGcode({ name: file.name, parsed: legacyParsed, reconcile, sha256 });
          setMachineLog(null);
          ui.toast(`已解析 ${parsed.totalLayers} 层真实 G-code · SHA-256 ${sha256.slice(0, 12)}…`, "ok");
          requestAuthority(file, options);
        })
        .catch((error: unknown) => {
          if (error instanceof GcodeImportError && error.code === "CANCELLED") return;
          console.error("[gcode-import]", error);
          ui.toast("G-code 导入失败：" + String((error as Error)?.message ?? error), "err");
        })
        .finally(() => {
          if (gcodeImportHandle.current === handle) {
            gcodeImportHandle.current = null;
            setGcodeImport(GCODE_IMPORT_IDLE);
          }
        });
    },
    [sim, ui, requestAuthority, clearMeshChain]
  );

  /* STL / 3MF 在 Worker 内读取、SHA-256、解析、归一化（Stage 9.3 前半，浏览器预览口径）；
     主线程只把 Transferable 顶点缓冲装配为可切片模型，随后进入既有的切片 → 仿真 → 导出链。 */
  const handleMeshFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      if (!/\.(stl|3mf)$/i.test(file.name || "")) return ui.toast("请选择 .stl / .3mf 文件", "err");
      if (file.size > MAX_MESH_BYTES)
        return ui.toast(`网格文件超过 ${Math.round(MAX_MESH_BYTES / 1024 / 1024)}MB，请先精简`, "err");
      if (printLocked(sim)) return ui.toast("打印中不可更换模型", "warn");
      meshImportHandle.current?.cancel();
      setMeshImport({ status: "parsing", phase: "read", progress: 0 });
      const handle = importMeshFile(file, (progress) =>
        setMeshImport({ status: "parsing", phase: progress.phase, progress: progress.progress })
      );
      meshImportHandle.current = handle;
      handle.promise
        .then(({ mesh: payload, sha256, via }) => {
          if (meshImportHandle.current !== handle) return; // 已被更新的导入替换
          clearGcodeChain();
          sim.setModel(createMeshModel(payload, { name: file.name }), true);
          meshAuthorityAbort.current?.abort();
          const controller = new AbortController();
          meshAuthorityAbort.current = controller;
          const enabled = meshAuthorityEnabled(import.meta.env);
          setMesh({
            name: file.name,
            sha256,
            via,
            mesh: payload,
            authority: { ...MESH_AUTHORITY_IDLE, status: enabled ? "running" : "idle" },
          });
          if (enabled) {
            requestMeshAuthority(file, sha256, import.meta.env, controller.signal)
              .then((result) => {
                if (controller.signal.aborted) return;
                setMesh((current) =>
                  current?.sha256 === sha256
                    ? { ...current, authority: { status: "done", result, error: null } }
                    : current
                );
              })
              .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                setMesh((current) =>
                  current?.sha256 === sha256
                    ? {
                        ...current,
                        authority: {
                          status: "error",
                          result: null,
                          error: error instanceof Error ? error.message : String(error),
                        },
                      }
                    : current
                );
              });
          }
          const size = `${payload.sizeMm.x.toFixed(1)} × ${payload.sizeMm.y.toFixed(1)} × ${payload.sizeMm.z.toFixed(1)} mm`;
          ui.toast(
            `已导入 ${payload.format.toUpperCase()} · ${payload.triangleCount.toLocaleString()} 面 · ${size} · SHA-256 ${sha256.slice(0, 12)}…`,
            "ok"
          );
          for (const warning of payload.warnings) ui.toast(warning, "warn");
        })
        .catch((error: unknown) => {
          if (error instanceof MeshImportError && error.code === "CANCELLED") return;
          console.error("[mesh-import]", error);
          ui.toast("网格导入失败：" + String((error as Error)?.message ?? error), "err");
        })
        .finally(() => {
          if (meshImportHandle.current === handle) {
            meshImportHandle.current = null;
            setMeshImport(MESH_IMPORT_IDLE);
          }
        });
    },
    [sim, ui, clearGcodeChain]
  );

  const handleMachineLogFile = useCallback(
    (file: File) => {
      if (!sim || !ui) return;
      const current = gcodeRef.current;
      if (!sim.importedToolpath || !current) return ui.toast("请先导入要复盘的 G-code", "warn");
      const { machineLog: machineLogService, timeCalibration, gcodeParser } = legacyImportServices();
      if (!/\.(json|csv)$/i.test(file.name || "")) return ui.toast("真机日志仅支持 JSON / CSV", "err");
      if (file.size > machineLogService.MAX_BYTES)
        return ui.toast(`真机日志超过 ${Math.round(machineLogService.MAX_BYTES / 1024 / 1024)}MB`, "err");
      machineLogReader.current?.abort();
      setMachineLog(null);
      const reader = new FileReader();
      machineLogReader.current = reader;
      const isCurrent = () =>
        machineLogReader.current === reader && gcodeRef.current === current && !!sim.importedToolpath;
      reader.onerror = () => {
        if (isCurrent()) {
          machineLogReader.current = null;
          ui.toast("真机日志读取失败", "err");
        }
      };
      reader.onload = () => {
        void (async () => {
          try {
            if (!isCurrent() || !(reader.result instanceof ArrayBuffer)) return;
            const bytes = reader.result;
            const sourceSha256 = await gcodeParser.sha256(bytes);
            if (!isCurrent()) return;
            const log = machineLogService.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
              name: file.name,
            });
            log.sourceSha256 = sourceSha256;
            const binding = machineLogService.verifyGcodeBinding(current.parsed, log);
            if (binding.status === "invalid" || binding.status === "unavailable" || binding.status === "mismatch") {
              throw new Error(binding.message);
            }
            log.gcodeBinding = binding;
            if (!binding.verified) log.warnings.push(binding.message);
            const comparison = machineLogService.compare(current.parsed, log);
            const observation =
              binding.verified &&
              log.actualTimeSec !== null &&
              log.actualTimeSec > 0 &&
              current.parsed.stats.timeSec > 0
                ? timeCalibration.observation(current.parsed, log)
                : null;
            const calibration = calibrationFor(current.parsed, log, true);
            setMachineLog({ log, comparison, observation, calibration, binding });
            ui.toast(`真机日志已接入：生成 ${comparison.length} 项计划/实测对比`, "ok");
          } catch (error) {
            if (!isCurrent()) return;
            console.error("[machine-log]", error);
            ui.toast("真机日志导入失败：" + String((error as Error)?.message ?? error), "err");
          } finally {
            if (machineLogReader.current === reader) machineLogReader.current = null;
          }
        })();
      };
      reader.readAsArrayBuffer(file);
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
            observation:
              previous.binding.verified &&
              previous.log.actualTimeSec !== null &&
              previous.log.actualTimeSec > 0 &&
              parsed.stats.timeSec > 0
                ? timeCalibration.observation(parsed, previous.log)
                : null,
            calibration: calibrationFor(parsed, previous.log, false),
          }
        : previous
    );
  }, [sim, calibrationFor]);

  return useMemo(
    () => ({
      image,
      gcode,
      gcodeImport,
      mesh,
      meshImport,
      machineLog,
      authority,
      handleImageFile,
      handleGcodeFile,
      handleMeshFile,
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
      gcodeImport,
      mesh,
      meshImport,
      machineLog,
      authority,
      handleImageFile,
      handleGcodeFile,
      handleMeshFile,
      handleMachineLogFile,
      handleProfileFile,
      handleCalibrationFile,
      updateImage,
      clearImportChain,
      refreshAfterMaterialChange,
    ]
  );
}
