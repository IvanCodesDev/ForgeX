/* 回归测试：机型构建状态在构造完成后必须保持。
   历史缺陷：子类 ES2022 类字段初始化在基类构造期 _buildMachine 赋值之后执行，
   把 zCarriage / zGantry / beam / _arms / BED_Y / TIP_DZ 抹回 undefined/0，
   表现为切换机型即崩、CoreXY 喷头错位、Delta 并联臂断线（见 printers.ts 的 declare 说明）。 */
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type * as THREE from "three";
import { FXPrinterCoreXY, type FXPrinterBase } from "./printer3d.ts";
import { FXPrinterDelta, FXPrinterGantry, FXPrinterI3 } from "./printers.ts";

/* node 环境无 DOM：品牌屏/床面程序化纹理只需要 2D 上下文的方法可调用、属性可赋值 */
function stubCanvasDocument(): void {
  const makeCtx = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "createLinearGradient" || prop === "createRadialGradient")
            return () => ({ addColorStop: () => {} });
          if (prop === "measureText") return () => ({ width: 0 });
          return () => {};
        },
        set: () => true,
      }
    );
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: makeCtx }),
  });
}

beforeEach(stubCanvasDocument);

const CASES: Array<{ id: string; cls: new () => FXPrinterBase }> = [
  { id: "corexy", cls: FXPrinterCoreXY },
  { id: "i3", cls: FXPrinterI3 },
  { id: "delta", cls: FXPrinterDelta },
  { id: "gantry", cls: FXPrinterGantry },
];

describe("机型构建状态在构造完成后保持", () => {
  it.each(CASES)("$id：构造后虚拟 Z / 喷头运动 / 每帧更新可用", ({ cls }) => {
    const p = new cls();
    expect(() => {
      p.setBedTopY(p.NOZZLE_Y - 150);
      p.setHeadXY(30, 20);
      p.update(0.016, 0.5);
    }).not.toThrow();
  });

  it("i3：BED_Y 保持 96，X 横梁组随虚拟 Z 升降", () => {
    const p = new FXPrinterI3();
    expect(p.BED_Y).toBe(96);
    p.setBedTopY(p.NOZZLE_Y - 40);
    expect(p.zCarriage.position.y).toBeCloseTo(96 + 40);
  });

  it("corexy：TIP_DZ 保持 38，横梁按 -my - TIP_DZ 反向补偿", () => {
    const p = new FXPrinterCoreXY();
    expect(p.TIP_DZ).toBe(38);
    p.setHeadXY(10, 5);
    expect(p.beam.position.z).toBeCloseTo(-5 - 38);
  });

  it("gantry：TIP_DZ 保持 52，龙门环随虚拟 Z 升降", () => {
    const p = new FXPrinterGantry();
    expect(p.TIP_DZ).toBe(52);
    p.setHeadXY(0, 25);
    expect(p.beam.position.z).toBeCloseTo(-25 - 52);
    p.setBedTopY(p.NOZZLE_Y - 60);
    expect(p.zGantry.position.y).toBeCloseTo(p.BED_Y + 52 + 60);
  });

  it("delta：并联臂杆随逆解摆位，杆长不退化", () => {
    const p = new FXPrinterDelta();
    p.setBedTopY(p.NOZZLE_Y - 120);
    p.setHeadXY(15, -10);
    const arms = (p as unknown as { _arms?: THREE.Mesh[][] })._arms;
    expect(arms).toBeDefined();
    expect(arms!.length).toBe(3);
    for (const pair of arms!) for (const rod of pair) expect(rod.scale.y).toBeGreaterThan(100);
  });
});
