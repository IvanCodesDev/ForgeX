import { useEffect, useReducer, useRef, type DragEvent, type ReactNode } from "react";
import {
  legacyImportServices,
  legacyUtil,
  type GcodeImportState,
  type LegacyEventBus,
  type LegacySim,
  type LegacyUi,
  type MachineLogState,
} from "../../../legacy/engine";
import { Slider } from "../../controls/Slider";
import type { GcodeImportPhase } from "../gcode-import";
import type { ImportAssets } from "../useImportAssets";

/* 内联 SVG 路径与旧实现一致（ui.js 的 ICONS / 内置模型图标）。 */
const ICON_UPLOAD = '<path d="M12 16V5m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>';
const ICON_LAYERS = '<path d="M3 8h18M3 12h18M3 16h18M3 20h18M3 4h18"/>';
const ICON_MOTION = '<path d="M4 17a8 8 0 0116 0"/><path d="M12 17l4.5-5.5"/><circle cx="12" cy="17" r="1.4"/>';
const BUILTIN_ICONS: Readonly<Record<string, string>> = {
  gear: '<circle cx="30" cy="23" r="12"/><circle cx="30" cy="23" r="4"/><path d="M30 7v4M30 35v4M14 23h4M42 23h4M18.7 11.7l2.8 2.8M38.5 31.5l2.8 2.8M41.3 11.7l-2.8 2.8M21.5 31.5l-2.8 2.8"/>',
  impeller:
    '<circle cx="30" cy="23" r="4.5"/><path d="M30 18.5C34 12 42 12 45 16M34.5 25c7 2 9.5 9 7 13M25.5 25c-7 2-9.5 9-7 13M25.5 21C19 17 19 9 23 6"/>',
  bracket: '<path d="M12 38h36v-7H26V10H12z"/><circle cx="19" cy="34.5" r="2.5"/><circle cx="40" cy="34.5" r="2.5"/>',
};

const RESLICE_DEBOUNCE_MS = 320;

interface PageContext {
  readonly sim: LegacySim;
  readonly ui: LegacyUi;
  readonly bus: LegacyEventBus;
  readonly assets: ImportAssets;
}

function printLocked(sim: LegacySim): boolean {
  return !["idle", "done"].includes(sim.state);
}

function UploadZone({
  id,
  icon,
  title,
  subtitle,
  onFile,
  onClick,
}: {
  readonly id?: string;
  readonly icon: string;
  readonly title: string;
  readonly subtitle: string;
  onFile(file: File): void;
  onClick(): void;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoneRef.current?.classList.remove("drag");
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  };
  return (
    <div
      ref={zoneRef}
      id={id}
      className="upload-zone"
      onClick={onClick}
      onDragOver={(event) => {
        event.preventDefault();
        zoneRef.current?.classList.add("drag");
      }}
      onDragLeave={() => zoneRef.current?.classList.remove("drag")}
      onDrop={drop}
    >
      <svg className="uz-ico" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: icon }} />
      <div className="uz-t1">{title}</div>
      <div className="uz-t2">{subtitle}</div>
    </div>
  );
}

