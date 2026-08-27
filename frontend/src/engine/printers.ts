/* FORGE·X — 扩展机型库（全程序化建模，共享 FXPrinterBase 契约）。
   自 js/printers.js 机械迁移：几何/材质数值逐行保留，THREE 改由 npm 包引入（r152 同版）。
   · FX-220 轻锋   i3 龙门（热床前后走 Y，龙门双丝杆升降 Z，喷头走 X）
   · FX-Δ260 迅影  Delta 三角洲（三塔并联臂，喷头做全 XYZ，圆形固定热床）
   · FX-500 巨匠   工业大幅面龙门（四角丝杆整体升降 XY 龙门，固定钢结构平台）
   运动学差异全部收敛在 setHeadXY / _applyZ / _tubePts 三个钩子内，
   sim / ui / scene 通过基类虚拟 Z 契约驱动，无需感知机型。 */
import * as THREE from "three";
import { clamp, deg2rad } from "./util.ts";
import { FXPrinterBase, FXPrinters } from "./printer3d.ts";

const V3 = (x?: number, y?: number, z?: number) => new THREE.Vector3(x, y, z);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/* ══════════════════════════════════════════════════════════════
   FX-220 轻锋 · i3 龙门（bedslinger）
   ══════════════════════════════════════════════════════════════ */
export class FXPrinterI3 extends FXPrinterBase {
  /* declare：仅类型声明、不发射 ES2022 类字段（真实赋值在 _buildMachine 基类构造期完成；
     普通字段声明会在 super() 返回后把这些值抹回 undefined/0，导致切换机型即崩）。 */
  declare BED_Y: number;
  declare zCarriage: THREE.Group;

  protected _buildMachine(): void {
    this.MODEL_NAME = "FX-220 轻锋";
    this.MODEL_TAG = "FX-220";
    this.KIN_TAG = "i3 Gantry";
    this.NOZZLE_Y = 300; // 虚拟 Z 契约参考值（任意常量）
    this.BED_Y = 96; // 打印面固定世界高度
    this.CAM = { pos: V3(590, 480, 730), target: V3(0, 215, 0), topH: 880 };

    const M = this._mats;

    /* 底盘与 Y 轴 */
    const base = this._box(400, 46, 430, M.frameDark, 0, 23, 10);
    base.castShadow = true;
    base.receiveShadow = true;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) this._cyl(14, 16, 9, M.blackPlastic, sx * 175, -3, sz * 185 + 10);
    // Y 向中央型材 + 双导轨
    this._box(90, 22, 430, M.frameDark, 0, 57, 10);
    this._box(10, 5, 420, M.railSteel, -26, 70, 10);
    this._box(10, 5, 420, M.railSteel, 26, 70, 10);
    // Y 电机（尾部）与同步带
    this._box(40, 40, 42, M.blackPlastic, 0, 60, -196).castShadow = true;
    this._box(6, 3, 380, M.belt, 0, 66, 0);

    /* 热床组（沿世界 Z 滑动 = 模型 Y） */
    const g = new THREE.Group();
    g.position.set(0, this.BED_Y, 0);
    this.bedGroup = g;
    this.group.add(g);
    this._buildBedSurface(g, { glowY: -12 });
    this._box(this.BED_SIZE + 12, 7, this.BED_SIZE + 12, M.frameMid, 0, -10, 0, g);
    this._box(224, 10, 224, M.frameMid, 0, -17.5, 0, g);
    // 四角调平旋钮
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this._cyl(9, 9, 6, M.blackPlastic, sx * 122, -16, sz * 122, g);

