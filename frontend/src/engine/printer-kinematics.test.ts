/* Stage 10.4 引擎数值锁定：四机型运动学契约与打印件可视化的关键数值。
   期望值是当前实现在固定输入下的实测输出（与 classic 版逐位对齐的 TS 引擎），
   作用是把「迁移/重构造成的静默几何漂移」变成显式测试失败——
   若因**有意**的建模调整而失败，请核实差异后更新期望值并在提交说明中写明原因。

   契约（printer3d.ts 文件头）：setBedTopY(NOZZLE_Y - z) 命令喷嘴-床面间距 z；
   setHeadXY(mx, my) 后喷嘴尖端必须垂直落在床坐标系的 (mx, -my) 上方。
   四款机型的运动映射（热床下沉 / 龙门升降 / Delta 并联臂 / 整体龙门环）各不相同，
   但「尖端相对床面 = (mx, z, -my)」对所有机型恒成立，这是 sim 不感知机型的前提。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { FXPrinterCoreXY, FXPrinters, type FXPrinterBase } from "./printer3d.ts";
import { FXPrinterDelta, FXPrinterGantry, FXPrinterI3 } from "./printers.ts";
import { buildGeometry, createBuiltins } from "./models.ts";
import { parse } from "./gcode-parser.ts";

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

/** 喷嘴尖端相对床面原点的位移（世界系；bedGroup 是 group 的直接子节点，无额外变换） */
function tipRelativeToBed(p: FXPrinterBase): [number, number, number] {
  p.group.updateMatrixWorld(true);
  const tip = p.getNozzleTip(new THREE.Vector3());
  const bed = p.bedGroup.getWorldPosition(new THREE.Vector3());
  return [tip.x - bed.x, tip.y - bed.y, tip.z - bed.z];
}

const POSES: Array<[number, number, number]> = [
  [0, 0, 0],
  [30, 20, 0],
  [-75, 40, 12.5],
  [100, -100, 60],
];

describe("机型契约：注册表内每一款机型都必须满足（新增机型自动纳入）", () => {
  const registered = FXPrinters.list.map((d) => ({ id: d.id, cls: d.cls }));

  it("注册表包含四款内置机型（顺序 = 选择面板展示顺序）", () => {
    expect(FXPrinters.list.map((d) => d.id)).toEqual(["corexy", "i3", "delta", "gantry"]);
  });

  it.each(registered)("$id：尖端相对床面 = (mx, z, -my)，bedTopY 读数与命令一致", ({ cls }) => {
    const p = new cls();
    expect(p.NOZZLE_Y).toBeGreaterThan(0);
    for (const [mx, my, z] of POSES) {
      p.setBedTopY(p.NOZZLE_Y - z);
      p.setHeadXY(mx, my);
      expect(p.bedTopY).toBeCloseTo(p.NOZZLE_Y - z, 12);
      const rel = tipRelativeToBed(p);
      expect(rel[0]).toBeCloseTo(mx, 9);
      expect(rel[1]).toBeCloseTo(z, 9);
      expect(rel[2]).toBeCloseTo(-my, 9);
    }
  });

  it.each(registered)("$id：料盘余量 → 耗材卷半径 (20 + f·26)/46", ({ cls }) => {
    const p = new cls();
    const scaleAt = (f: number) => {
      p.setSpoolFrac(f);
      return p.filWound!.scale.x;
    };
    expect(scaleAt(1)).toBeCloseTo(1, 12);
    expect(scaleAt(0.5)).toBeCloseTo(0.717391304347826, 12);
    expect(scaleAt(0)).toBeCloseTo(0.43478260869565216, 12);
    expect(scaleAt(2)).toBeCloseTo(1, 12); // clamp
  });
});

