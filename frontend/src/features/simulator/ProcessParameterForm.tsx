import type { QuickSimulationSettings, SimulatorInfillPattern } from "./simulator-types";
import { SIMULATOR_INFILL_PATTERNS } from "./simulator-types";

export type SimulatorPresetId = "draft" | "standard" | "durable" | "detail";

export interface ProcessParameterFormProps {
  readonly value: QuickSimulationSettings;
  readonly errors: readonly string[];
  readonly activePreset: SimulatorPresetId | null;
  readonly disabled?: boolean;
  readonly onChange: (patch: Partial<QuickSimulationSettings>) => void;
  readonly onPreset: (preset: SimulatorPresetId) => void;
}

interface NumberFieldProps {
  readonly field: keyof QuickSimulationSettings;
  readonly label: string;
  readonly unit: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled: boolean;
  readonly errors: readonly string[];
  readonly onChange: (value: number) => void;
}

const PRESETS: readonly { readonly id: SimulatorPresetId; readonly label: string; readonly note: string }[] = [
  { id: "draft", label: "快速草稿", note: "0.28 mm · 12% 填充" },
  { id: "standard", label: "标准平衡", note: "0.20 mm · 18% 填充" },
  { id: "durable", label: "耐用结构", note: "3 周界 · 30% 填充" },
  { id: "detail", label: "精细表面", note: "0.12 mm · 25% 填充" },
];

function hasFieldError(errors: readonly string[], field: keyof QuickSimulationSettings): boolean {
  return errors.some((error) => error.includes(`input.settings.${field}`));
}

function NumberField({ field, label, unit, value, min, max, step, disabled, errors, onChange }: NumberFieldProps) {
  const invalid = hasFieldError(errors, field);
  const hintId = `simulator-${field}-hint`;
  return (
    <label className="simulator-field">
      <span>{label}</span>
      <span className="simulator-number-input">
        <input
          name={field}
          type="number"
          aria-label={label}
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value === "" ? Number.NaN : event.target.valueAsNumber)}
        />
        <span aria-hidden="true">{unit}</span>
      </span>
      <small id={hintId} className={invalid ? "simulator-field-error" : undefined}>
        {invalid ? "当前值超出允许范围" : `${min}–${max}`}
      </small>
    </label>
  );
}