    /* 龙门立柱 + 双 Z 丝杆 */
    const colZ = -20;
    for (const sx of [-1, 1]) {
      const col = this._box(26, 420, 26, M.frameDark, sx * 180, 280, colZ);
      col.castShadow = true;
      this._box(4, 420, 3, M.blackPlastic, sx * (180 - 13), 280, colZ);
      // 丝杆 + 底部 Z 电机
      this._cyl(3.2, 3.2, 390, M.aluBright, sx * 163, 285, colZ, this.group, 12);
      this._box(36, 36, 36, M.blackPlastic, sx * 163, 86, colZ).castShadow = true;
      // 柱顶盖
      this._box(32, 8, 32, M.frameMid, sx * 180, 494, colZ);
    }
    // 顶部横梁
    this._box(400, 26, 26, M.frameDark, 0, 486, colZ).castShadow = true;

    /* Z 升降横梁组（X 轴载体） */
    const zc = new THREE.Group();
    zc.position.set(0, this.BED_Y, colZ); // z=0 时喷嘴尖端正好落在打印面
    this.zCarriage = zc;
    this.group.add(zc);
    const xBeam = this._box(356, 26, 26, M.frameMid, 0, 60, 0, zc);
    xBeam.castShadow = true;
    this._box(320, 8, 5, M.railSteel, 0, 60, 14, zc);
    this._box(320, 2.4, 3, M.belt, 0, 74, 10, zc);
    for (const sx of [-1, 1]) {
      this._box(34, 60, 34, M.frameMid, sx * 180, 60, 0, zc).castShadow = true;
      this._cyl(7, 7, 30, M.brass, sx * 163, 60, 0, zc);
    }

    /* 挤出头（直驱，组原点 = 喷嘴尖端） */
    const th = new THREE.Group();
    th.position.set(0, 0, 26);
    this.toolhead = th;
    zc.add(th);
    this._box(44, 64, 8, M.frameMid, 0, 42, -8, th); // 背板
    const shell = this._box(42, 40, 26, M.blackPlastic, 0, 44, 6, th);
    shell.castShadow = true;
    for (let i = 0; i < 6; i++) this._box(30, 1.8, 18, M.aluBright, 0, 18 + i * 3, 6, th); // 散热鳍片
    this.heaterBlock = this._box(14, 10, 11, M.copper, 0, 11, 6, th);
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0xb98f3e,
      metalness: 1.0,
      roughness: 0.3,
      emissive: 0xff5a1e,
      emissiveIntensity: 0,
    });
    this.nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 3.4, 8, 14), nozzleMat);
    this.nozzle.position.set(0, 4, 6);
    this.nozzle.rotation.x = Math.PI;
    th.add(this.nozzle);
    // 热端风扇（正面）
    this._box(26, 26, 4, M.blackPlastic, 0, 44, 20, th);
    const rotor = new THREE.Group();
    rotor.position.set(0, 44, 22.5);
    for (let b = 0; b < 5; b++) {
      const blade = this._box(2, 9.5, 0.8, M.frameMid, 0, 0, 0, rotor);
      blade.position.set(Math.cos((b / 5) * Math.PI * 2) * 5.2, Math.sin((b / 5) * Math.PI * 2) * 5.2, 0);
      blade.rotation.z = (b / 5) * Math.PI * 2 + 0.6;
    }
    this.hotFan = rotor;
    th.add(rotor);
    // 物件冷却离心风扇（左侧）
    this._box(16, 22, 18, M.blackPlastic, -26, 36, 4, th);
    this.partFan = this._cyl(7, 7, 5, M.frameMid, -26, 36, 15, th);
    this.partFan.rotation.x = Math.PI / 2;
    this._box(7, 14, 5, M.blackPlastic, -21, 22, 8, th);
    // 挤出机顶座 + 进料接头
    this._box(30, 22, 24, M.frameMid, 0, 74, 4, th);
    this._cyl(4, 4, 9, M.aluBright, 0, 89, 4, th);
    this._buildStateLED(16, 50, 14, th);
    this.meltLight = new THREE.PointLight(0xff8a45, 0, 60, 2);
    this.meltLight.position.set(0, -2, 6);
    th.add(this.meltLight);
    this.nozzleTipLocal = V3(0, 0, 6);

    /* 顶置料盘 */
    this._box(14, 36, 14, M.frameMid, 0, 517, colZ);
    this._buildSpool(0, 552, colZ);

    /* 前面板屏 + 旋钮 + 电源灯 */
    this._box(130, 60, 8, M.frameMid, 140, 40, 226);
    this._buildScreen(140, 40, 231, 0);
    const knob = this._cyl(7, 7, 6, M.blackPlastic, 202, 40, 231);
    knob.rotation.x = Math.PI / 2;
    this._buildPowerLED(82, 40, 231.5);
  }

  /* 固定热床：虚拟 Z 映射为整根 X 横梁升降 */
  protected _applyZ(z: number): void {
    this.zCarriage.position.y = this.BED_Y + z;
  }

  /** 喷头只走 X；模型 Y 由热床反向滑动实现。
      喷嘴尖端世界 z = 横梁组 -20 + 头挂装 26 + 尖端局部 6 = 12，热床据此补偿。 */
  setHeadXY(mx: number, my: number): void {
    this.headMX = mx;
    this.headMY = my;
    this.toolhead.position.x = mx;
    this.bedGroup.position.z = 12 + my;
  }

  protected _tubePts(tip: THREE.Vector3): THREE.Vector3[] {
    return [
      V3(0, 524, -20),
      V3(tip.x * 0.6, tip.y + 150, tip.z - 46),
      V3(tip.x, tip.y + 104, tip.z - 6),
      V3(tip.x, tip.y + 92, tip.z - 2),
    ];
  }
}