describe("机型常量与床面世界高度（Stage 10.4）", () => {
  it("corexy：热床下沉 —— 床面世界高度随虚拟 Z 变化", () => {
    const p = new FXPrinterCoreXY();
    expect([p.NOZZLE_Y, p.MODEL_TAG, p.KIN_TAG]).toEqual([334.5, "FX-256", "CoreXY"]);
    expect(p.CAM.pos.toArray()).toEqual([620, 520, 760]);
    expect(p.CAM.target.toArray()).toEqual([0, 250, 0]);
    expect(p.CAM.topH).toBe(1000);
    expect(p.getBedWorldY()).toBe(334.5);
    p.setBedTopY(p.NOZZLE_Y - 60);
    expect(p.getBedWorldY()).toBe(274.5);
    expect(p.bedGroup.position.y).toBe(274.5);
  });

  it("i3：固定热床 96，模型 Y 由热床沿世界 Z 反向滑动实现（尖端世界 z 恒为 12）", () => {
    const p = new FXPrinterI3();
    expect([p.NOZZLE_Y, p.MODEL_TAG, p.KIN_TAG]).toEqual([300, "FX-220", "i3 Gantry"]);
    expect(p.CAM.pos.toArray()).toEqual([590, 480, 730]);
    expect(p.getBedWorldY()).toBe(96);
    p.setBedTopY(p.NOZZLE_Y - 12.5);
    p.setHeadXY(-75, 40);
    p.group.updateMatrixWorld(true);
    expect(p.getNozzleTip(new THREE.Vector3()).toArray()).toEqual([-75, 108.5, 12]);
    expect(p.bedGroup.position.z).toBe(52);
    expect(p.getBedWorldY()).toBe(96);
  });

  it("delta：固定圆床 78，效应器做全 XYZ", () => {
    const p = new FXPrinterDelta();
    expect([p.NOZZLE_Y, p.MODEL_TAG, p.KIN_TAG]).toEqual([320, "FX-D260", "Delta"]);
    expect(p.CAM.pos.toArray()).toEqual([700, 600, 900]);
    expect(p.getBedWorldY()).toBe(78);
    p.setBedTopY(p.NOZZLE_Y - 60);
    p.setHeadXY(100, -100);
    p.group.updateMatrixWorld(true);
    expect(p.getNozzleTip(new THREE.Vector3()).toArray()).toEqual([100, 138, 100]);
  });

  it("gantry：固定平台 124，龙门环整体升降", () => {
    const p = new FXPrinterGantry();
    expect([p.NOZZLE_Y, p.MODEL_TAG, p.KIN_TAG]).toEqual([360, "FX-500", "IDEX Gantry"]);
    expect(p.CAM.pos.toArray()).toEqual([820, 660, 980]);
    expect(p.getBedWorldY()).toBe(124);
    p.setBedTopY(p.NOZZLE_Y - 60);
    p.setHeadXY(100, -100);
    p.group.updateMatrixWorld(true);
    expect(p.getNozzleTip(new THREE.Vector3()).toArray()).toEqual([100, 184, 100]);
    expect(p.zGantry.position.y).toBe(124 + 52 + 60);
  });
});