export function ProcessParameterForm({
  value,
  errors,
  activePreset,
  disabled = false,
  onChange,
  onPreset,
}: ProcessParameterFormProps) {
  const number =
    (field: keyof QuickSimulationSettings) =>
    (next: number): void =>
      onChange({ [field]: next });

  return (
    <div className="simulator-parameter-form">
      <section className="simulator-presets" aria-labelledby="simulator-presets-heading">
        <div>
          <h3 id="simulator-presets-heading">工艺预设</h3>
          <p>预设会恢复一组完整参数，再按当前材料限制打印速度。</p>
        </div>
        <div className="simulator-preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              aria-pressed={activePreset === preset.id}
              onClick={() => onPreset(preset.id)}
            >
              <strong>{preset.label}</strong>
              <small>{preset.note}</small>
            </button>
          ))}
        </div>
      </section>

      <fieldset disabled={disabled}>
        <legend>几何与填充</legend>
        <div className="simulator-field-grid">
          <NumberField
            field="layerHeight"
            label="层高"
            unit="mm"
            value={value.layerHeight}
            min={0.08}
            max={0.32}
            step={0.01}
            disabled={disabled}
            errors={errors}
            onChange={number("layerHeight")}
          />
          <NumberField
            field="extrusionWidth"
            label="挤出宽度"
            unit="mm"
            value={value.extrusionWidth}
            min={0.2}
            max={1.2}
            step={0.01}
            disabled={disabled}
            errors={errors}
            onChange={number("extrusionWidth")}
          />
          <NumberField
            field="perimeters"
            label="周界数量"
            unit="圈"
            value={value.perimeters}
            min={1}
            max={5}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("perimeters")}
          />
          <NumberField
            field="solidLayers"
            label="实心层数"
            unit="层"
            value={value.solidLayers}
            min={2}
            max={6}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("solidLayers")}
          />
          <NumberField
            field="infillDensity"
            label="填充密度"
            unit="比例"
            value={value.infillDensity}
            min={0.05}
            max={1}
            step={0.01}
            disabled={disabled}
            errors={errors}
            onChange={number("infillDensity")}
          />
          <label className="simulator-field">
            <span>填充图案</span>
            <select
              name="infillPattern"
              aria-label="填充图案"
              value={value.infillPattern}
              disabled={disabled}
              onChange={(event) => onChange({ infillPattern: event.target.value as SimulatorInfillPattern })}
            >
              {SIMULATOR_INFILL_PATTERNS.map((pattern) => (
                <option key={pattern} value={pattern}>
                  {pattern}
                </option>
              ))}
            </select>
            <small>逐层路径使用旧版切片规则</small>
          </label>
          <NumberField
            field="skirtLoops"
            label="裙边圈数"
            unit="圈"
            value={value.skirtLoops}
            min={0}
            max={10}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("skirtLoops")}
          />
          <NumberField
            field="skirtGap"
            label="裙边间距"
            unit="mm"
            value={value.skirtGap}
            min={0}
            max={50}
            step={0.5}
            disabled={disabled}
            errors={errors}
            onChange={number("skirtGap")}
          />
          <NumberField
            field="colorIdx"
            label="预览颜色编号"
            unit="0–4"
            value={value.colorIdx}
            min={0}
            max={4}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("colorIdx")}
          />
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>温控与运动</legend>
        <div className="simulator-field-grid">
          <NumberField
            field="nozzleTemp"
            label="喷嘴温度"
            unit="°C"
            value={value.nozzleTemp}
            min={120}
            max={450}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("nozzleTemp")}
          />
          <NumberField
            field="bedTemp"
            label="热床温度"
            unit="°C"
            value={value.bedTemp}
            min={0}
            max={180}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("bedTemp")}
          />
          <NumberField
            field="speed"
            label="打印速度"
            unit="mm/s"
            value={value.speed}
            min={20}
            max={1000}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("speed")}
          />
          <NumberField
            field="travelSpeed"
            label="空驶速度"
            unit="mm/s"
            value={value.travelSpeed}
            min={100}
            max={1000}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("travelSpeed")}
          />
          <NumberField
            field="retraction"
            label="回抽距离"
            unit="mm"
            value={value.retraction}
            min={0}
            max={4}
            step={0.1}
            disabled={disabled}
            errors={errors}
            onChange={number("retraction")}
          />
          <NumberField
            field="fanSpeed"
            label="风扇转速"
            unit="%"
            value={value.fanSpeed}
            min={0}
            max={100}
            step={1}
            disabled={disabled}
            errors={errors}
            onChange={number("fanSpeed")}
          />
        </div>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>支撑与调平</legend>
        <div className="simulator-field-grid">
          <NumberField
            field="supportSpacing"
            label="支撑间距"
            unit="mm"
            value={value.supportSpacing}
            min={2}
            max={8}
            step={0.1}
            disabled={disabled}
            errors={errors}
            onChange={number("supportSpacing")}
          />
          <NumberField
            field="zOffset"
            label="Z 偏移"
            unit="mm"
            value={value.zOffset}
            min={-0.3}
            max={0.3}
            step={0.01}
            disabled={disabled}
            errors={errors}
            onChange={number("zOffset")}
          />
          <label className="simulator-switch">
            <input
              type="checkbox"
              checked={value.supportEnabled}
              onChange={(event) => onChange({ supportEnabled: event.target.checked })}
            />
            <span>
              <strong>启用支撑</strong>
              <small>为显著悬垂生成支撑路径</small>
            </span>
          </label>
          <label className="simulator-switch">
            <input
              type="checkbox"
              checked={value.autoLevel}
              onChange={(event) => onChange({ autoLevel: event.target.checked })}
            />
            <span>
              <strong>打印前自动调平</strong>
              <small>估时固定包含统一流程开销</small>
            </span>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
