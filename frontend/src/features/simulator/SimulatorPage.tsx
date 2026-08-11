import { useEffect, useMemo, useRef, useState } from "react";
import { useProfileSelection } from "../profiles/useProfileSelection";
import { ProcessParameterForm, type SimulatorPresetId } from "./ProcessParameterForm";
import { SimulationResultPanel } from "./SimulationResultPanel";
import {
  IDENTITY_SIMULATION_TRANSFORM,
  STANDARD_SIMULATION_SETTINGS,
  validateQuickSimulationInput,
} from "./simulator-schema";
import type { QuickSimulationInput, QuickSimulationSettings, SimulatorModelId } from "./simulator-types";
import { useQuickSimulation } from "./useQuickSimulation";
import "./simulator.css";

const MODELS: readonly { readonly id: SimulatorModelId; readonly label: string; readonly note: string }[] = [
  { id: "gear", label: "行星齿轮", note: "Ø55 × 16 mm · 无显著悬垂" },
  { id: "impeller", label: "涡轮叶轮", note: "Ø51 × 30 mm · 曲面路径" },
  { id: "bracket", label: "传感器支架", note: "46 × 30 × 30 mm · 含悬垂" },
];

const PRESET_PATCHES: Readonly<Record<SimulatorPresetId, Partial<QuickSimulationSettings>>> = {
  draft: { layerHeight: 0.28, perimeters: 2, solidLayers: 3, infillDensity: 0.12, speed: 150, supportEnabled: false },
  standard: { layerHeight: 0.2, perimeters: 2, solidLayers: 3, infillDensity: 0.18, speed: 120, supportEnabled: true },
  durable: { layerHeight: 0.2, perimeters: 3, solidLayers: 4, infillDensity: 0.3, speed: 90, supportEnabled: true },
  detail: { layerHeight: 0.12, perimeters: 2, solidLayers: 4, infillDensity: 0.25, speed: 70, supportEnabled: true },
};

function materialDefaults(
  settings: QuickSimulationSettings,
  material: ReturnType<typeof useProfileSelection>["value"]["material"]
): QuickSimulationSettings {
  return {
    ...settings,
    material: material.id,
    nozzleTemp: material.nozzleTemp,
    bedTemp: material.bedTemp,
    fanSpeed: material.fan,
    speed: Math.min(settings.speed, material.maxSpeed),
  };
}

export function SimulatorPage() {
  const profiles = useProfileSelection();
  const simulation = useQuickSimulation();
  const [modelId, setModelId] = useState<SimulatorModelId>("gear");
  const [settings, setSettings] = useState<QuickSimulationSettings>(() =>
    materialDefaults(STANDARD_SIMULATION_SETTINGS, profiles.value.material)
  );
  const [activePreset, setActivePreset] = useState<SimulatorPresetId | null>("standard");
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousInput = useRef("");

  const input = useMemo<QuickSimulationInput>(
    () => ({
      modelId,
      machine: profiles.value.machine,
      material: profiles.value.material,
      settings,
      tf: IDENTITY_SIMULATION_TRANSFORM,
    }),
    [modelId, profiles.value.machine, profiles.value.material, settings]
  );
  const validation = useMemo(() => validateQuickSimulationInput(input), [input]);
  const signature = useMemo(() => JSON.stringify(input), [input]);

  useEffect(() => {
    if (previousInput.current && previousInput.current !== signature) simulation.markStale();
    previousInput.current = signature;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    if (validation.ok) {
      autoTimer.current = setTimeout(() => {
        autoTimer.current = null;
        simulation.run(validation.value);
      }, 300);
    }
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = null;
    };
  }, [signature, simulation.markStale, simulation.run, validation]);

  const changeSettings = (patch: Partial<QuickSimulationSettings>) => {
    setActivePreset(null);
    setSettings((current) => ({ ...current, ...patch }));
  };

  const applyPreset = (preset: SimulatorPresetId) => {
    const base = { ...STANDARD_SIMULATION_SETTINGS, ...PRESET_PATCHES[preset] };
    setSettings(materialDefaults(base, profiles.value.material));
    setActivePreset(preset);
  };

  const selectMaterial = (id: string) => {
    const material = profiles.value.catalog.materials.find((candidate) => candidate.id === id);
    if (!material) return;
    profiles.actions.selectMaterial(id);
    setSettings((current) => materialDefaults(current, material));
    setActivePreset(null);
  };

  const runNow = () => {
    if (!validation.ok) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
    simulation.run(validation.value);
  };

  const cancel = () => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
    simulation.cancel();
  };

  return (
    <div className="page-stack simulator-page">
      <section className="hero-panel">
        <p className="eyebrow">PROCESS SIMULATOR / STAGE 2 CLOSEOUT</p>
        <h1>先在浏览器快速验证工艺方向，再把正式任务交给权威计算核心。</h1>
        <p className="hero-copy">
          内置模型、Machine Profile、Material Profile 与旧版切片规则在隔离 Worker
          中组合计算；参数变化会自动生成新预览，不上传模型或工艺数据。
        </p>
        <p className="simulator-authority-note">
          <strong>浏览器即时预览（非权威）</strong> · 当前结果仅用于交互反馈，不代表真机实测或 C# 权威分析。
        </p>
      </section>

      <section className="panel simulator-setup" aria-labelledby="simulator-setup-heading">
        <div className="simulator-setup-heading">
          <div>
            <p className="eyebrow">INPUT SNAPSHOT / LOCAL ONLY</p>
            <h2 id="simulator-setup-heading">模型、Profile 与主要工艺参数</h2>
          </div>
          <span className="simulator-authority-badge">浏览器即时预览（非权威）</span>
        </div>

        <div className="simulator-source-grid">
          <label>
            <span>内置模型</span>
            <select
              aria-label="内置模型"
              value={modelId}
              onChange={(event) => setModelId(event.target.value as SimulatorModelId)}
            >
              {MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.note}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>机器 Profile</span>
            <select
              aria-label="机器 Profile"
              value={profiles.value.machine.id}
              onChange={(event) => profiles.actions.selectMachine(event.target.value)}
            >
              {profiles.value.catalog.machines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name} · {machine.kinematics}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>材料 Profile</span>
            <select
              aria-label="材料 Profile"
              value={profiles.value.material.id}
              onChange={(event) => selectMaterial(event.target.value)}
            >
              {profiles.value.catalog.materials.map((material) => (
                <option key={material.id} value={material.id}>
                  {material.name} · {material.densityG} g/cm³
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="simulator-profile-note">
          当前快照：{profiles.value.machine.name} · {profiles.value.machine.buildVolume.x} ×{" "}
          {profiles.value.machine.buildVolume.y} × {profiles.value.machine.buildVolume.z} mm ·{" "}
          {profiles.value.material.name} {profiles.value.material.nozzleRange[0]}–
          {profiles.value.material.nozzleRange[1]}°C · 最高建议 {profiles.value.material.maxSpeed} mm/s
        </p>

        <ProcessParameterForm
          value={settings}
          errors={validation.ok ? [] : validation.errors}
          activePreset={activePreset}
          onChange={changeSettings}
          onPreset={applyPreset}
        />

        {!validation.ok ? (
          <ul className="simulator-validation-errors" aria-label="参数校验错误" role="alert">
            {validation.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <SimulationResultPanel state={simulation.state} onRun={runNow} onCancel={cancel} runDisabled={!validation.ok} />
    </div>
  );
}
