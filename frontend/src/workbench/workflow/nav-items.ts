/** 流程入口定义，与 js/ui.js 的 NAVS 一一对应：
    模型（含摆放）/ 切片 / 校准 / 质量 + 智造洞察（数据分析域，独立面板）。 */
export type WorkflowNavId = "import" | "slice" | "calib" | "quality";

export interface WorkflowNavItem {
  readonly id: WorkflowNavId | "insight";
  readonly label: string;
  readonly title: string;
  readonly accent?: boolean;
}

export const NAV_ITEMS: readonly WorkflowNavItem[] = [
  { id: "import", label: "模型", title: "模型与摆放" },
  { id: "slice", label: "切片", title: "切片分析" },
  { id: "calib", label: "校准", title: "平台校准" },
  { id: "quality", label: "质量", title: "质量评估" },
  { id: "insight", label: "洞察", title: "智造洞察", accent: true },
];

export function navIndex(id: WorkflowNavId): number {
  return NAV_ITEMS.findIndex((item) => item.id === id);
}
