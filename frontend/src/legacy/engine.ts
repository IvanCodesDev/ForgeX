/* 引擎接入边界：宿主（React 工作台）消费 TS 引擎的唯一入口。
   引擎已全量自 js/*.js 迁移为 frontend/src/engine/*.ts（THREE 经 npm 包引入，
   r152 与旧入口同版），模块间通过 ESM 直接引用，不再存在全局桥或经典脚本。
   渲染与仿真与旧入口(/)是同一套算法的迁移产物，视觉与数值结果同源，不存在引擎漂移。

   Legacy* 类型命名保留自迁移期，语义是「与旧入口同源的引擎 API 的收窄视图」：
   宿主只透传与读取少量展示字段，其余结构保持 opaque，不复制引擎内部形状。 */
import { FXApiClientCompat } from "../engine/api-client";
import * as calibrationRegistryModule from "../engine/calibration-registry";
import * as fleetViewModule from "../engine/fleet-view";
import * as gcodeParserModule from "../engine/gcode-parser";
import { FXInsightDataCompat } from "../engine/insight-data";
import * as insightEngineModule from "../engine/insight-engine";
import * as machineLogModule from "../engine/machine-log";
import * as modelsModule from "../engine/models";
import { FXPrinters } from "../engine/printer3d";
import * as profilesModule from "../engine/profile-registry";
import { FXScene } from "../engine/scene";
import { FXSim } from "../engine/sim";
import * as statsModule from "../engine/stats-kernel";
import * as timeCalibrationModule from "../engine/time-calibration";
import * as utilModule from "../engine/util";

export interface LegacyEventBus {
  /** 返回取消订阅函数。 */
  on(event: string, handler: (payload?: unknown) => void): () => void;
  emit(event: string, payload?: unknown): void;
}

export interface LegacyScene {
  onTick: ((dt: number, t: number) => void) | null;
  setCameraPreset(preset: string): void;
  /** 机群视图（洞察结论 → 3D 空间定位）。 */
  readonly fleet?: {
    build(machines: unknown[]): { highlight(id: string): { show(v: boolean): void } };
    focusTarget(id: string): { pos: unknown; target: unknown };
    show(v: boolean): { clear(): void };
  };
  readonly orbit?: { setView(pos: unknown, target: unknown, animate: boolean): void };
  readonly printer?: {
    readonly group: { visible: boolean };
    readonly stateLED: { readonly material: { readonly color: { getHex(): number } } };
    setStateLED(hex: number): void;
    readonly MODEL_TAG?: string;
    readonly MODEL_NAME?: string;
  };
  dispose?: () => void;
}

/** 仿真状态机取值，与引擎 sim 的 `state` 字段一一对应。 */
export type SimState = "idle" | "heat" | "level" | "print" | "pause" | "done" | "fault";

export type ToolpathType = "perimeter" | "solid" | "infill" | "support" | "skirt";

export interface SliceLayer {
  readonly z: number;
  readonly paths: ReadonlyArray<{ readonly type: ToolpathType; readonly pts: ReadonlyArray<{ x: number; y: number }> }>;
}

export interface SliceResult {
  readonly totalLayers: number;
  readonly layers: ReadonlyArray<SliceLayer>;
  readonly stats: { readonly extLenMm: number; readonly travelMm: number; readonly volumeCm3: number };
}

/** 9 点实测拟合出的 5×5 补偿网格（床面误差场为机台固有、确定性）。 */
export interface LevelMesh {
  readonly grid: ReadonlyArray<ReadonlyArray<number>>;
  readonly max: number;
  readonly samples?: ReadonlyArray<number>;
  readonly at: Date;
}

export interface SimSettings {
  readonly speed: number;
  readonly layerHeight: number;
  readonly supportEnabled: boolean;
  readonly zOffset: number;
  readonly material: string;
  readonly perimeters: number;
  readonly solidLayers: number;
  readonly infillDensity: number;
  readonly infillPattern: string;
  readonly nozzleTemp: number;
  readonly bedTemp: number;
  readonly travelSpeed: number;
  readonly retraction: number;
  readonly fanSpeed: number;
  readonly supportSpacing: number;
  /** 外观颜色索引：旧实现直接赋值（不经 updateSettings），保持可写。 */
  colorIdx: number;
}

