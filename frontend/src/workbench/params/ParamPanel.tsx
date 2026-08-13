import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { legacyMaterialCatalog, type LegacyEventBus, type LegacySim, type LegacyUi } from "../../legacy/engine";
import { Slider } from "../controls/Slider";
import type { ImportAssets } from "../workflow/useImportAssets";

/* 组头图标与预设清单与旧实现一致（ui.js 的 ICONS / PRESETS）。 */
const GROUP_ICONS: Readonly<Record<string, string>> = {
  preset: '<path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/>',
  material: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  layers: '<path d="M3 8h18M3 12h18M3 16h18M3 20h18M3 4h18"/>',
  infill: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8"/>',
  temp: '<path d="M10 4a2 2 0 014 0v9a4.5 4.5 0 11-4 0z"/><path d="M12 9v6"/>',
  motion: '<path d="M4 17a8 8 0 0116 0"/><path d="M12 17l4.5-5.5"/><circle cx="12" cy="17" r="1.4"/>',
  fan: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.8C12 5 9 3.5 6.5 5c1.8 1 2.6 3 3.2 5.4M14.2 12c4.8 0 6.3-3 4.8-5.5-1 1.8-3 2.6-5.4 3.2M12 14.2c0 4.8 3 6.3 5.5 4.8-1.8-1-2.6-3-3.2-5.4M9.8 12c-4.8 0-6.3 3-4.8 5.5 1-1.8 3-2.6 5.4-3.2"/>',
  support: '<path d="M4 20h16M6 20V8m4 12V8m4 12V8m4 12V8"/><path d="M4 8h16l-2-4H6z"/>',
};

const PRESETS = [
  { name: "精细", desc: "0.12mm · 25% · 80mm/s", patch: { layerHeight: 0.12, infillDensity: 0.25, speed: 80 } },
  { name: "标准", desc: "0.20mm · 18% · 120mm/s", patch: { layerHeight: 0.2, infillDensity: 0.18, speed: 120 } },
  { name: "草稿", desc: "0.28mm · 10% · 220mm/s", patch: { layerHeight: 0.28, infillDensity: 0.1, speed: 220 } },
  {
    name: "强度",
    desc: "0.20mm · 45% · 4圈周界",
    patch: { layerHeight: 0.2, infillDensity: 0.45, speed: 100, perimeters: 4 },
  },
] as const;

const INFILL_PATTERNS = ["斜线网格", "直线", "蜂窝"] as const;
/** 参数触碰后质量页预估的刷新防抖，与旧 _onParamTouched 一致。 */
const QUALITY_REFRESH_DEBOUNCE_MS = 350;

function PGroup({ icon, title, hint, children }: { icon: string; title: string; hint: string; children: ReactNode }) {
  return (
    <div className="pgroup">
      <div className="pg-head">
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          dangerouslySetInnerHTML={{ __html: GROUP_ICONS[icon] ?? "" }}
        />
        <span>{title}</span>
        <span className="pg-hint">{hint}</span>
      </div>
      {children}
    </div>
  );
}

interface ParamPanelProps {
  readonly sim: LegacySim;
  readonly ui: LegacyUi;
  readonly bus: LegacyEventBus;
  readonly assets: ImportAssets;
}