describe("Delta 逆解数值锁定（Stage 10.4）", () => {
  const arms = (p: FXPrinterDelta) => (p as unknown as { _arms: THREE.Mesh[][] })._arms;

  it("三塔布局：半径 200、起始角 30°、单位向量指向中心", () => {
    const p = new FXPrinterDelta();
    expect(p.ARM_L).toBe(300);
    expect(p.TOWER_R).toBe(200);
    const T = p.towers.map((t) => [t.x, t.z, t.u.x, t.u.z]);
    expect(T[0]![0]).toBeCloseTo(173.20508075688775, 12);
    expect(T[0]![1]).toBeCloseTo(100, 12);
    expect(T[0]![2]).toBeCloseTo(-0.8660254037844388, 12);
    expect(T[0]![3]).toBeCloseTo(-0.5, 12);
    expect(T[1]![0]).toBeCloseTo(-173.20508075688775, 12);
    expect(T[1]![1]).toBeCloseTo(100, 12);
    expect(T[2]![0]).toBeCloseTo(0, 12);
    expect(T[2]![1]).toBeCloseTo(-200, 12);
  });

  it("中心低位：三滑车等高 402.7178，六根杆长恒等于臂长 300", () => {
    const p = new FXPrinterDelta();
    p.setBedTopY(p.NOZZLE_Y);
    p.setHeadXY(0, 0);
    for (const t of p.towers) expect(t.car.position.y).toBeCloseTo(402.71780286589285, 9);
    for (const pair of arms(p)) for (const rod of pair) expect(rod.scale.y).toBeCloseTo(300, 9);
    expect(arms(p)[0]![0]!.position.toArray()).toEqual([
      expect.closeTo(82.76760388790497, 9),
      expect.closeTo(266.3589014329464, 9),
      expect.closeTo(61.64230484541326, 9),
    ]);
  });

  it("偏心 (60, 0)：靠近的塔滑车升高、远离的塔降低，杆长不变", () => {
    const p = new FXPrinterDelta();
    p.setBedTopY(p.NOZZLE_Y);
    p.setHeadXY(60, 0);
    const cars = p.towers.map((t) => t.car.position.y);
    expect(cars[0]).toBeCloseTo(419.4224957683258, 9);
    expect(cars[1]).toBeCloseTo(370.38431509404563, 9);
    expect(cars[2]).toBeCloseTo(396.0357118884606, 9);
    for (const pair of arms(p)) for (const rod of pair) expect(rod.scale.y).toBeCloseTo(300, 9);
  });

  it("高位 (0, -80, z=100)：滑车 509.24 / 449.03，杆长仍 300", () => {
    const p = new FXPrinterDelta();
    p.setBedTopY(p.NOZZLE_Y - 100);
    p.setHeadXY(0, -80);
    const cars = p.towers.map((t) => t.car.position.y);
    expect(cars[0]).toBeCloseTo(509.24004010886404, 9);
    expect(cars[1]).toBeCloseTo(509.24004010886404, 9);
    expect(cars[2]).toBeCloseTo(449.0319611380951, 9);
    for (const pair of arms(p)) for (const rod of pair) expect(rod.scale.y).toBeCloseTo(300, 9);
    expect(arms(p)[0]![0]!.position.y).toBeCloseTo(369.620020054432, 9);
  });

  it("超出包络 (40, 40, z=250)：滑车钳制在 566，杆按实际两端距离缩短（不再是 300）", () => {
    const p = new FXPrinterDelta();
    p.setBedTopY(p.NOZZLE_Y - 250);
    p.setHeadXY(40, 40);
    for (const t of p.towers) expect(t.car.position.y).toBe(566);
    const rods = arms(p).map((pair) => pair.map((r) => r.scale.y));
    expect(rods[0]![0]).toBeCloseTo(223.07116793112374, 9);
    expect(rods[1]![0]).toBeCloseTo(259.0004904200847, 9);
    expect(rods[2]![0]).toBeCloseTo(208.37706207737932, 9);
    for (const pair of rods) expect(pair[0]).toBeCloseTo(pair[1]!, 12); // 双杆平行等长
  });
});