function PrinterSection({ sim, ui, bump }: PageContext & { bump(): void }) {
  const { printers } = legacyImportServices();
  const locked = printLocked(sim);
  return (
    <>
      <div className="sec-label">打印机型</div>
      <div className={locked ? "model-grid locked" : "model-grid"}>
        {printers.list.map((printer) => (
          <div
            key={printer.id}
            className={sim.printer.ID === printer.id ? "model-card on" : "model-card"}
            onClick={() => {
              if (printLocked(sim)) return ui.toast("打印中不可切换机型", "warn");
              if (sim.printer.ID === printer.id) return;
              if (sim.setPrinterModel(printer.id)) {
                ui.toast(`已切换至「${printer.name}」（${printer.desc}）`, "ok");
                bump();
              }
            }}
          >
            <svg viewBox="0 0 60 46" dangerouslySetInnerHTML={{ __html: printer.icon }} />
            <div className="mc-name">{printer.name}</div>
            <div className="mc-dim">
              {printer.desc}
              {printer.community ? " · 社区" : ""}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ProfileSection() {
  const { profiles } = legacyImportServices();
  const communityCount =
    profiles.listMachines().filter((p) => p.community).length +
    profiles.listMaterials().filter((p) => p.community).length;
  return (
    <>
      <div className="sec-label">机器 / 材料 Profile</div>
      <div className="chip-row">
        <button
          type="button"
          className="btn btn-ghost"
          id="profile-upload"
          onClick={() => document.getElementById("profile-input")?.click()}
        >
          导入 Profile JSON
        </button>
        <a className="btn btn-ghost" href="contracts/profiles/example-bundle.json" target="_blank" rel="noopener">
          查看示例
        </a>
      </div>
      <div className="note">{`仅接受声明式 JSON 与已实现运动学，不执行社区代码。当前已载入 ${communityCount} 个社区 Profile。`}</div>
    </>
  );
}

function CalibrationSection() {
  const { calibrationRegistry, apiClient } = legacyImportServices();
  const models = calibrationRegistry.list();
  const active = models.filter((model) => model.status === "active").length;
  const sync = apiClient?.calibrationSync;
  return (
    <>
      <div className="sec-label">时间校准包</div>
      <div className="chip-row">
        <button
          type="button"
          className="btn btn-ghost"
          id="calibration-upload"
          onClick={() => document.getElementById("calibration-input")?.click()}
        >
          导入校准包 JSON
        </button>
        <a className="btn btn-ghost" href="contracts/calibration/example-bundle.json" target="_blank" rel="noopener">
          查看示例
        </a>
      </div>
      <div className="note">
        {`按机型、固件和材料精确匹配；合成模型不自动生效。当前 ${models.length} 个模型，${active} 个 active。` +
          (sync && sync.status === "ready" ? ` 服务端已审核目录 ${sync.count} 个 bundle。` : "")}
      </div>
    </>
  );
}

function BuiltinSection({ sim, ui, assets }: PageContext) {
  const locked = printLocked(sim);
  return (
    <>
      <div className="sec-label">内置工程模型</div>
      <div className="model-grid">
        {ui.builtins().map((model) => (
          <div
            key={model.id}
            className={sim.model && sim.model.id === model.id ? "model-card on" : "model-card"}
            onClick={() => {
              if (locked) return ui.toast("打印中不可更换模型", "warn");
              assets.clearImportChain();
              sim.setModel(model, true);
              ui.toast(`已载入「${model.name}」并完成切片`, "ok");
            }}
          >
            <svg viewBox="0 0 60 46" dangerouslySetInnerHTML={{ __html: BUILTIN_ICONS[model.id] ?? "" }} />
            <div className="mc-name">{model.name}</div>
            <div className="mc-dim">{model.dims}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function GcodeSummary({ gcode }: { readonly gcode: GcodeImportState }) {
  const { gcodeParser } = legacyImportServices();
  const { fmtHuman } = legacyUtil();
  const claims = gcode.parsed.claims ?? {};
  const value = (row: { unit: string }, v: number) =>
    row.unit === "秒" ? gcodeParser.fmtSec(v) : `${v.toFixed(row.unit === "g" ? 1 : 0)} ${row.unit}`;
  return (
    <div className="gcode-summary" id="gcode-summary">
      <div className="kv">
        <span className="k">文件</span>
        <span className="v">{gcode.name}</span>
      </div>
      <div className="kv">
        <span className="k">切片器</span>
        <span className="v">{claims.slicer || "未声明"}</span>
      </div>
      <div className="kv">
        <span className="k">解析结果</span>
        <span className="v hl">
          {`${gcode.parsed.totalLayers} 层 · ${gcode.parsed.stats.filamentM.toFixed(2)} m · ${fmtHuman(gcode.parsed.stats.timeSec)}`}
        </span>
      </div>
      {gcode.reconcile.length ? (
        gcode.reconcile.map((row) => (
          <div className="kv" key={row.name}>
            <span className="k">{row.name}</span>
            <span className={row.agrees ? "v hl" : "v warn"}>
              {`${value(row, row.claimed)} ↔ ${value(row, row.computed)} · ${Math.round(row.relDiff * 100)}%`}
            </span>
          </div>
        ))
      ) : (
        <div className="kv">
          <span className="k">对账</span>
          <span className="v">文件未提供时间/耗材声明</span>
        </div>
      )}
    </div>
  );
}

function MachineLogSummary({ state }: { readonly state: MachineLogState }) {
  const { gcodeParser } = legacyImportServices();
  const value = (row: { unit: string }, v: number) =>
    row.unit === "秒" ? gcodeParser.fmtSec(v) : `${v.toFixed(row.unit === "g" ? 1 : 0)} ${row.unit}`;
  const observation = state.observation;
  const calibration = state.calibration;
  return (
    <>
      <div className="machine-log-summary" id="machine-log-summary">
        <div className="kv">
          <span className="k">真机日志</span>
          <span className="v">{`${state.log.name} · ${state.log.status}`}</span>
        </div>
        {state.log.machineId ? (
          <div className="kv">
            <span className="k">设备 / 固件</span>
            <span className="v">{`${state.log.machineId} · ${state.log.firmware || "未声明"}`}</span>
          </div>
        ) : null}
        {state.comparison.length ? (
          state.comparison.map((row) => (
            <div className="kv" key={row.name}>
              <span className="k">{row.name}</span>
              <span className={row.agrees ? "v hl" : "v warn"}>
                {`${value(row, row.planned)} 计划 ↔ ${value(row, row.actual)} 实测 · ${Math.round(row.relDiff * 100)}%`}
              </span>
            </div>
          ))
        ) : (
          <div className="kv">
            <span className="k">对比</span>
            <span className="v">日志缺少可比较的任务汇总字段</span>
          </div>
        )}
        {observation ? (
          <div className="kv">
            <span className="k">单任务观测倍率</span>
            <span className="v">
              {`${observation.rawRatio.toFixed(2)}× · ${observation.deltaSec >= 0 ? "+" : "−"}${gcodeParser.fmtSec(Math.abs(observation.deltaSec))}`}
            </span>
          </div>
        ) : null}
        {calibration ? (
          <>
            <div className="kv">
              <span className="k">作用域校准</span>
              <span className="v hl">
                {`${calibration.model.id} r${calibration.model.bundleRevision} · ${gcodeParser.fmtSec(calibration.estimate.predictedTimeSec)}`}
              </span>
            </div>
            <div className="kv">
              <span className="k">holdout 区间</span>
              <span className="v">
                {`${gcodeParser.fmtSec(calibration.estimate.lowerTimeSec)} – ${gcodeParser.fmtSec(calibration.estimate.upperTimeSec)} · 漂移 ${calibration.drift.status}`}
              </span>
            </div>
          </>
        ) : null}
      </div>
      {observation ? <div className="note">{observation.note}</div> : null}
      {calibration ? (
        <div className="note">{calibration.drift.note + " 校准值只适用于该模型声明的机型、固件和材料范围。"}</div>
      ) : state.log.machineId && state.log.firmware ? (
        <div className="note">未找到通过准入且未漂移的精确作用域校准模型；当前仍保留原始 G-code 估算与实测对比。</div>
      ) : null}
      {state.log.warnings.map((warning) => (
        <div className="note" key={warning}>{`⚠ ${warning}`}</div>
      ))}
    </>
  );
}

/** C# 权威摘要：只在 dotnet 模式且完整校验通过后呈现；失败保留浏览器解析并明示。 */
function AuthoritySummary({ ctx }: { readonly ctx: PageContext }) {
  const { fmtHuman } = legacyUtil();
  const authority = ctx.assets.authority;
  if (authority.mode !== "dotnet" || authority.status === "idle") return null;
  if (authority.status === "running") {
    return (
      <div className="note" data-authority="running">
        C# 权威分析进行中：{authority.phase || "queued"} · {(authority.progress * 100).toFixed(0)}%
        {authority.jobId ? ` · 作业 ${authority.jobId.slice(0, 12)}…` : ""}
      </div>
    );
  }
  if (authority.status === "error") {
    return (
      <div className="note" data-authority="error">
        ⚠ C# 权威分析失败（{authority.error}）；以下摘要仍为浏览器解析结果。
      </div>
    );
  }
  const result = authority.result;
  if (!result) return null;
  return (
    <div className="gcode-summary" id="authority-summary" data-authority="done">
      <div className="kv">
        <span className="k">权威引擎</span>
        <span className="v hl">{`C# ${result.engine.version} · ${result.engine.source}`}</span>
      </div>
      <div className="kv">
        <span className="k">权威解析</span>
        <span className="v hl">
          {`${result.summary.totalLayers} 层 · ${result.summary.filamentLengthM.toFixed(2)} m · ${fmtHuman(result.summary.estimatedTimeSeconds)}`}
        </span>
      </div>
      <div className="kv">
        <span className="k">耗材成本</span>
        <span className="v">
          {result.material.priceCnyPerKg > 0
            ? `¥${result.material.materialCostCny.toFixed(2)}（${result.material.filamentMassG.toFixed(1)} g）`
            : `${result.summary.filamentMassG.toFixed(1)} g · 未配置材料单价`}
        </span>
      </div>
      <div className="kv">
        <span className="k">风险评估</span>
        <span className={result.risk.level === "high" ? "v warn" : "v"}>
          {`${result.risk.level} · ${result.risk.score}/100 · ${result.risk.findings.length} 项发现`}
        </span>
      </div>
    </div>
  );
}

/** Worker 解析阶段 → 用户可读文案（浏览器解析在后台线程进行，主界面不冻结） */
const GCODE_PHASE_LABEL: Readonly<Record<GcodeImportPhase, string>> = {
  read: "读取文件",
  hash: "SHA-256 校验",
  parse: "流式解析",
  pack: "打包路径",
  rebuild: "装配结果",
};

function GcodeSection(ctx: PageContext) {
  const { sim, assets } = ctx;
  const gcode = assets.gcode;
  const importing = assets.gcodeImport;
  return (
    <>
      <div className="sec-label">真实 G-code · 导入复盘</div>
      <UploadZone
        id="gcode-zone"
        icon={ICON_LAYERS}
        title="拖拽 G-code 到此处，或点击选择"
        subtitle="解析真实挤出路径 · 3D 逐层回放 · 与切片器自报时间/耗材对账"
        onClick={() => document.getElementById("gcode-input")?.click()}
        onFile={assets.handleGcodeFile}
      />
      {importing.status === "parsing" ? (
        <div className="note" data-gcode-import={importing.phase ?? "read"}>
          {`正在后台解析 G-code（界面保持可交互）：${GCODE_PHASE_LABEL[importing.phase ?? "read"]} · ${Math.round(
            importing.progress * 100
          )}%`}
        </div>
      ) : null}
      {gcode && sim.importedToolpath ? (
        <>
          <GcodeSummary gcode={gcode} />
          <AuthoritySummary ctx={ctx} />
          {gcode.parsed.warnings.map((warning) => (
            <div className="note" key={warning}>{`⚠ ${warning}`}</div>
          ))}
          <UploadZone
            id="machine-log-zone"
            icon={ICON_MOTION}
            title="追加真机任务日志"
            subtitle="JSON / CSV · 将实际时长、耗材和完成层数与当前 G-code 计划并列"
            onClick={() => document.getElementById("machine-log-input")?.click()}
            onFile={assets.handleMachineLogFile}
          />
          {assets.machineLog ? <MachineLogSummary state={assets.machineLog} /> : null}
        </>
      ) : null}
    </>
  );
}

function ImageSection({ assets }: PageContext) {
  const image = assets.image;
  return (
    <>
      <div className="sec-label">图片 · 生成3D模型</div>
      <UploadZone
        icon={ICON_UPLOAD}
        title="拖拽图片到此处，或点击选择"
        subtitle="PNG / JPG / WebP · 亮度转浮雕高度，或按剪影轮廓挤出"
        onClick={() => document.getElementById("file-input")?.click()}
        onFile={assets.handleImageFile}
      />
      {image.img ? (
        <>
          <div className="img-preview">
            <img src={image.img.src} alt="" />
            <div>
              <div className="ip-name">{image.name}</div>
              <div className="ip-meta">{`${image.img.naturalWidth} × ${image.img.naturalHeight} px`}</div>
            </div>
          </div>
          <div className="chip-row">
            {(
              [
                ["relief", "浮雕模式"],
                ["silhouette", "剪影挤出"],
              ] as const
            ).map(([mode, label]) => (
              <div
                key={mode}
                className={image.mode === mode ? "chip on" : "chip"}
                onClick={() => assets.updateImage({ mode })}
              >
                {label}
              </div>
            ))}
          </div>
          <Slider
            label="成品宽度"
            min={40}
            max={140}
            step={5}
            unit="mm"
            dec={0}
            value={image.widthMm}
            onInput={(widthMm) => assets.updateImage({ widthMm }, { debounce: true })}
          />
          <Slider
            label="最大高度"
            min={3}
            max={20}
            step={0.5}
            unit="mm"
            dec={1}
            value={image.maxH}
            onInput={(maxH) => assets.updateImage({ maxH }, { debounce: true })}
          />
          <div className="prow">
            <span className="p-lab">明暗反转</span>
            <label className="sw">
              <input
                type="checkbox"
                checked={image.invert}
                onChange={(event) => assets.updateImage({ invert: event.target.checked })}
              />
              <span className="tr" />
            </label>
            <span className="p-val" />
          </div>
        </>
      ) : null}
    </>
  );
}

function ModelAndExportSection(ctx: PageContext & { bump(): void }): ReactNode {
  const { sim, ui, bump } = ctx;
  const { fmtHuman } = legacyUtil();
  const model = sim.model;
  if (!model) return null;

  const stats = sim.slice ? sim.slice.stats : null;
  const imported = !!sim.importedToolpath;
  const exportChips: ReadonlyArray<readonly [string, string, string]> = imported
    ? [
        ["source-gcode", "原始 G-code", "下载未经改写的导入源文件"],
        ["gcode", "标准化副本", "按解析后的逐层路径重新生成 Marlin 风格 G-code"],
      ]
    : [
        ["stl", "STL 网格", "二进制 STL · 含缩放 · Z-up（可直接进 Cura/Prusa 切片）"],
        ["obj", "OBJ 网格", "ASCII OBJ · 通用三维格式（建模/渲染软件可开）"],
        ["gcode", "G-code", "由真实切片路径生成（与打印动画同源）· Marlin 风格"],
      ];

  const locked = printLocked(sim);
  const transform = sim.tf;
  const bedHalf = (sim.printer.BED_SIZE || 256) / 2;
  const buildZ = sim.printer.BUILD_VOLUME ? sim.printer.BUILD_VOLUME.z : 256;
  const radius = model.footprintR * transform.scale;
  const outward = Math.max(Math.abs(transform.offX), Math.abs(transform.offY)) + radius;
  const over = outward > bedHalf;
  const height = model.height * transform.scale;

  return (
    <>
      <div className="sec-label">当前模型</div>
      <div>
        <div className="kv">
          <span className="k">名称</span>
          <span className="v">{model.name}</span>
        </div>
        {stats ? (
          <>
            <div className="kv">
              <span className="k">预估耗材</span>
              <span className="v">{`${(stats.volumeCm3 * sim.material.densityG).toFixed(1)} g · ${stats.filamentM.toFixed(2)} m`}</span>
            </div>
            <div className="kv">
              <span className="k">预估时长</span>
              <span className="v hl">{fmtHuman(sim.estimateTotal())}</span>
            </div>
          </>
        ) : null}
      </div>

      <div className="sec-label">导出下载</div>
      <div className="chip-row">
        {exportChips.map(([format, label, tip]) => (
          <div key={format} className="chip" title={tip} onClick={() => ui.exportModel(format)}>
            {label}
          </div>
        ))}
      </div>
      {imported ? (
        <div className="note">
          导入任务可逐层预览和仿真回放；它不模拟固件宏、压力提前、输入整形或真实加速度，因此对账值是可解释估算，不冒充机台实测。
        </div>
      ) : (
        <>
          <div className="note">
            STL / OBJ 为成品网格（应用当前缩放）；G-code 包含温度、调平、逐层路径与挤出量，参数改动后重新切片即生效。
          </div>

          <div className="sec-label">摆放与变换</div>
          <TransformSliders ctx={ctx} locked={locked} bump={bump} />
          <div className="prow">
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => {
                if (printLocked(sim)) return ui.toast("打印中不可调整摆放", "warn");
                sim.updateTf({ offX: 0, offY: 0, rotZ: 0 });
                bump();
                if (!printLocked(sim)) sim.reslice();
              }}
            >
              居中复位
            </button>
          </div>
          <div>
            <div className="kv">
              <span className="k">成品尺寸</span>
              <span className="v">{`Ø${(radius * 2).toFixed(0)} × 高 ${height.toFixed(1)} mm ${height > buildZ ? "⚠" : ""}`}</span>
            </div>
            <div className="kv">
              <span className="k">平台边界</span>
              <span className={over ? "v warn" : "v hl"}>{over ? "超出打印区域" : "安全区内"}</span>
            </div>
          </div>
          {locked ? <div className="note">打印进行中，模型与摆放已锁定。</div> : null}
        </>
      )}
    </>
  );
}

function TransformSliders({ ctx, locked, bump }: { ctx: PageContext; locked: boolean; bump(): void }) {
  const { sim } = ctx;
  const timer = useRef<number | null>(null);
  const resliceDebounced = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!printLocked(sim)) sim.reslice();
    }, RESLICE_DEBOUNCE_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  const apply = (patch: Partial<{ scale: number; rotZ: number; offX: number; offY: number }>) => {
    sim.updateTf(patch);
    bump();
    resliceDebounced();
  };
  const transform = sim.tf;
  return (
    <>
      <Slider
        label="缩放"
        min={0.5}
        max={2.2}
        step={0.05}
        unit="×"
        dec={2}
        locked={locked}
        value={transform.scale}
        onInput={(scale) => apply({ scale })}
      />
      <Slider
        label="旋转 Z"
        min={-180}
        max={180}
        step={5}
        unit="°"
        dec={0}
        locked={locked}
        value={transform.rotZ}
        onInput={(rotZ) => apply({ rotZ })}
      />
      <Slider
        label="平移 X"
        min={-100}
        max={100}
        step={1}
        unit="mm"
        dec={0}
        locked={locked}
        value={transform.offX}
        onInput={(offX) => apply({ offX })}
      />
      <Slider
        label="平移 Y"
        min={-100}
        max={100}
        step={1}
        unit="mm"
        dec={0}
        locked={locked}
        value={transform.offY}
        onInput={(offY) => apply({ offY })}
      />
    </>
  );
}

interface ImportPageProps {
  readonly sim: LegacySim;
  readonly ui: LegacyUi;
  readonly bus: LegacyEventBus;
  readonly assets: ImportAssets;
}

export function ImportPage({ sim, ui, bus, assets }: ImportPageProps) {
  const [, bump] = useReducer((version: number) => version + 1, 0);

  /* 引擎侧变化（切片完成 / 状态机 / 校准同步触发的整页刷新请求）驱动回读重渲。 */
  useEffect(
    () =>
      bus.on("ctx-page-refresh", (id) => {
        if (id === "import") bump();
      }),
    [bus]
  );
  useEffect(() => bus.on("sliced", bump), [bus]);
  useEffect(() => bus.on("state", bump), [bus]);

  const ctx: PageContext = { sim, ui, bus, assets };

  return (
    <>
      <PrinterSection {...ctx} bump={bump} />
      <ProfileSection />
      <CalibrationSection />
      <BuiltinSection {...ctx} />
      <GcodeSection {...ctx} />
      <ImageSection {...ctx} />
      <ModelAndExportSection {...ctx} bump={bump} />
    </>
  );
}