export interface QualityCheck {
  readonly name: string;
  readonly score: number;
  readonly level: string;
  readonly tip: string;
}

/* —— 模型页与文件接入涉及的引擎数据 ——
   parsed G-code / 真机日志 / 校准模型在宿主侧只透传与读取少量展示字段，
   其余结构保持 opaque，不复制引擎内部形状。 */

export interface BuiltinModel {
  readonly id: string;
  readonly name: string;
  readonly dims: string;
}

export interface PrinterDescriptor {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly icon: string;
  readonly community?: boolean;
}

export interface ReconcileRow {
  readonly name: string;
  readonly unit: string;
  readonly claimed: number;
  readonly computed: number;
  readonly agrees: boolean;
  readonly relDiff: number;
}

export interface ParsedGcode {
  sha256?: string;
  readonly totalLayers: number;
  readonly stats: { readonly filamentM: number; readonly timeSec: number };
  readonly claims?: { readonly slicer?: string };
  readonly warnings: ReadonlyArray<string>;
}

export interface MachineLogComparisonRow {
  readonly name: string;
  readonly unit: string;
  readonly planned: number;
  readonly actual: number;
  readonly agrees: boolean;
  readonly relDiff: number;
}

export interface MachineLogRecord {
  readonly name: string;
  readonly status: string;
  readonly machineId?: string;
  readonly firmware?: string;
  readonly jobId?: string;
  readonly warnings: string[];
  gcodeBinding?: GcodeBinding;
}

export interface GcodeBinding {
  readonly status: string;
  readonly message: string;
  readonly verified: boolean;
}

export interface CalibrationEstimate {
  readonly predictedTimeSec: number;
  readonly lowerTimeSec: number;
  readonly upperTimeSec: number;
}

export interface CalibrationModel {
  readonly id: string;
  readonly bundleRevision: number;
  readonly status: string;
}

export interface CalibrationInfo {
  readonly model: CalibrationModel;
  readonly estimate: CalibrationEstimate;
  readonly drift: { readonly status: string; readonly note: string };
}

export interface TimeObservation {
  readonly rawRatio: number;
  readonly deltaSec: number;
  readonly note: string;
}

export interface GcodeImportState {
  readonly name: string;
  readonly parsed: ParsedGcode;
  readonly reconcile: ReadonlyArray<ReconcileRow>;
  readonly sha256: string;
}

export interface MachineLogState {
  readonly log: MachineLogRecord;
  readonly comparison: ReadonlyArray<MachineLogComparisonRow>;
  readonly observation: TimeObservation | null;
  readonly calibration: CalibrationInfo | null;
  readonly binding: GcodeBinding;
}

export interface ImageModelState {
  readonly img: HTMLImageElement | null;
  readonly name: string;
  readonly mode: "relief" | "silhouette";
  readonly widthMm: number;
  readonly maxH: number;
  readonly invert: boolean;
  readonly threshold: number;
}

/* —— 智造洞察涉及的引擎数据 —— */

export interface DatasetProvenance {
  readonly synthetic?: boolean;
  readonly badge?: string;
  readonly note?: string;
  readonly source?: string;
}

export interface InsightDataset {
  readonly label: string;
  readonly rows: unknown[];
  readonly provenance?: DatasetProvenance;
}

export interface InsightStore {
  readonly sets: Readonly<Record<string, InsightDataset>>;
  readonly active: string;
  use(key: string): void;
  rows(): unknown[];
  provenance(): DatasetProvenance;
  setUpload(rows: unknown[]): void;
  addSimRecord(record: unknown): void;
}

export interface InsightChartItem {
  readonly label: string;
  readonly value: number;
  readonly ciLo?: number;
  readonly ciHi?: number;
  readonly weak?: boolean;
}