/* ══════════════════════════════════════════════════════════════
   FX-Δ260 迅影 · Delta 三角洲（并联臂）
   ══════════════════════════════════════════════════════════════ */
export class FXPrinterDelta extends FXPrinterBase {
  /* declare：见 FXPrinterI3 说明。_arms 被抹掉时 _updateKinematics 静默早退，并联臂永远断开。 */
  declare BED_Y: number;
  declare ARM_L: number;
  declare TOWER_R: number;
  declare towers: Array<{ x: number; z: number; u: { x: number; z: number }; car: THREE.Mesh }>;
  declare private _arms?: THREE.Mesh[][];

  protected _buildMachine(): void {
    this.MODEL_NAME = "FX-Δ260 迅影";
    this.MODEL_TAG = "FX-D260";
    this.KIN_TAG = "Delta";
    this.NOZZLE_Y = 320;
    this.BED_Y = 78; // 打印面高出基座顶板（顶面 70），避免共面 z-fighting
    this.ARM_L = 300; // 并联臂杆长
    this.TOWER_R = 200; // 塔柱分布半径
    this.CAM = { pos: V3(700, 600, 900), target: V3(0, 285, 0), topH: 1050 };

    const M = this._mats;

    /* 圆形基座 */
    const base = this._cyl(232, 238, 64, M.frameDark, 0, 32, 0, this.group, 30);
    base.castShadow = true;
    base.receiveShadow = true;
    this._cyl(226, 226, 6, M.frameMid, 0, 67, 0, this.group, 30);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      this._cyl(15, 17, 9, M.blackPlastic, Math.cos(a) * 190, -3, Math.sin(a) * 190);
    }

    /* 固定圆床 */
    const g = new THREE.Group();
    g.position.set(0, this.BED_Y, 0);
    this.bedGroup = g;
    this.group.add(g);
    this._buildBedSurface(g, { round: true, glowY: -7 });

