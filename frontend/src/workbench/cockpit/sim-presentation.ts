import type { SimState } from "../../legacy/engine";

/** 状态到样式修饰符的映射，取值与 css/style.css 的 .st-* 规则对应。 */
export const STATE_TONE: Readonly<Record<SimState, string>> = {
  idle: "idle",
  heat: "heat",
  level: "level",
  print: "print",
  pause: "pause",
  done: "done",
  fault: "err",
};

export const STATE_LABEL: Readonly<Record<SimState, string>> = {
  idle: "系统就绪",
  heat: "预热中",
  level: "自动调平",
  print: "打印进行中",
  pause: "已暂停",
  done: "任务完成",
  fault: "故障暂停",
};

const PAUSABLE_STATES: readonly SimState[] = ["print", "pause", "fault", "heat", "level"];

export function canStart(state: SimState): boolean {
  return state === "idle" || state === "done";
}

export function canPause(state: SimState): boolean {
  return PAUSABLE_STATES.includes(state);
}

export function canStop(state: SimState): boolean {
  return state !== "idle" && state !== "done";
}

/** 暂停键在挂起态转为“继续”，与旧入口的图标和提示保持一致。 */
export function isResuming(state: SimState): boolean {
  return state === "pause" || state === "fault";
}

export function pauseTitle(state: SimState): string {
  if (state === "pause") return "继续";
  if (state === "fault") return "排除故障并恢复";
  return "暂停";
}