export interface InsightChart {
  readonly kind: "bar-rate" | "bar" | "line";
  readonly title?: string;
  readonly items: ReadonlyArray<InsightChartItem>;
}

export interface InsightEvidence {
  readonly claim: string;
  readonly method?: string;
  readonly n?: number;
  readonly statistic?: number;
  readonly ci95?: readonly [number, number];
  readonly pValue?: number;
}

export interface InsightReport {
  title?: string;
  engine?: string;
  rowCount?: number;
  elapsedMs?: number;
  provenance?: DatasetProvenance;
  fallbackFrom?: string;
  verdict?: string;
  confidence?: string;
  chart?: InsightChart;
  sections?: ReadonlyArray<{ readonly h: string; readonly lines?: ReadonlyArray<string> }>;
  evidence?: ReadonlyArray<InsightEvidence>;
  highlight?: { readonly type: string; readonly id: string };
  taskId?: string;
}

export interface InsightKpis {
  readonly total: number;
  readonly yield: number;
  readonly avgCostFen: number;
  readonly dateRange?: { readonly label: string } | null;
  readonly worstMachine?: { readonly id: string; readonly failRate: number; readonly n: number } | null;
  readonly topReason?: { readonly name: string } | null;
}

export interface FleetMachineStatus {
  readonly trustworthy: boolean;
}

/** 打印完成后由全程运行遥测生成的实测质量报告。 */
export interface QualityReport {
  readonly score: number;
  readonly grade: string;
  readonly elapsed: number;
  readonly usedG: number;
  readonly at: Date;
  readonly checks: ReadonlyArray<QualityCheck>;
}

export interface LegacySim {
  state: SimState;
  simMult: number;
  progress: number;
  layerIdx: number;
  machineElapsed: number;
  currentAction: string;
  usedG: number;
  usedLenMm: number;
  spoolTotalG: number;
  nozzleNow: number;
  bedNow: number;
  readonly nozzleT: { target: number };
  readonly bedT: { target: number };
  readonly headPos: { x: number; y: number };
  readonly settings: SimSettings;
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly footprintR: number;
    readonly height: number;
    readonly needSupport?: boolean;
  } | null;
  readonly slice: (SliceResult & { readonly stats: { readonly filamentM: number } }) | null;
  readonly levelMesh: LevelMesh | null;
  readonly lastQuality: QualityReport | null;
  readonly importedToolpath: { readonly sourceText?: string } | null;
  readonly material: { readonly densityG: number };
  readonly partColor: number;
  readonly tf: { readonly scale: number; readonly rotZ: number; readonly offX: number; readonly offY: number };
  readonly printer: {
    readonly ID?: string;
    readonly KIN_TAG?: string;
    readonly MODEL_NAME?: string;
    BED_SIZE?: number;
    readonly BUILD_VOLUME?: { readonly z: number };
    hideSlicePreview(): void;
    showSlicePreview(layer: SliceLayer, colors: Readonly<Record<ToolpathType, number>>): void;
    setFilamentColor(hex: number): void;
    attachToolpath(slice: SliceResult, partColor: number): void;
    showGhost(v: boolean): void;
  };
  setPrinterModel(id: string): boolean;
  applyMaterial(materialKey: string): void;
  injectFault(kind: string): void;
  updateTf(patch: Partial<{ scale: number; rotZ: number; offX: number; offY: number }>): void;
  reslice(): void;
  loadImportedToolpath(parsed: ParsedGcode, meta: { name: string; sourceText: string }): void;
  estimateRemaining(): number;
  estimateTotal(): number;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  runLeveling(): void;
  /** 几何参数在打印中/G-code 固化时会被引擎拒绝，调用后应回读 settings 以自动回弹。 */
  updateSettings(patch: Partial<Record<string, number | string | boolean>>): void;
  tick(dt: number, t: number): void;
  setModel(model: unknown, slice?: boolean): void;
  log(level: string, message: string): void;
  dispose?: () => void;
}