    /* 三塔柱（各自朝心旋转）+ 顶环 */
    const topY = 584,
      towerH = 520;
    this.towers = [];
    const tops: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = deg2rad(30 + i * 120);
      const tx = Math.cos(a) * this.TOWER_R,
        tz = Math.sin(a) * this.TOWER_R;
      const tg = new THREE.Group();
      tg.position.set(tx, 0, tz);
      tg.rotation.y = Math.atan2(-tx, -tz); // +z 面朝机器中心
      this.group.add(tg);
      const col = this._box(24, towerH, 24, M.frameDark, 0, 64 + towerH / 2, 0, tg);
      col.castShadow = true;
      this._box(8, towerH - 40, 5, M.railSteel, 0, 64 + towerH / 2, 13, tg); // 导轨
      this._box(70, 14, 50, M.frameMid, 0, 74, 6, tg); // 底部锚座
      this._box(30, 12, 30, M.frameMid, 0, topY + 6, 0, tg); // 顶座
      // 滑车（IK 每帧定位）
      const car = this._box(40, 46, 18, M.frameMid, 0, 200, 22, tg);
      car.castShadow = true;
      const u = { x: -tx / this.TOWER_R, z: -tz / this.TOWER_R }; // 指向中心
      this.towers.push({ x: tx, z: tz, u, car });
      tops.push(V3(tx, topY, tz));
    }
    // 顶环（三根横梁首尾相连）
    for (let i = 0; i < 3; i++) this._beamBetween(tops[i]!, tops[(i + 1) % 3]!, 24, M.frameDark);
    // 顶环灯带 + 舱灯（物理光照单位）
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xf2eee4 });
    this.strips = [];
    for (let i = 0; i < 3; i++) {
      const s = this._beamBetween(
        V3()
          .lerpVectors(tops[i]!, tops[(i + 1) % 3]!, 0.14)
          .setY(topY - 16),
        V3()
          .lerpVectors(tops[i]!, tops[(i + 1) % 3]!, 0.86)
          .setY(topY - 16),
        3,
        null,
        stripMat
      );
      this.strips.push(s);
    }
    const l1 = new THREE.PointLight(0xf4efe4, 30000, 800, 1.9);
    l1.position.set(60, 540, 60);
    const l2 = new THREE.PointLight(0xe6e2d8, 22000, 800, 1.9);
    l2.position.set(-70, 520, -40);
    this.group.add(l1, l2);
    this.chamberLights = [l1, l2];
    this._lightBase = [30000, 22000];

    /* 效应器（组原点 = 喷嘴尖端） */
    const eff = new THREE.Group();
    this.toolhead = eff;
    this.group.add(eff);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 8, 6), M.frameMid);
    plate.position.y = 52;
    plate.castShadow = true;
    eff.add(plate);
    this._cyl(4, 4, 10, M.aluBright, 0, 43, 0, eff, 10); // 喉管
    this._cyl(9, 9, 16, M.aluBright, 0, 30, 0, eff, 14); // 热端散热柱
    this._cyl(11, 11, 2, M.aluBright, 0, 26, 0, eff, 14);
    this._cyl(11, 11, 2, M.aluBright, 0, 34, 0, eff, 14);
    this.heaterBlock = this._box(14, 9, 12, M.copper, 0, 16, 0, eff);
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0xb98f3e,
      metalness: 1.0,
      roughness: 0.3,
      emissive: 0xff5a1e,
      emissiveIntensity: 0,
    });
    this.nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 3.6, 11, 14), nozzleMat);
    this.nozzle.position.set(0, 5.5, 0);
    this.nozzle.rotation.x = Math.PI;
    eff.add(this.nozzle);
    // 侧挂风扇
    this._box(22, 22, 4, M.blackPlastic, 0, 36, 16, eff);
    const rotor = new THREE.Group();
    rotor.position.set(0, 36, 18.5);
    for (let b = 0; b < 5; b++) {
      const blade = this._box(1.8, 8, 0.7, M.frameMid, 0, 0, 0, rotor);
      blade.position.set(Math.cos((b / 5) * Math.PI * 2) * 4.6, Math.sin((b / 5) * Math.PI * 2) * 4.6, 0);
      blade.rotation.z = (b / 5) * Math.PI * 2 + 0.6;
    }
    this.hotFan = rotor;
    eff.add(rotor);
    this._box(14, 18, 14, M.blackPlastic, -16, 30, 0, eff);
    this.partFan = this._cyl(6, 6, 5, M.frameMid, -16, 30, 9, eff);
    this.partFan.rotation.x = Math.PI / 2;
    this._cyl(4, 4, 8, M.aluBright, 0, 60, 0, eff, 10); // 顶部进料
    this._buildStateLED(14, 46, 10, eff);
    this.meltLight = new THREE.PointLight(0xff8a45, 0, 60, 2);
    this.meltLight.position.set(0, 3, 0);
    eff.add(this.meltLight);
    this.nozzleTipLocal = V3(0, 0, 0);

    /* 并联臂（3 塔 × 2 杆，IK 每帧摆位） */
    this._arms = [];
    const rodGeo = new THREE.CylinderGeometry(2.2, 2.2, 1, 8);
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x191918, metalness: 0.4, roughness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const pair: THREE.Mesh[] = [];
      for (let s = 0; s < 2; s++) {
        const rod = new THREE.Mesh(rodGeo, rodMat);
        this.group.add(rod);
        pair.push(rod);
      }
      this._arms.push(pair);
    }

    /* 侧挂料盘（3 号塔外侧） */
    this._box(14, 40, 14, M.frameMid, 0, 505, -226);
    this._box(44, 8, 26, M.frameMid, 0, 522, -216);
    this._buildSpool(0, 548, -238);

    /* 前面板屏 + 电源灯 */
    this._box(130, 64, 12, M.frameMid, 0, 36, 220);
    this._buildScreen(0, 40, 227, 0);
    this._buildPowerLED(58, 40, 227.5);
  }

  /** 两点间放置横梁（矩形截面沿 X 轴建模后绕 Y 旋转） */
  protected _beamBetween(
    a: THREE.Vector3,
    b: THREE.Vector3,
    sect: number,
    mat: THREE.Material | null,
    overrideMat?: THREE.Material
  ): THREE.Mesh {
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, sect, sect), overrideMat || mat!);
    m.position.set((a.x + b.x) / 2, a.y, (a.z + b.z) / 2);
    m.rotation.y = Math.atan2(-dz, dx);
    this.group.add(m);
    return m;
  }

  /* 固定床：虚拟 Z = 效应器高度 */
  protected _applyZ(z: number): void {
    this.toolhead.position.y = this.BED_Y + z;
    this._updateKinematics();
  }

  setHeadXY(mx: number, my: number): void {
    this.headMX = mx;
    this.headMY = my;
    this.toolhead.position.x = mx;
    this.toolhead.position.z = -my;
    this._updateKinematics();
  }

  /** Delta 逆解：滑车高度 = 效应器关节高 + sqrt(L² − 水平距²)，随后摆放 6 根杆 */
  protected _updateKinematics(): void {
    if (!this._arms) return;
    const E_R = 40,
      C_OFF = 35,
      L = this.ARM_L;
    const ex = this.toolhead.position.x,
      ez = this.toolhead.position.z;
    const ejY = this.toolhead.position.y + 52;
    const dir = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      const T = this.towers[i]!;
      const cj = { x: T.x + T.u.x * C_OFF, z: T.z + T.u.z * C_OFF };
      const ej = { x: ex - T.u.x * E_R, z: ez - T.u.z * E_R };
      let h = Math.hypot(cj.x - ej.x, cj.z - ej.z);
      h = Math.min(h, L * 0.98);
      let carY = ejY + Math.sqrt(L * L - h * h);
      carY = clamp(carY, 100, 566);
      T.car.position.y = carY;
      // 双杆（沿切向 ±12mm 平行布置）
      const t = { x: T.u.z, z: -T.u.x };
      for (let s = 0; s < 2; s++) {
        const k = s === 0 ? 12 : -12;
        const ax = cj.x + t.x * k,
          az = cj.z + t.z * k;
        const bx = ej.x + t.x * k,
          bz = ej.z + t.z * k;
        dir.set(bx - ax, ejY - carY, bz - az);
        const len = dir.length();
        const rod = this._arms[i]![s]!;
        rod.position.set((ax + bx) / 2, (carY + ejY) / 2, (az + bz) / 2);
        rod.quaternion.setFromUnitVectors(Y_AXIS, dir.multiplyScalar(1 / len));
        rod.scale.set(1, len, 1);
      }
    }
  }

  protected _tubePts(tip: THREE.Vector3): THREE.Vector3[] {
    return [
      V3(0, 520, -226),
      V3(tip.x * 0.4, tip.y + 170, tip.z * 0.4 - 80),
      V3(tip.x, tip.y + 90, tip.z),
      V3(tip.x, tip.y + 64, tip.z),
    ];
  }
}

