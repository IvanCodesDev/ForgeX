import type { CSSProperties } from "react";

export interface SliderProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  /** 展示小数位。 */
  readonly dec: number;
  /** 展示倍乘（如填充密度 0–1 显示为 %）。 */
  readonly mul?: number;
  /** 几何参数在打印中/G-code 固化时锁定，对应 .locked 样式。 */
  readonly locked?: boolean;
  /** 当前真实值：由调用方从引擎回读，引擎拒绝的改动因此自动回弹。 */
  readonly value: number;
  onInput(value: number): void;
}

/** 与旧 _slider 同构的参数滑杆：.prow > .p-lab + input.range + .p-val。 */
export function Slider({ label, min, max, step, unit, dec, mul, locked, value, onInput }: SliderProps) {
  const shown = (mul ? value * mul : value).toFixed(dec);
  const fillPercent = (((value - min) / (max - min)) * 100).toFixed(1);

  return (
    <div className={locked ? "prow locked" : "prow"}>
      <span className="p-lab">{label}</span>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--fill": `${fillPercent}%` } as CSSProperties}
        onChange={(event) => onInput(Number.parseFloat(event.target.value))}
      />
      <span className="p-val">
        {shown}
        <small>{unit}</small>
      </span>
    </div>
  );
}