/** 宿主 UI 适配层的对外契约（实现见 workbench/workbench-ui.ts）。 */
export interface LegacyUi {
  currentNav: string;
  renderCtx(nav: string): void;
  toast(message: string, kind?: string): void;
  confirmAction(title: string, text: string, onOk: () => void): void;
  exportModel(format: string): void;
  builtins(): BuiltinModel[];
  dispose?: () => void;
}

export interface LegacyUtil {
  EventBus: new () => LegacyEventBus;
  fmtDuration(seconds: number): string;
  fmtClockAfter(seconds: number): string;
  fmtHuman(seconds: number): string;
  clamp(value: number, min: number, max: number): number;
  lerp(a: number, b: number, t: number): number;
  nowHMS(): string;
}

/** FXSim 兼具实例构造与纯函数命名空间：computeQuality 是打印前预估的静态入口。 */
type LegacySimConstructor = (new (scene: LegacyScene, bus: LegacyEventBus) => LegacySim) & {
  computeQuality(settings: SimSettings, model: unknown): QualityCheck[];
  MATERIALS: Readonly<Record<string, unknown>>;
  COLORS: ReadonlyArray<{ readonly name: string; readonly hex: number }>;
};

/* —— 引擎服务的收窄接口（与迁移前经全局消费的形状一致） —— */

export interface ProfilesService {
  syncCostProfile(): void;
  listMachines(): ReadonlyArray<{ readonly community?: boolean }>;
  listMaterials(): ReadonlyArray<{ readonly community?: boolean }>;
  importBundle(bundle: unknown): { machines: unknown[]; materials: unknown[] };
}

export interface ApiClientService {
  probe(): Promise<boolean>;
  pullCalibrations(): Promise<unknown[]>;
  calibrationSync?: { readonly status: string; readonly count: number };
  readonly available?: boolean;
  readonly capabilities?: { readonly ai?: boolean } | null;
  readonly providerLabel?: string;
  uploadDatasource(csv: string, name: string, provenance: unknown): Promise<{ datasourceId: string }>;
  analyze(question: string, datasourceId: string): Promise<{ taskId: string }>;
  stream(
    taskId: string,
    onEvent: (ev: { message?: string; stage?: string; progress?: number }) => void,
    onDone: () => void,
    onError: (err: Error) => void
  ): void;
  result(taskId: string): Promise<InsightReport>;
  share(taskId: string): Promise<{ publicUrl: string }>;
  uploadKnowledge(name: string, text: string): Promise<{ retrievalEnabled?: boolean; note?: string }>;
  searchKnowledge(query: string): Promise<{ hits: Array<{ score: number; text: string }> }>;
}

export interface CalibrationRegistryService {
  MAX_BYTES: number;
  list(): ReadonlyArray<{ readonly status: string }>;
  importBundle(bundle: unknown): { id: string; revision: number; models: unknown[] };
  match(scope: {
    machineId?: string | undefined;
    firmware?: string | undefined;
    material: string;
  }): CalibrationModel | null;
  estimate(model: CalibrationModel, timeSec: number): CalibrationEstimate;
  recordObservation(model: CalibrationModel, observation: unknown): { status: string; note: string };
  drift(model: CalibrationModel): { status: string; note: string };
}

export interface PrintersCatalog {
  readonly list: ReadonlyArray<PrinterDescriptor>;
}

export interface ModelsService {
  createBuiltins(): BuiltinModel[];
  fromImage(
    image: HTMLImageElement,
    options: { mode: string; widthMm: number; maxH: number; invert: boolean; threshold: number; name: string }
  ): unknown;
}

export interface GcodeParserService {
  MAX_BYTES: number;
  sha256(buffer: ArrayBuffer): Promise<string>;
  parse(text: string, options: { densityG: number; bedSize: number; origin: string }): ParsedGcode;
  reconcile(parsed: ParsedGcode): ReconcileRow[];
  fmtSec(seconds: number): string;
}

export interface MachineLogService {
  MAX_BYTES: number;
  parse(text: string, meta: { name: string }): MachineLogRecord;
  verifyGcodeBinding(parsed: ParsedGcode, log: MachineLogRecord): GcodeBinding;
  compare(parsed: ParsedGcode, log: MachineLogRecord): MachineLogComparisonRow[];
}