/* ══════════════════════════════════════════════════════════════
   FX-500 巨匠 · 工业大幅面龙门（四角丝杆升降 XY 龙门）
   ══════════════════════════════════════════════════════════════ */
export class FXPrinterGantry extends FXPrinterBase {
  /* declare：见 FXPrinterI3 说明。 */
  declare BED_Y: number;
  declare TIP_DZ: number;
  declare beam: THREE.Group;
  declare zGantry: THREE.Group;

  protected _buildMachine(): void {
    this.MODEL_NAME = "FX-500 巨匠";
    this.MODEL_TAG = "FX-500";
    this.KIN_TAG = "IDEX Gantry";
    this.NOZZLE_Y = 360;
    this.BED_Y = 124;
    this.CAM = { pos: V3(820, 660, 980), target: V3(0, 300, 0), topH: 1250 };

    const M = this._mats;
    const orange = new THREE.MeshStandardMaterial({ color: 0xc4551a, metalness: 0.35, roughness: 0.5 });

    /* 重型底座 */
    const base = this._box(580, 80, 540, M.frameDark, 0, 40, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    this._box(584, 8, 544, M.frameMid, 0, 84, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this._box(44, 18, 44, M.blackPlastic, sx * 252, -8, sz * 232);
    // 前缘警示橙条
    for (let i = -1; i <= 1; i++) this._box(70, 7, 5, orange, i * 190, 62, 271);
    // 散热格栅
    for (let i = 0; i < 12; i++) this._box(2.6, 38, 30, M.blackPlastic, -210 + i * 16, 38, 271);

    /* 固定钢结构平台 + 打印面板 */
    const g = new THREE.Group();
    g.position.set(0, this.BED_Y, 0);
    this.bedGroup = g;
    this.group.add(g);
    this._buildBedSurface(g, { glowY: -8 });
    const table = this._box(440, 16, 400, M.frameMid, 0, -14, 0, g);
    table.receiveShadow = true;
    for (let i = -2; i <= 2; i++) this._box(440, 1.5, 6, M.blackPlastic, 0, -5.4, i * 80, g);
    // 平台支撑筋
    this._box(30, 22, 380, M.frameDark, -160, -32, 0, g);
    this._box(30, 22, 380, M.frameDark, 160, -32, 0, g);

    /* 四角立柱 + 丝杆 + 顶部框架 */
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const col = this._box(40, 460, 40, M.frameDark, sx * 250, 312, sz * 220);
        col.castShadow = true;
        this._box(48, 10, 48, M.frameMid, sx * 250, 547, sz * 220);
        this._box(44, 26, 44, orange, sx * 250, 96, sz * 220); // 柱脚警示环
        this._cyl(5, 5, 420, M.aluBright, sx * 220, 312, sz * 190, this.group, 12); // 丝杆
        this._box(42, 42, 42, M.blackPlastic, sx * 220, 552, sz * 190).castShadow = true; // 顶置 Z 电机
        this._cyl(9, 9, 10, M.frameMid, sx * 220, 528, sz * 190);
      }
    this._box(540, 28, 28, M.frameDark, 0, 528, -220).castShadow = true;
    this._box(540, 28, 28, M.frameDark, 0, 528, 220).castShadow = true;
    this._box(28, 28, 480, M.frameDark, -250, 528, 0);
    this._box(28, 28, 480, M.frameDark, 250, 528, 0);
    // 顶部照明灯带 + 泛光（物理光照单位，中性白）
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xf2eee4 });
    this.strips = [this._box(400, 2.5, 5, stripMat, 0, 512, -214), this._box(400, 2.5, 5, stripMat, 0, 512, 214)];
    const l1 = new THREE.PointLight(0xf4efe4, 60000, 1100, 1.9);
    l1.position.set(0, 505, 130);
    const l2 = new THREE.PointLight(0xe6e2d8, 46000, 1100, 1.9);
    l2.position.set(0, 505, -150);
    this.group.add(l1, l2);
    this.chamberLights = [l1, l2];
    this._lightBase = [60000, 46000];