describe("打印件几何与逐层可视化数值锁定（Stage 10.4）", () => {
  it("内置模型三角网格：顶点数与包围盒（ExtrudeGeometry curveSegments=8）", () => {
    const geo = Object.fromEntries(
      createBuiltins().map((m) => {
        const g = buildGeometry(m);
        g.computeBoundingBox();
        return [m.id, { count: g.attributes.position!.count, min: g.boundingBox!.min, max: g.boundingBox!.max }];
      })
    );
    expect(geo.gear!.count).toBe(4584);
    expect(geo.impeller!.count).toBe(36432);
    expect(geo.bracket!.count).toBe(2028);
    // 模型 z（高度）已旋到世界 y；齿顶半径 27.6 的齿轮包围盒 ±27.58（齿顶点未必落在轴上）
    expect(geo.gear!.max.y).toBe(16);
    expect(geo.gear!.max.x).toBeCloseTo(27.579370498657227, 6);
    expect(geo.gear!.max.z).toBeCloseTo(27.506887435913086, 6);
    expect(geo.impeller!.max.y).toBe(30);
    expect(geo.impeller!.max.x).toBeCloseTo(26, 6);
    expect(geo.bracket!.max.y).toBe(30);
    expect([geo.bracket!.min.x, geo.bracket!.max.x, geo.bracket!.min.z, geo.bracket!.max.z]).toEqual([
      -23, 23, -15, 15,
    ]);
    for (const g of Object.values(geo)) expect(Math.abs(g.min.y)).toBeLessThan(1e-12);
  });

  it("attachPart：成品挂在 y=0.01、初始隐藏，固化高度 > 0.001 才显示", () => {
    const p = new FXPrinterCoreXY();
    p.attachPart(createBuiltins()[0]!, { scale: 1, rotZ: 0, offX: 0, offY: 0 }, 0x3d6fd6, 0.2);
    const part = (p as unknown as { _part: THREE.Mesh })._part;
    expect(part.visible).toBe(false);
    expect(part.geometry.attributes.position!.count).toBe(4584);
    expect(part.position.x).toBe(0);
    expect(part.position.y).toBe(0.01);
    expect(part.position.z + 0).toBe(0); // 位置 z = −(offY || 0)，此处为 −0
    p.setGrownHeight(3.2);
    expect(part.visible).toBe(true);
    p.setGrownHeight(0);
    expect(part.visible).toBe(false);
  });

  it("attachToolpath：导入 G-code 的线框按层 z 揭示 drawRange", () => {
    const GCODE = [
      "G1 Z0.2 F600",
      "G1 X10 Y0 E1 F1200",
      "G1 X10 Y10 E2",
      "G0 X0 Y0",
      "G1 Z0.4",
      "G1 X10 Y0 E3 F1800",
      "G1 X10 Y10 E3.5",
    ].join("\n");
    const p = new FXPrinterCoreXY();
    p.attachToolpath(parse(GCODE, { origin: "corner" }) as never, 0x3d6fd6);
    const part = (p as unknown as { _part: THREE.LineSegments })._part;
    expect(part.geometry.attributes.position!.count).toBe(8); // 两层各 2 段 × 2 端点
    expect((p as unknown as { _toolpathLayerRanges: unknown })._toolpathLayerRanges).toEqual([
      { z: 0.2, count: 4 },
      { z: 0.4, count: 8 },
    ]);
    const drawAt = (h: number) => {
      p.setGrownHeight(h);
      return [part.visible, part.geometry.drawRange.count];
    };
    expect(drawAt(0)).toEqual([false, 0]);
    expect(drawAt(0.2)).toEqual([true, 4]);
    expect(drawAt(0.4)).toEqual([true, 8]);
    expect(drawAt(1)).toEqual([true, 8]);
  });

  it("beginLayer / setLayerProgress：管束按类型合并、按挤出里程对齐 30 索引揭示", () => {
    const p = new FXPrinterCoreXY();
    const paths = [
      {
        pts: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        type: "perimeter",
        len: 20,
        speed: 60,
      },
      {
        pts: [
          { x: 20, y: 0 },
          { x: 20, y: 10 },
          { x: 0, y: 10 },
        ],
        type: "infill",
        len: 30,
        speed: 60,
      },
      // 无法成管（< 0.4 mm）的路径只占位，里程仍计入
      {
        pts: [
          { x: 0, y: 10 },
          { x: 0.1, y: 10 },
        ],
        type: "infill",
        len: 0.1,
        speed: 60,
      },
      {
        pts: [
          { x: 0, y: 12 },
          { x: 5, y: 12 },
        ],
        type: "support",
        len: 5,
        speed: 60,
      },
    ];
    p.beginLayer(paths, 0.2, 0.2, { perimeter: 0x111111, infill: 0x222222, support: 0x333333 });
    const layer = p as unknown as {
      _layerGroup: THREE.Group;
      _layerEntries: Array<{ idxStart: number; idxCount: number; len: number; mesh: THREE.Mesh | null }>;
    };
    expect(layer._layerGroup.position.y).toBeCloseTo(0.11, 12); // zTop - layerH·0.45
    expect(layer._layerGroup.children.length).toBe(3); // perimeter / infill（两条并入一个 run）/ support
    // TubeGeometry(segs = round(len/1.6), 5 径向) → 索引数 = segs × 5 × 6
    expect(layer._layerEntries.map((e) => [e.idxStart, e.idxCount, e.len, e.mesh !== null])).toEqual([
      [0, 390, 20, true],
      [0, 570, 30, true],
      [0, 0, 0.1, false],
      [0, 90, 5, true],
    ]);
    const revealAt = (ext: number) => {
      p.setLayerProgress(ext);
      return layer._layerGroup.children.map((c) => (c as THREE.Mesh).geometry.drawRange.count);
    };
    expect(revealAt(0)).toEqual([0, 0, 0]);
    expect(revealAt(10)).toEqual([180, 0, 0]); // 周界一半：floor(0.5·390/30)·30
    expect(revealAt(20)).toEqual([390, 0, 0]);
    expect(revealAt(35)).toEqual([390, 270, 0]);
    expect(revealAt(50)).toEqual([390, 570, 0]);
    expect(revealAt(60)).toEqual([390, 570, 90]);
    p.endLayer();
    expect(layer._layerGroup).toBeNull();
    expect(layer._layerEntries).toEqual([]);
  });
});