export interface TimeCalibrationService {
  observation(parsed: ParsedGcode, log: MachineLogRecord): TimeObservation | null;
  fromPair(
    parsed: ParsedGcode,
    log: MachineLogRecord,
    meta: { id?: string | undefined; machineId?: string | undefined; firmware?: string | undefined }
  ): unknown;
}

export interface InsightDataService {
  Store: new (bus: LegacyEventBus) => InsightStore;
  parseCsv(text: string): { rows: unknown[]; errors: string[] };
  toCsv(rows: unknown[]): string;
  downloadCsv(rows: unknown[], name: string): void;
  normalizeFault(fault: unknown): string;
  recordFromSim(sim: LegacySim, status: string, reason: string): { machine_id: string };
}

export interface InsightEngineService {
  MIN_SAMPLE: number;
  analyze(question: string, rows: unknown[], options: { provenance: DatasetProvenance }): InsightReport;
  kpis(rows: unknown[]): InsightKpis;
}

export interface FleetViewService {
  fromChartItems(items: ReadonlyArray<InsightChartItem>, targetId: string): Array<{ status: FleetMachineStatus }>;
}

export interface StatsService {
  fmtP(p: number): string;
}

/* —— 直接 import 的引擎模块 → 收窄视图（cast 集中在此，宿主侧零 cast） —— */

const simConstructor = FXSim as unknown as LegacySimConstructor;
const utilService = utilModule as unknown as LegacyUtil;

const importServices = {
  printers: FXPrinters as unknown as PrintersCatalog,
  models: modelsModule as unknown as ModelsService,
  gcodeParser: gcodeParserModule as unknown as GcodeParserService,
  machineLog: machineLogModule as unknown as MachineLogService,
  timeCalibration: timeCalibrationModule as unknown as TimeCalibrationService,
  calibrationRegistry: calibrationRegistryModule as unknown as CalibrationRegistryService,
  profiles: profilesModule as unknown as ProfilesService,
  apiClient: FXApiClientCompat as unknown as ApiClientService,
} as const;

const insightServices = {
  insightData: FXInsightDataCompat as unknown as InsightDataService,
  insightEngine: insightEngineModule as unknown as InsightEngineService,
  apiClient: FXApiClientCompat as unknown as ApiClientService,
  fleetView: fleetViewModule as unknown as FleetViewService,
  stats: statsModule as unknown as StatsService,
} as const;

/** 智造洞察依赖的引擎数据与统计命名空间。 */
export function legacyInsightServices() {
  return insightServices;
}

/** 模型页与文件接入用到的引擎纯逻辑命名空间。 */
export function legacyImportServices() {
  return importServices;
}

/** 装配渲染场景、事件总线与仿真引擎（与旧入口 js/main.js 的 boot 顺序一致）。 */
export function createEngine(canvas: HTMLCanvasElement): { fx: LegacyScene; bus: LegacyEventBus; sim: LegacySim } {
  const fx = new FXScene(canvas) as unknown as LegacyScene;
  const bus = new utilModule.EventBus();
  const sim = new simConstructor(fx, bus);
  return { fx, bus, sim };
}

/** 控制台调试句柄，与旧入口的 window.FX 一致。 */
export function exposeDebugHandle(handle: unknown): void {
  (globalThis as { FX?: unknown }).FX = handle;
}

/** 打印前参数预估：与旧质量页同一纯函数，随参数实时推导。 */
export function legacyComputeQuality(settings: SimSettings, model: unknown): QualityCheck[] {
  return simConstructor.computeQuality(settings, model);
}

/** 材料与外观颜色目录（引擎注册表引用，社区 Profile 导入后即时反映）。 */
export function legacyMaterialCatalog() {
  return { materialKeys: Object.keys(simConstructor.MATERIALS), colors: simConstructor.COLORS };
}

/** 时长与时钟格式化沿用同一实现，保证两个入口的文案逐字一致。 */
export function legacyUtil(): LegacyUtil {
  return utilService;
}