    /* Z 升降龙门环（矩形框架，四角抱柱） */
    const zg = new THREE.Group();
    this.zGantry = zg;
    this.group.add(zg);
    this._box(530, 34, 30, M.frameMid, 0, 0, -220, zg).castShadow = true;
    this._box(530, 34, 30, M.frameMid, 0, 0, 220, zg);
    this._box(30, 34, 470, M.frameMid, -250, 0, 0, zg);
    this._box(30, 34, 470, M.frameMid, 250, 0, 0, zg);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        this._box(52, 70, 52, M.frameDark, sx * 250, 0, sz * 220, zg).castShadow = true;
        this._cyl(8, 8, 38, M.brass, sx * 220, 0, sz * 190, zg);
      }
    this._box(14, 6, 440, M.railSteel, -250, 20, 0, zg);
    this._box(14, 6, 440, M.railSteel, 250, 20, 0, zg);

    /* X 桥梁（沿 Z 滑动 = 模型 Y） */
    const beam = new THREE.Group();
    this.beam = beam;
    zg.add(beam);
    const body = this._box(540, 40, 32, M.frameDark, 0, 0, 0, beam);
    body.castShadow = true;
    this._box(40, 56, 54, M.frameMid, -250, 0, 0, beam);
    this._box(40, 56, 54, M.frameMid, 250, 0, 0, beam);
    this._box(500, 10, 5, M.railSteel, 0, 0, 18, beam);
    this._box(500, 2.6, 3, M.belt, 0, 16, 14, beam);
    this._box(500, 2.6, 3, M.belt, 0, -16, 14, beam);

    /* 重型挤出头 */
    const th = new THREE.Group();
    th.position.set(0, 0, 30);
    this.toolhead = th;
    beam.add(th);
    this._box(56, 70, 10, M.frameMid, 0, 4, -4, th);
    const shell = this._box(62, 74, 34, M.blackPlastic, 0, 8, 14, th);
    shell.castShadow = true;
    for (let i = 0; i < 8; i++) this._box(44, 2, 22, M.aluBright, 0, -26 - i * 3.2, 14, th); // 散热鳍片
    this.heaterBlock = this._box(20, 14, 16, M.copper, 0, -38, 22, th);
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0xb98f3e,
      metalness: 1.0,
      roughness: 0.3,
      emissive: 0xff5a1e,
      emissiveIntensity: 0,
    });
    this.nozzle = new THREE.Mesh(new THREE.CylinderGeometry(1, 4.5, 10, 14), nozzleMat);
    this.nozzle.position.set(0, -47, 22);
    this.nozzle.rotation.x = Math.PI;
    th.add(this.nozzle);
    // 主风扇 + 装饰格栅
    this._box(30, 30, 4, M.blackPlastic, 0, 14, 32, th);
    const rotor = new THREE.Group();
    rotor.position.set(0, 14, 34.5);
    for (let b = 0; b < 5; b++) {
      const blade = this._box(2.2, 11, 0.8, M.frameMid, 0, 0, 0, rotor);
      blade.position.set(Math.cos((b / 5) * Math.PI * 2) * 6, Math.sin((b / 5) * Math.PI * 2) * 6, 0);
      blade.rotation.z = (b / 5) * Math.PI * 2 + 0.6;
    }
    this.hotFan = rotor;
    th.add(rotor);
    this._box(24, 24, 3, M.frameMid, -19, -14, 31.5, th);
    // 物件冷却离心风扇（右侧）
    this._box(22, 28, 24, M.blackPlastic, 36, -12, 12, th);
    this.partFan = this._cyl(9, 9, 6, M.frameMid, 36, -12, 26, th);
    this.partFan.rotation.x = Math.PI / 2;
    this._box(9, 18, 6, M.blackPlastic, 30, -34, 16, th);
    this._cyl(5, 5, 12, M.aluBright, 0, 48, 14, th);
    this._buildStateLED(24, -6, 32, th);
    this.meltLight = new THREE.PointLight(0xff8a45, 0, 70, 2);
    this.meltLight.position.set(0, -50, 22);
    th.add(this.meltLight);
    this.nozzleTipLocal = V3(0, -52, 22);
    this.TIP_DZ = 30 + 22;

    /* 侧立柱料架 */
    this._box(16, 220, 16, M.frameMid, 300, 194, -170);
    this._box(56, 10, 16, M.frameMid, 280, 296, -170);
    this._buildSpool(300, 320, -170);
    this._box(18, 14, 12, M.blackPlastic, 300, 372, -170);

    /* 落地控制台（右前角） */
    this._box(34, 120, 34, M.frameMid, 240, 144, 240);
    const cab = this._box(116, 92, 56, M.frameDark, 240, 232, 240);
    cab.castShadow = true;
    for (let i = 0; i < 5; i++) this._box(90, 2, 3, M.blackPlastic, 240, 200 + i * 5, 268.5);
    this._buildScreen(240, 246, 269, 0);
    this._buildPowerLED(196, 210, 269.5);
  }

  /* 固定平台：虚拟 Z 映射为整体龙门环升降（z=0 时喷嘴尖端贴打印面） */
  protected _applyZ(z: number): void {
    this.zGantry.position.y = this.BED_Y + 52 + z;
  }

  setHeadXY(mx: number, my: number): void {
    this.headMX = mx;
    this.headMY = my;
    this.beam.position.z = -my - this.TIP_DZ;
    this.toolhead.position.x = mx;
  }

  protected _tubePts(tip: THREE.Vector3): THREE.Vector3[] {
    return [
      V3(300, 372, -170),
      V3(220, 585, -100),
      V3(tip.x * 0.5, 580, tip.z * 0.5 - 40),
      V3(tip.x, tip.y + 96, tip.z),
      V3(tip.x, tip.y + 80, tip.z),
    ];
  }
}