export function ParamPanel({ sim, ui, bus, assets }: ParamPanelProps) {
  const [, bump] = useReducer((version: number) => version + 1, 0);
  const qualityTimer = useRef<number | null>(null);

  useEffect(() => bus.on("state", bump), [bus]);
  useEffect(() => bus.on("sliced", bump), [bus]);
  useEffect(() => bus.on("settings", bump), [bus]);
  useEffect(() => bus.on("params-refresh", bump), [bus]);
  useEffect(
    () => () => {
      if (qualityTimer.current !== null) window.clearTimeout(qualityTimer.current);
    },
    []
  );

  const settings = sim.settings;
  const busy = !["idle", "done"].includes(sim.state);
  const imported = !!sim.importedToolpath;
  const geomLocked = busy; // 材料/机型等几何组：打印中锁定
  const geomOrImportedLocked = busy || imported; // 预设/填充图案/支撑开关：G-code 固化后同样锁定

  /* 与旧 _onParamTouched 逐字对应：350ms 防抖后，若质量页开着则请求其重渲。 */
  const touch = () => {
    if (qualityTimer.current !== null) window.clearTimeout(qualityTimer.current);
    qualityTimer.current = window.setTimeout(() => {
      if (ui.currentNav === "quality") ui.renderCtx("quality");
    }, QUALITY_REFRESH_DEBOUNCE_MS);
  };

  const setParam = (patch: Record<string, number | string | boolean>) => {
    sim.updateSettings(patch);
    bump();
    touch();
  };

  /* 旧实现中只有滑杆经过 _onParamTouched；下拉与开关直接 updateSettings，不触发质量页防抖。 */
  const setParamSilent = (patch: Record<string, number | string | boolean>) => {
    sim.updateSettings(patch);
    bump();
  };

  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    unit: string,
    dec: number,
    value: number,
    key: string,
    options?: { mul?: number; geom?: boolean }
  ) => (
    <Slider
      label={label}
      min={min}
      max={max}
      step={step}
      unit={unit}
      dec={dec}
      {...(options?.mul !== undefined ? { mul: options.mul } : {})}
      locked={options?.geom ? geomOrImportedLocked : false}
      value={value}
      onInput={(next) => setParam({ [key]: next })}
    />
  );

  const { materialKeys, colors } = legacyMaterialCatalog();

  return (
    <>
      <PGroup icon="preset" title="工艺预设" hint="presets">
        <div className={geomOrImportedLocked ? "chip-row locked" : "chip-row"}>
          {PRESETS.map((preset) => (
            <div
              key={preset.name}
              className="chip"
              title={preset.desc}
              onClick={() => {
                if (busy) return ui.toast("打印中不可应用预设", "warn");
                sim.updateSettings({ ...preset.patch });
                bump();
                ui.toast(`已应用预设「${preset.name}」（${preset.desc}）`, "ok");
              }}
            >
              {preset.name}
            </div>
          ))}
        </div>
      </PGroup>

      <PGroup icon="material" title="材料体系" hint="material">
        <div className={geomLocked ? "chip-row locked" : "chip-row"}>
          {materialKeys.map((key) => (
            <div
              key={key}
              className={settings.material === key ? "chip on" : "chip"}
              onClick={() => {
                if (busy) return ui.toast("打印中不可更换材料", "warn");
                sim.applyMaterial(key);
                assets.refreshAfterMaterialChange();
                bump();
              }}
            >
              {key}
            </div>
          ))}
        </div>
        <div className="p-sub-label">外观颜色 · 仅改变成品显示</div>
        <div className={geomLocked ? "chip-row locked" : "chip-row"}>
          {colors.map((color, index) => (
            <div
              key={color.name}
              className={settings.colorIdx === index ? "chip sm on" : "chip sm"}
              style={{ borderColor: `#${color.hex.toString(16).padStart(6, "0")}aa` }}
              onClick={() => {
                settings.colorIdx = index;
                sim.printer.setFilamentColor(color.hex);
                if (sim.state === "idle" || sim.state === "done") {
                  if (sim.importedToolpath && sim.slice) sim.printer.attachToolpath(sim.slice, sim.partColor);
                  else sim.reslice();
                }
                bump();
              }}
            >
              {color.name}
            </div>
          ))}
        </div>
      </PGroup>

      <PGroup icon="layers" title="成型质量" hint="quality">
        {slider("层高", 0.08, 0.32, 0.02, "mm", 2, settings.layerHeight, "layerHeight", { geom: true })}
        {slider("周界圈数", 1, 5, 1, "圈", 0, settings.perimeters, "perimeters", { geom: true })}
        {slider("顶底实心层", 2, 6, 1, "层", 0, settings.solidLayers, "solidLayers", { geom: true })}
      </PGroup>

      <PGroup icon="infill" title="内部填充" hint="infill">
        {slider("填充密度", 0.05, 1, 0.05, "%", 0, settings.infillDensity, "infillDensity", { mul: 100, geom: true })}
        <div className={geomOrImportedLocked ? "prow locked" : "prow"}>
          <span className="p-lab">填充图案</span>
          <select
            className="sel"
            value={settings.infillPattern}
            onChange={(event) => setParamSilent({ infillPattern: event.target.value })}
          >
            {INFILL_PATTERNS.map((pattern) => (
              <option key={pattern} value={pattern}>
                {pattern}
              </option>
            ))}
          </select>
        </div>
      </PGroup>

      <PGroup icon="temp" title="温度控制" hint="thermal">
        {slider("喷嘴温度", 120, 450, 5, "°C", 0, settings.nozzleTemp, "nozzleTemp")}
        {slider("热床温度", 0, 180, 5, "°C", 0, settings.bedTemp, "bedTemp")}
      </PGroup>

      <PGroup icon="motion" title="运动系统" hint="kinematics">
        {slider("打印速度", 20, 1000, 10, "mm/s", 0, settings.speed, "speed")}
        {slider("空驶速度", 100, 1000, 20, "mm/s", 0, settings.travelSpeed, "travelSpeed")}
        {slider("回抽距离", 0, 4, 0.1, "mm", 1, settings.retraction, "retraction")}
      </PGroup>

      <PGroup icon="fan" title="冷却系统" hint="cooling">
        {slider("风扇转速", 0, 100, 5, "%", 0, settings.fanSpeed, "fanSpeed")}
      </PGroup>

      <PGroup icon="support" title="支撑结构" hint="supports">
        <div className={geomOrImportedLocked ? "prow locked" : "prow"}>
          <span className="p-lab">启用支撑</span>
          <label className="sw">
            <input
              type="checkbox"
              checked={settings.supportEnabled}
              onChange={(event) => setParamSilent({ supportEnabled: event.target.checked })}
            />
            <span className="tr" />
          </label>
          <span className="p-val" />
        </div>
        {slider("支撑间距", 2, 8, 0.5, "mm", 1, settings.supportSpacing, "supportSpacing", { geom: true })}
      </PGroup>

      <div className="note">
        温度 / 速度 / 空驶 / 回抽 /
        风扇支持打印中实时调整；层高、周界、实心层、填充图案与支撑会生成不同路径，需在待机状态修改并自动重新切片。
      </div>
    </>
  );
}