/* ══ 注册（顺序 = 选择面板展示顺序） ══ */
FXPrinters.register({
  id: "i3",
  name: "FX-220 轻锋",
  desc: "i3 龙门 · 开放式",
  icon: '<path d="M8 41h44M14 41V12M46 41V12M12 15h36"/><rect x="26" y="15" width="8" height="11"/><path d="M30 26v3M27 29h6l-3 4z"/><path d="M17 37h26"/>',
  cls: FXPrinterI3,
});
FXPrinters.register({
  id: "delta",
  name: "FX-Δ260 迅影",
  desc: "Delta · 并联臂",
  icon: '<path d="M30 5L10 41M30 5l20 36M10 41h40"/><path d="M23 20h14M25 20l4 7M35 20l-4 7"/><path d="M27 27h6l-3 5z"/>',
  cls: FXPrinterDelta,
});
FXPrinters.register({
  id: "gantry",
  name: "FX-500 巨匠",
  desc: "工业龙门 · 大幅面",
  icon: '<rect x="8" y="35" width="44" height="6"/><path d="M12 35V8M48 35V8M12 11h36M12 19h36"/><rect x="26" y="19" width="8" height="9"/><path d="M30 28v2M27 30h6l-3 4z"/>',
  cls: FXPrinterGantry,
});
