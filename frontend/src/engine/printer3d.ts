/* FORGE·X — 3D 打印机仿真建模：机型基类 + CoreXY 旗舰机型（全程序化建模，无外部资产）。
   自 js/printer3d.js 机械迁移：几何/材质/光照数值逐行保留，THREE 改由 npm 包引入（r152 同版）。

   机型契约（sim / scene / ui 只依赖这一层，四款机型完全一致）：
   · NOZZLE_Y            喷嘴平面参考常量（虚拟 Z 契约原点，所有机型取同一值以便 sim 通用）
   · setBedTopY(y)       命令「喷嘴-床面」纵向间距 z = NOZZLE_Y - y；
                         热床下沉机型（CoreXY）映射为床降，固定热床机型（i3/Delta/门架）映射为头升
   · bedTopY             虚拟读数 = NOZZLE_Y - 当前 z（sim 的指数平滑收敛依赖它，与真实床高解耦）
   · getBedWorldY()      床面真实世界高度（固化裁剪面与俯视相机使用）
   · setHeadXY(mx,my)    模型坐标 → 各机型运动轴，保证喷嘴垂直对准沉积点 (mx,-my)（床坐标系）
   · getNozzleTip(out)   喷嘴尖端世界坐标
   · attachPart / beginLayer / setLayerProgress / ... 打印件与逐层挤出可视化（基类统一实现）
   · CAM                 相机预设建议（overview 位置/目标、俯视高度），机型体量不同取景不同
*/
import * as THREE from "three";
import { clamp, deg2rad, mulberry32 } from "./util.ts";
import { buildGeometry, type BuiltModel } from "./models.ts";
import type { SliceLayerOut, SlicePath, SliceResultOut } from "./slicer.ts";
import type { MachineSpec } from "./profile-registry.ts";

const V3 = (x?: number, y?: number, z?: number) => new THREE.Vector3(x, y, z);

export interface PrinterMats {
  frameDark: THREE.MeshStandardMaterial;
  frameMid: THREE.MeshStandardMaterial;
  aluBright: THREE.MeshStandardMaterial;
  railSteel: THREE.MeshStandardMaterial;
  blackPlastic: THREE.MeshStandardMaterial;
  belt: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  acrylic: THREE.MeshPhysicalMaterial;
}

interface LayerEntry {
  path: SlicePath;
  idxStart: number;
  idxCount: number;
  len: number;
  mesh: THREE.Mesh | null;
}

export interface PartTf {
  scale?: number;
  rotZ?: number;
  offX?: number;
  offY?: number;
}

/* ══════════════════════════════════════════════════════════════
   基类：材质库 / 品牌屏与指示灯 / 料盘与送料管 / 打印面板 /
         打印件挂载与逐层挤出可视化 / 虚拟 Z 契约 / 每帧动态
   ══════════════════════════════════════════════════════════════ */
export abstract class FXPrinterBase {
  group: THREE.Group;
  BED_SIZE = 300;

  // 机型契约字段（子类 _buildMachine 设置）
  MODEL_NAME = "";
  MODEL_TAG = "";
  KIN_TAG = "";
  NOZZLE_Y = 0;
  CAM!: { pos: THREE.Vector3; target: THREE.Vector3; topH: number };
  bedGroup!: THREE.Group;
  toolhead!: THREE.Group;
  nozzleTipLocal!: THREE.Vector3;

  // create() 附加
  ID?: string;
  BUILD_VOLUME?: { x: number; y: number; z: number };
  PROFILE?: MachineSpec;

  // 动态状态（由 sim 驱动）
  fanFrac = 0; // 物件冷却风扇 0..1
  nozzleHotFrac = 0;
  bedHotFrac = 0;
  extrudeRate = 0; // mm/s（驱动料盘转动与熔融辉光）
  headMX = 0;
  headMY = 0;

  clipPlane: THREE.Plane;
  partParent: THREE.Group;

  // 共享可选部件（机型差异用可选件表达）
  screenTex?: { cv: HTMLCanvasElement; c: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  powerLED?: THREE.Mesh;
  stateLED!: THREE.Mesh;
  spool?: THREE.Group;
  filWound?: THREE.Mesh;
  tubeMat?: THREE.MeshStandardMaterial;
  ptfe: THREE.Mesh | null = null;
  bedGlow?: THREE.Mesh;
  hotFan?: THREE.Object3D;
  partFan?: THREE.Object3D;
  nozzle?: THREE.Mesh;
  heaterBlock?: THREE.Mesh;
  meltLight?: THREE.PointLight;
  chamberLights?: THREE.PointLight[];
  strips?: THREE.Mesh[];

  protected _mats: PrinterMats;
  protected _z = 0; // 喷嘴-床面纵向间距（虚拟 Z）
  protected _part: THREE.Mesh | THREE.LineSegments | null = null;
  protected _ghost: THREE.Mesh | THREE.LineSegments | null = null;
  protected _layerGroup: THREE.Group | null = null;
  protected _layerEntries: LayerEntry[] = [];
  protected _slicePreview: THREE.Group | null = null;
  protected _toolpathLayerRanges: Array<{ z: number; count: number }> | null = null;
  protected _toolpathStride = 1;
  protected _partUniform?: { value: number };
  protected _grown = 0;
  protected _tubeAcc = 99;
  protected _lightBase?: number[];
  protected _updateExtra?: (dt: number, elapsed: number) => void;

  constructor() {
    this.group = new THREE.Group();

    this._mats = this._makeMaterials();
    this._buildMachine(); // 子类：构建整机（设置 NOZZLE_Y / bedGroup / toolhead / nozzleTipLocal 等）

    // 打印件容器（挂在床坐标系：床动件随、床静件静，两类机型统一）
    this.partParent = new THREE.Group();
    this.bedGroup.add(this.partParent);
    this.clipPlane = new THREE.Plane(V3(0, -1, 0), 0);
    this._part = null;
    this._ghost = null;
    this._layerGroup = null;
    this._layerEntries = [];
    this._slicePreview = null;
    this._toolpathLayerRanges = null;

    this.setBedTopY(this.NOZZLE_Y);
    this.setHeadXY(0, 0);
    this._tubeAcc = 99;
  }

  /* 子类契约 */
  protected abstract _buildMachine(): void;
  protected abstract _applyZ(z: number): void;
  abstract setHeadXY(mx: number, my: number): void;
  protected abstract _tubePts(tip: THREE.Vector3): THREE.Vector3[] | null;

  /* ── 材质 ─────────────────────────────────
     金属基色一律取中性（微暖）灰：metalness 0.8+ 时基色即反射滤色片，
     B 通道偏高会把整机映成蓝调。以下换色均按等亮度（luma 不变）折算，
     只矫正色相、不改变明暗与曝光，保证真实钢/铝/阳极氧化质感 */
  protected _makeMaterials(): PrinterMats {
    return {
      frameDark: new THREE.MeshStandardMaterial({ color: 0x232220, metalness: 0.86, roughness: 0.42 }),
      frameMid: new THREE.MeshStandardMaterial({ color: 0x424140, metalness: 0.8, roughness: 0.34 }),
      aluBright: new THREE.MeshStandardMaterial({ color: 0xa8a6a1, metalness: 0.92, roughness: 0.24 }),
      railSteel: new THREE.MeshStandardMaterial({ color: 0xd5d3ce, metalness: 1.0, roughness: 0.16 }),
      blackPlastic: new THREE.MeshStandardMaterial({ color: 0x161616, metalness: 0.25, roughness: 0.65 }),
      belt: new THREE.MeshStandardMaterial({ color: 0x0e0e0e, metalness: 0.1, roughness: 0.85 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xb98f3e, metalness: 1.0, roughness: 0.32 }),
      copper: new THREE.MeshStandardMaterial({ color: 0x8a5a34, metalness: 1.0, roughness: 0.4 }),
      acrylic: new THREE.MeshPhysicalMaterial({
        color: 0xb5b7b9,
        transparent: true,
        opacity: 0.09,
        roughness: 0.08,
        metalness: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        envMapIntensity: 1.6,
      }),
    };
  }

  protected _box(
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x?: number,
    y?: number,
    z?: number,
    parent?: THREE.Object3D
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    (parent || this.group).add(m);
    return m;
  }
  protected _cyl(
    rt: number,
    rb: number,
    h: number,
    mat: THREE.Material,
    x?: number,
    y?: number,
    z?: number,
    parent?: THREE.Object3D,
    seg?: number
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), mat);
    m.position.set(x || 0, y || 0, z || 0);
    (parent || this.group).add(m);
    return m;
  }

  /* ── 共享部件：品牌屏（程序化纹理） ────── */
  protected _buildScreen(x: number, y: number, z: number, ry?: number): THREE.Group {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 128;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#10131a";
    c.fillRect(0, 0, 256, 128);
    c.fillStyle = "#eef1f6";
    c.font = "700 26px Consolas";
    c.fillText(this.MODEL_TAG, 18, 44);
    c.fillStyle = "#2b323f";
    c.fillRect(18, 62, 220, 8);
    c.fillStyle = "#ff6a2b";
    c.fillRect(18, 62, 96, 8);
    c.fillStyle = "#7c8698";
    c.font = "13px Consolas";
    c.fillText(this.KIN_TAG + " · READY", 18, 96);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex = { cv, c, tex };
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = ry || 0;
    this._box(104, 56, 3, this._mats.blackPlastic, 0, 0, -1, g);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(96, 48), new THREE.MeshBasicMaterial({ map: tex }));
    scr.position.z = 0.9;
    g.add(scr);
    this.group.add(g);
    return g;
  }

  /* 电源指示灯（面板小圆灯）与喷头状态灯（球形），insight 联动闪烁依赖 stateLED */
  protected _buildPowerLED(x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    this.powerLED = this._cyl(2.4, 2.4, 2, new THREE.MeshBasicMaterial({ color: 0xff6a2b }), x, y, z, parent);
    this.powerLED.rotation.x = Math.PI / 2;
    return this.powerLED;
  }
  protected _buildStateLED(x: number, y: number, z: number, parent?: THREE.Object3D): THREE.Mesh {
    this.stateLED = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff6a2b })
    );
    this.stateLED.position.set(x, y, z);
    (parent || this.group).add(this.stateLED);
    return this.stateLED;
  }

  /* ── 共享部件：耗材料盘（挂点由机型决定） ── */
  protected _buildSpool(x: number, y: number, z: number, parent?: THREE.Object3D): void {
    const M = this._mats;
    const sp = new THREE.Group();
    sp.position.set(x, y, z);
    sp.rotation.z = Math.PI / 2; // 轴向 = 世界 X
    this.spool = sp;
    (parent || this.group).add(sp);
    const flangeMat = new THREE.MeshStandardMaterial({
      color: 0x151514,
      metalness: 0.3,
      roughness: 0.5,
      transparent: true,
      opacity: 0.85,
    });
    const f1 = new THREE.Mesh(new THREE.CylinderGeometry(52, 52, 3, 36), flangeMat);
    f1.position.y = 20;
    sp.add(f1);
    const f2 = f1.clone();
    f2.position.y = -20;
    sp.add(f2);
    this._cyl(15, 15, 40, M.blackPlastic, 0, 0, 0, sp, 24);
    // 剩余耗材卷（半径随余量变化）
    this.filWound = new THREE.Mesh(
      new THREE.CylinderGeometry(46, 46, 34, 36),
      new THREE.MeshStandardMaterial({ color: 0x3d6fd6, roughness: 0.6 })
    );
    sp.add(this.filWound);
    // 送料 PTFE 管（动态重建；乳白半透，等亮度去蓝）
    this.tubeMat = new THREE.MeshStandardMaterial({ color: 0xe7e7e6, transparent: true, opacity: 0.5, roughness: 0.3 });
    this.ptfe = null;
  }

  /* ── 共享部件：打印面板（方形/圆形，冷石墨喷砂 + 丝印） ── */
  protected _buildBedSurface(g: THREE.Group, opts?: { round?: boolean; glowY?: number }): THREE.Mesh {
    opts = opts || {};
    const M = this._mats;
    const S = this.BED_SIZE;
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 512;
    const c = cv.getContext("2d")!;
    // 中性石墨喷砂底（等亮度去蓝，仅留极轻微冷感贴合 PEI 涂层）
    const grad = c.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, "#1e1f22");
    grad.addColorStop(0.5, "#25272a");
    grad.addColorStop(1, "#1c1d20");
    c.fillStyle = grad;
    c.fillRect(0, 0, 512, 512);
    const rnd = mulberry32(7);
    for (let i = 0; i < 9000; i++) {
      const v = 28 + rnd() * 42;
      c.fillStyle = `rgba(${v + 10},${v + 11},${v + 13},${0.16 + rnd() * 0.2})`;
      c.fillRect(rnd() * 512, rnd() * 512, 1.2, 1.2);
    }
    if (opts.round) {
      c.strokeStyle = "rgba(150,155,162,0.16)";
      c.lineWidth = 2;
      c.beginPath();
      c.arc(256, 256, 244, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = "rgba(150,155,162,0.10)";
      c.beginPath();
      c.arc(256, 256, 130, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "rgba(170,174,180,0.28)";
      c.font = "600 17px Bahnschrift, Consolas";
      c.textAlign = "center";
      c.fillText("FORGE·X  " + this.MODEL_TAG, 256, 470);
      c.fillText("Ø 256", 256, 62);
    } else {
      c.strokeStyle = "rgba(150,155,162,0.16)";
      c.lineWidth = 2;
      c.strokeRect(10, 10, 492, 492);
      c.fillStyle = "rgba(170,174,180,0.28)";
      c.font = "600 17px Bahnschrift, Consolas";
      c.fillText("FORGE·X  " + this.MODEL_TAG, 22, 496);
      c.textAlign = "right";
      c.fillText("256 · 256", 492, 496);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plateMat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.55, roughness: 0.5 });
    let plate: THREE.Mesh;
    if (opts.round) {
      plate = new THREE.Mesh(new THREE.CircleGeometry(S / 2 + 8, 48), plateMat);
      plate.rotation.x = -Math.PI / 2; // 顶面 = 打印面（y=0）
      g.add(plate);
      // 包边下沉 0.5：顶盖若与打印面共面会产生放射状 z-fighting
      const rim = this._cyl(S / 2 + 8, S / 2 + 8, 6, M.frameMid, 0, -3.5, 0, g, 48);
      rim.receiveShadow = true;
    } else {
      plate = this._box(S, 6, S, plateMat, 0, -3, 0, g);
    }
    plate.receiveShadow = true;
    // 底部加热膜（发热辉光）
    this.bedGlow = new THREE.Mesh(
      opts.round ? new THREE.CircleGeometry(S / 2 + 4, 48) : new THREE.PlaneGeometry(S + 4, S + 4),
      new THREE.MeshBasicMaterial({ color: 0xff7a3c, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.bedGlow.rotation.x = Math.PI / 2;
    this.bedGlow.position.y = opts.glowY != null ? opts.glowY : -12;
    g.add(this.bedGlow);
    return plate;
  }

  /* ══ 虚拟 Z 契约（sim 只关心 y = NOZZLE_Y - z） ══ */

  setBedTopY(y: number): void {
    this._z = this.NOZZLE_Y - y;
    this._applyZ(this._z);
  }
  get bedTopY(): number {
    return this.NOZZLE_Y - this._z;
  }

  /** 床面真实世界高度：热床下沉机型动态、固定热床机型恒定，统一取 bedGroup 高度 */
  getBedWorldY(): number {
    return this.bedGroup.position.y;
  }

  getNozzleTip(out?: THREE.Vector3): THREE.Vector3 {
    out = out || new THREE.Vector3();
    out.copy(this.nozzleTipLocal);
    this.toolhead.localToWorld(out);
    return out;
  }

  setStateLED(hex: number): void {
    (this.stateLED.material as THREE.MeshBasicMaterial).color.setHex(hex);
    (this.powerLED!.material as THREE.MeshBasicMaterial).color.setHex(hex);
  }

  /** 料盘剩余比例（半径视觉反馈） */
  setSpoolFrac(f: number): void {
    const r = 20 + clamp(f, 0, 1) * 26;
    this.filWound!.scale.set(r / 46, 1, r / 46);
  }
  setFilamentColor(hex: number): void {
    (this.filWound!.material as THREE.MeshStandardMaterial).color.setHex(hex);
  }

  /* ══ 打印件 ═════════════════════════════ */

  attachPart(model: BuiltModel, tf: PartTf, colorHex: number, layerH: number): void {
    this.clearPart();
    this.hideSlicePreview(); // 重切片后旧路径预览过期，由 UI 按需重建
    const geo = buildGeometry(model) as THREE.BufferGeometry | null;
    if (!geo) return;
    const uLayerH = { value: layerH / (tf.scale || 1) };
    const mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.5,
      metalness: 0.06,
      side: THREE.DoubleSide,
      clippingPlanes: [this.clipPlane],
      clipShadows: true,
    });
    mat.onBeforeCompile = (sh) => {
      (sh.uniforms as Record<string, unknown>).uLayerH = uLayerH;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLPos;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLPos = position;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vLPos;\nuniform float uLayerH;")
        .replace(
          "#include <dithering_fragment>",
          "float _lp = fract(vLPos.y / max(uLayerH, 0.01));\n" +
            "float _band = smoothstep(0.0, 0.4, _lp) * smoothstep(1.0, 0.6, _lp);\n" +
            "gl_FragColor.rgb *= (0.90 + _band * 0.10);\n" +
            "#include <dithering_fragment>"
        );
    };
    this._partUniform = uLayerH;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    this._applyTf(mesh, tf);
    mesh.visible = false;
    this.partParent.add(mesh);
    this._part = mesh;

    // 幽灵预览（切片完成、未开始打印时显示）
    const gmat = new THREE.MeshBasicMaterial({
      color: 0xff6a2b,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    const ghost = new THREE.Mesh(geo, gmat);
    this._applyTf(ghost, tf);
    ghost.renderOrder = 3;
    this.partParent.add(ghost);
    this._ghost = ghost;
    this.setGrownHeight(0);
  }

  /** 真实 G-code 没有成品三角网格：用分层线框作为幽灵与已完成层累计显示。 */
  attachToolpath(slice: SliceResultOut, colorHex: number): void {
    this.clearPart();
    this.hideSlicePreview();
    const maxSegments = 400000;
    let totalSegments = 0;
    for (const layer of slice.layers) for (const path of layer.paths) totalSegments += Math.max(0, path.pts.length - 1);
    const stride = Math.max(1, Math.ceil(totalSegments / maxSegments));
    const positions: number[] = [];
    const ranges: Array<{ z: number; count: number }> = [];
    let seen = 0;
    for (const layer of slice.layers) {
      for (const path of layer.paths) {
        for (let i = 1; i < path.pts.length; i++) {
          if (seen % stride === 0) {
            const a = path.pts[i - 1]!,
              b = path.pts[i]!;
            positions.push(a.x, layer.z, -a.y, b.x, layer.z, -b.y);
          }
          seen++;
        }
      }
      ranges.push({ z: layer.z, count: positions.length / 3 });
    }
    if (!positions.length) return;
    const makeGeometry = () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      return geo;
    };
    const partMat = new THREE.LineBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: stride > 1 ? 0.7 : 0.9,
    });
    const part = new THREE.LineSegments(makeGeometry(), partMat);
    part.geometry.setDrawRange(0, 0);
    part.visible = false;
    this.partParent.add(part);
    this._part = part;

    const ghost = new THREE.LineSegments(
      makeGeometry(),
      new THREE.LineBasicMaterial({ color: 0xff6a2b, transparent: true, opacity: 0.13, depthWrite: false })
    );
    ghost.renderOrder = 3;
    this.partParent.add(ghost);
    this._ghost = ghost;
    this._toolpathLayerRanges = ranges;
    this._toolpathStride = stride;
    this.setGrownHeight(0);
  }

  protected _applyTf(mesh: THREE.Object3D, tf: PartTf): void {
    mesh.scale.setScalar(tf.scale || 1);
    mesh.rotation.y = deg2rad(tf.rotZ || 0);
    mesh.position.set(tf.offX || 0, 0.01, -(tf.offY || 0));
  }

  updatePartTf(tf: PartTf): void {
    if (this._part) this._applyTf(this._part, tf);
    if (this._ghost) this._applyTf(this._ghost, tf);
  }

  showGhost(v: boolean): void {
    if (this._ghost) this._ghost.visible = v;
  }
  showPart(v: boolean): void {
    if (this._part) this._part.visible = v;
  }

  /** 已固化高度（世界 mm，相对打印面） */
  setGrownHeight(h: number): void {
    this._grown = h;
    if (!this._part) return;
    this._part.visible = h > 0.001;
    if (this._toolpathLayerRanges && this._part.geometry) {
      let count = 0;
      for (const r of this._toolpathLayerRanges) {
        if (r.z <= h + 1e-6) count = r.count;
        else break;
      }
      this._part.geometry.setDrawRange(0, count);
    }
  }

  clearPart(): void {
    for (const m of [this._part, this._ghost]) {
      if (!m) continue;
      this.partParent.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this._part = this._ghost = null;
    this._toolpathLayerRanges = null;
    this._toolpathStride = 1;
    this.endLayer();
  }

  /* ── 当前层挤出可视化（管束 + 渐进揭示） ── */

  beginLayer(paths: SlicePath[], zTop: number, layerH: number, colors: Record<string, number>): void {
    this.endLayer();
    const g = new THREE.Group();
    g.position.y = Math.max(0.05, zTop - layerH * 0.45);
    this.partParent.add(g);
    this._layerGroup = g;
    this._layerEntries = [];

    const radius = Math.max(0.28, layerH * 0.7);
    let run: SlicePath[] = [];
    let runType: string | null = null;
    const flush = () => {
      if (!run.length) return;
      this._buildRun(run, runType!, radius, colors, g);
      run = [];
    };
    for (const p of paths) {
      if (p.type !== runType) {
        flush();
        runType = p.type;
      }
      run.push(p);
    }
    flush();
  }

  protected _buildRun(
    paths: SlicePath[],
    type: string,
    radius: number,
    colors: Record<string, number>,
    parent: THREE.Group
  ): void {
    const posArr: number[] = [],
      normArr: number[] = [],
      idxArr: number[] = [];
    let vOff = 0;
    const entries: LayerEntry[] = [];
    for (const p of paths) {
      // 无法成管的路径也要占位（len 参与累计），否则揭示进度与 sim 的挤出里程失去对齐
      const skip = () => entries.push({ path: p, idxStart: 0, idxCount: 0, len: p.len ?? 0, mesh: null });
      if (p.pts.length < 2 || (p.len ?? 0) < 0.4) {
        skip();
        continue;
      }
      // 去除近重合点，避免零长曲线导致 Frenet 帧 NaN
      const raw = p.pts.map((q) => V3(q.x, 0, -q.y));
      const pts3 = [raw[0]!];
      for (let i = 1; i < raw.length; i++) if (raw[i]!.distanceTo(pts3[pts3.length - 1]!) > 0.04) pts3.push(raw[i]!);
      if (pts3.length < 2) {
        skip();
        continue;
      }
      const curve = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < pts3.length; i++) curve.add(new THREE.LineCurve3(pts3[i - 1]!, pts3[i]!));
      const segs = clamp(Math.round((p.len ?? 0) / 1.6), Math.max(2, pts3.length - 1), 900);
      const r = type === "support" ? radius * 0.55 : radius;
      let tg: THREE.TubeGeometry;
      try {
        tg = new THREE.TubeGeometry(curve, segs, r, 5, false);
      } catch {
        skip();
        continue;
      }
      const tp = tg.attributes.position!.array;
      const tn = tg.attributes.normal!.array;
      const ti = tg.index!.array;
      const idxStart = idxArr.length;
      for (let i = 0; i < tp.length; i++) posArr.push(tp[i]!);
      for (let i = 0; i < tn.length; i++) normArr.push(tn[i]!);
      for (let i = 0; i < ti.length; i++) idxArr.push(ti[i]! + vOff);
      vOff += tg.attributes.position!.count;
      entries.push({ path: p, idxStart, idxCount: ti.length, len: p.len ?? 0, mesh: null });
      tg.dispose();
    }
    if (!entries.length) return;
    if (posArr.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(normArr, 3));
      geo.setIndex(idxArr);
      const mat = new THREE.MeshStandardMaterial({
        color: colors[type] != null ? colors[type] : 0x9aa4b5,
        roughness: 0.55,
        metalness: 0.05,
      });
      if (type === "support") {
        mat.color.setHex(colors.support!);
        mat.transparent = true;
        mat.opacity = 0.85;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.geometry.setDrawRange(0, 0);
      parent.add(mesh);
      for (const e of entries) if (e.idxCount > 0) e.mesh = mesh;
    }
    this._layerEntries.push(...entries);
  }

  /** 按「已挤出长度」揭示管束；paths 顺序必须与 beginLayer 一致 */
  setLayerProgress(extDist: number): void {
    let acc = 0;
    const perMesh = new Map<THREE.Mesh, number>();
    for (const e of this._layerEntries) {
      let show = 0;
      if (extDist >= acc + e.len) show = e.idxCount;
      else if (extDist > acc) {
        const t = (extDist - acc) / e.len;
        // 对齐到管段（每管环 5 段 × 6 索引 = 30）
        show = Math.floor((t * e.idxCount) / 30) * 30;
      }
      acc += e.len;
      if (!e.mesh) continue; // 占位条目（未成管）只参与里程累计
      if (show > 0) {
        const end = e.idxStart + show;
        const cur = perMesh.get(e.mesh) || 0;
        if (end > cur) perMesh.set(e.mesh, end);
      } else if (!perMesh.has(e.mesh)) perMesh.set(e.mesh, 0);
    }
    for (const [mesh, count] of perMesh) mesh.geometry.setDrawRange(0, count);
  }

  endLayer(): void {
    if (!this._layerGroup) return;
    this._layerGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
    this.partParent.remove(this._layerGroup);
    this._layerGroup = null;
    this._layerEntries = [];
  }

  /* ── 切片路径 3D 预览（真实切片数据直接画进视口，与 2D 面板同源） ── */

  /** layer: 切片层对象 { z, paths }；colors: { perimeter/solid/infill/support/skirt: hex } */
  showSlicePreview(layer: SliceLayerOut | null, colors: Record<string, number>): void {
    this.hideSlicePreview();
    if (!layer) return;
    const g = new THREE.Group();
    g.position.y = Math.max(0.06, layer.z);
    // 按类型合并线段（一类一次 draw call）
    const byType = new Map<string, number[]>();
    for (const p of layer.paths) {
      if (p.pts.length < 2) continue;
      if (!byType.has(p.type)) byType.set(p.type, []);
      const arr = byType.get(p.type)!;
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1]!,
          b = p.pts[i]!;
        arr.push(a.x, 0, -a.y, b.x, 0, -b.y);
      }
    }
    for (const [type, arr] of byType) {
      if (!arr.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({
        color: colors[type] != null ? colors[type] : 0x9aa4b5,
        transparent: true,
        opacity: type === "infill" ? 0.55 : type === "support" ? 0.5 : 0.95,
        depthWrite: false,
      });
      const seg = new THREE.LineSegments(geo, mat);
      seg.renderOrder = 4;
      g.add(seg);
    }
    this.partParent.add(g);
    this._slicePreview = g;
  }

  hideSlicePreview(): void {
    if (!this._slicePreview) return;
    this._slicePreview.traverse((o) => {
      const seg = o as THREE.LineSegments;
      if (seg.isLineSegments) {
        seg.geometry.dispose();
        (seg.material as THREE.Material).dispose();
      }
    });
    this.partParent.remove(this._slicePreview);
    this._slicePreview = null;
  }

  /* ══ 每帧动态（部件存在才驱动，机型差异用可选件表达） ══ */

  update(dt: number, elapsed: number): void {
    // 风扇
    if (this.hotFan) this.hotFan.rotation.z += dt * (2 + (this.nozzleHotFrac > 0.12 ? 26 : 0));
    if (this.partFan) this.partFan.rotation.y += dt * this.fanFrac * 34;
    // 喷嘴/热床辉光
    if (this.nozzle) (this.nozzle.material as THREE.MeshStandardMaterial).emissiveIntensity = this.nozzleHotFrac * 0.55;
    if (this.bedGlow) (this.bedGlow.material as THREE.MeshBasicMaterial).opacity = this.bedHotFrac * 0.16;
    if (this.meltLight) this.meltLight.intensity = this.extrudeRate > 0.5 ? 900 + Math.sin(elapsed * 21) * 250 : 0;
    // 料盘转动（绕自身轴，挤出速率 → 角速度）
    if (this.filWound && this.extrudeRate > 0.1) {
      this.filWound.rotation.y += (dt * this.extrudeRate) / 46;
    }
    // 固化裁剪面（世界系，按床面真实高度每帧更新）
    this.clipPlane.constant = this.getBedWorldY() + (this._grown || 0);
    // 灯带轻微呼吸
    if (this.chamberLights) {
      const b = 0.9 + Math.sin(elapsed * 1.2) * 0.08;
      this.chamberLights.forEach((l, i) => {
        l.intensity = this._lightBase![i]! * b;
      });
    }
    if (this._updateExtra) this._updateExtra(dt, elapsed);
    // 送料管重建（头部移动超过阈值时）
    this._tubeAcc += dt;
    if (this._tubeAcc > 0.09 && this.tubeMat) {
      this._tubeAcc = 0;
      this._rebuildTube();
    }
  }

  protected _rebuildTube(): void {
    if (this.ptfe) {
      this.ptfe.geometry.dispose();
      this.group.remove(this.ptfe);
      this.ptfe = null;
    }
    const tip = this.getNozzleTip(V3());
    const pts = this._tubePts(tip);
    if (!pts || pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.35);
    const geo = new THREE.TubeGeometry(curve, 26, 2, 6, false);
    this.ptfe = new THREE.Mesh(geo, this.tubeMat!);
    this.ptfe.renderOrder = 2;
    this.group.add(this.ptfe);
  }

  /** 机型切换时释放 GPU 资源（几何体 / 材质 / 程序化纹理） */
  dispose(): void {
    this.clearPart();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        const mapped = m as THREE.Material & { map?: THREE.Texture | null };
        if (mapped.map) mapped.map.dispose();
        m.dispose();
      }
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   FX-256 睿造 · CoreXY 封闭式旗舰
   铝型材框架 / 透明防护罩 / XY 龙门与同步带 / 挤出头组件 /
   三丝杆热床（打印时热床下沉）/ 耗材料盘 / 舱内灯带 / 基座电控屏
   ══════════════════════════════════════════════════════════════ */
export class FXPrinterCoreXY extends FXPrinterBase {
  beam!: THREE.Group;
  TIP_DZ = 0;
  protected screwPos!: Array<[number, number]>;
  protected frameDims!: { HX: number; HZ: number; Y0: number; Y1: number };

  protected _buildMachine(): void {
    this.MODEL_NAME = "FX-256 睿造";
    this.MODEL_TAG = "FX-256";
    this.KIN_TAG = "CoreXY";
    // 喷嘴尖端固定世界高度 = 龙门平面 384 − 喷头组件尖端偏移 49.5（热床下沉式机型）
    this.NOZZLE_Y = 334.5;
    this.CAM = { pos: V3(620, 520, 760), target: V3(0, 250, 0), topH: 1000 };

    this._buildBase();
    this._buildFrame();
    this._buildPanels();
    this._buildZDrive();
    this._buildBed();
    this._buildGantry();
    this._buildToolhead();
    this._buildSpoolRig();
    this._buildChamberLights();
  }

  /* 热床下沉：z 直接映射为床组高度 */
  protected _applyZ(z: number): void {
    this.bedGroup.position.y = this.NOZZLE_Y - z;
  }

  /* ── 基座（电控仓） ───────────────────── */
  protected _buildBase(): void {
    const M = this._mats;
    const base = this._box(444, 64, 444, M.frameDark, 0, 32, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    // 顶盖板
    this._box(448, 5, 448, M.frameMid, 0, 66, 0);
    // 散热格栅
    for (let i = 0; i < 9; i++) {
      this._box(2.5, 30, 26, M.blackPlastic, -160 + i * 14, 30, 223);
      this._box(2.5, 30, 26, M.blackPlastic, -160 + i * 14, 30, -223);
    }
    // 底脚
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this._cyl(16, 18, 10, M.blackPlastic, sx * 195, -3, sz * 195);
    // 前面板电控屏 + 电源灯
    this._buildScreen(118, 34, 221.8, 0);
    this._buildPowerLED(-150, 34, 222.5);
  }

  /* ── 铝型材框架 ───────────────────────── */
  protected _buildFrame(): void {
    const M = this._mats;
    const HX = 210,
      HZ = 210,
      Y0 = 69,
      Y1 = 496;
    const ext = 22; // 型材截面
    // 立柱
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const col = this._box(ext, Y1 - Y0, ext, M.frameDark, sx * HX, (Y0 + Y1) / 2, sz * HZ);
        col.castShadow = true;
        // 型材凹槽细节
        this._box(4, Y1 - Y0, 3, M.blackPlastic, sx * (HX - ext / 2), (Y0 + Y1) / 2, sz * HZ);
      }
    // 顶部横梁环
    const ringY = Y1 - ext / 2;
    this._box(HX * 2 + ext, ext, ext, M.frameDark, 0, ringY, -HZ).castShadow = true;
    this._box(HX * 2 + ext, ext, ext, M.frameDark, 0, ringY, HZ).castShadow = true;
    this._box(ext, ext, HZ * 2 - ext, M.frameDark, -HX, ringY, 0);
    this._box(ext, ext, HZ * 2 - ext, M.frameDark, HX, ringY, 0);
    // 龙门层横梁（承载 XY 运动系统）
    const gy = 384;
    this._box(ext, ext, HZ * 2 - ext, M.frameDark, -HX, gy, 0);
    this._box(ext, ext, HZ * 2 - ext, M.frameDark, HX, gy, 0);
    // 角码
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        this._box(30, 30, 30, M.frameMid, sx * (HX - 4), Y1 - 34, sz * (HZ - 4));
      }
    this.frameDims = { HX, HZ, Y0, Y1 };
  }

  /* ── 透明防护罩 ───────────────────────── */
  protected _buildPanels(): void {
    const M = this._mats;
    const { HX, HZ, Y0, Y1 } = this.frameDims;
    const h = Y1 - Y0 - 30,
      cy = (Y0 + Y1) / 2;
    const mk = (w: number, hh: number, x: number, y: number, z: number, ry?: number) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), M.acrylic);
      p.position.set(x, y, z);
      p.rotation.y = ry || 0;
      p.renderOrder = 5;
      this.group.add(p);
      return p;
    };
    mk(HX * 2 - 30, h, 0, cy, HZ - 2, 0); // 前（门）
    mk(HX * 2 - 30, h, 0, cy, -HZ + 2, Math.PI); // 后
    mk(HZ * 2 - 30, h, -HX + 2, cy, 0, Math.PI / 2); // 左
    mk(HZ * 2 - 30, h, HX - 2, cy, 0, -Math.PI / 2); // 右
    const top = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2 - 30, HZ * 2 - 30), M.acrylic);
    top.rotation.x = -Math.PI / 2;
    top.position.set(0, Y1 + 1, 0);
    top.renderOrder = 5;
    this.group.add(top);
    // 前门竖向拉手 + 铰链
    this._box(6, 150, 8, M.aluBright, 150, cy, HZ + 4);
    this._box(10, 22, 6, M.frameMid, -HX + 24, cy + 90, HZ + 2);
    this._box(10, 22, 6, M.frameMid, -HX + 24, cy - 90, HZ + 2);
  }

  /* ── Z 轴驱动（三丝杆 + 电机） ─────────── */
  protected _buildZDrive(): void {
    const M = this._mats;
    this.screwPos = [
      [-150, -150],
      [150, -150],
      [0, 168],
    ];
    for (const [x, z] of this.screwPos) {
      // 丝杆
      const screw = this._cyl(3.4, 3.4, 268, M.aluBright, x, 204, z, this.group, 14);
      screw.castShadow = false;
      // 螺旋纹理感（细环）
      for (let i = 0; i < 9; i++) this._cyl(3.9, 3.9, 1, M.frameMid, x, 90 + i * 28, z);
      // 底部电机（NEMA17）
      const mot = this._box(40, 40, 40, M.blackPlastic, x, 90, z);
      mot.castShadow = true;
      this._cyl(12, 12, 4, M.aluBright, x, 112, z);
      this._box(42, 2, 42, M.frameMid, x, 71, z);
    }
  }

  /* ── 热床组件（随打印下沉） ─────────────── */
  protected _buildBed(): void {
    const M = this._mats;
    const g = new THREE.Group(); // 原点 = 打印面
    this.bedGroup = g;
    this.group.add(g);
    const S = this.BED_SIZE;
    this._buildBedSurface(g, { glowY: -14.4 });
    // 铝基板
    this._box(S + 12, 7, S + 12, M.frameMid, 0, -10, 0, g);
    // 支撑横梁
    this._box(S + 40, 10, 24, M.frameDark, 0, -20, -150, g);
    this._box(S + 40, 10, 24, M.frameDark, 0, -20, 150, g);
    this._box(24, 10, S + 30, M.frameDark, -150, -20, 0, g);
    this._box(24, 10, S + 30, M.frameDark, 150, -20, 0, g);
    // 丝杆螺母座（对应三根丝杆位置）
    for (const [x, z] of this.screwPos) {
      this._box(26, 30, 26, M.frameMid, x, -22, z, g);
      this._cyl(7, 7, 32, M.brass, x, -22, z, g);
    }
    // 走线
    this._box(60, 6, 14, M.blackPlastic, -120, -16, 158, g);
  }

  /* ── XY 龙门（CoreXY） ─────────────────── */
  protected _buildGantry(): void {
    const M = this._mats;
    const GY = 384; // 龙门平面高度
    const { HX, HZ } = this.frameDims;

    // Y 向直线导轨（左右）
    for (const sx of [-1, 1]) {
      this._box(14, 8, HZ * 2 - 40, M.railSteel, sx * (HX - 20), GY + 15, 0);
      // 同步带（Y 向）
      this._box(7, 2, HZ * 2 - 60, M.belt, sx * (HX - 34), GY + 10, 0);
      this._box(7, 2, HZ * 2 - 60, M.belt, sx * (HX - 34), GY + 20, 0);
    }
    // 后部 XY 步进电机 + 皮带轮
    for (const sx of [-1, 1]) {
      const mot = this._box(42, 42, 42, M.blackPlastic, sx * (HX - 36), GY - 12, -(HZ - 36));
      mot.castShadow = true;
      this._cyl(9, 9, 8, M.frameMid, sx * (HX - 36), GY + 16, -(HZ - 36));
      this._cyl(11, 11, 3, M.aluBright, sx * (HX - 36), GY - 36, -(HZ - 36));
    }
    // 前部惰轮
    for (const sx of [-1, 1]) this._cyl(7, 7, 10, M.frameMid, sx * (HX - 34), GY + 15, HZ - 34);

    // X 横梁组（沿 Z 移动 = 模型 Y）
    const beam = new THREE.Group();
    beam.position.y = GY;
    this.beam = beam;
    this.group.add(beam);
    const beamBody = this._box(HX * 2 - 52, 30, 24, M.frameDark, 0, 8, 0, beam);
    beamBody.castShadow = true;
    // X 直线导轨（横梁正面）
    this._box(HX * 2 - 70, 9, 5, M.railSteel, 0, 8, 14, beam);
    // X 同步带
    this._box(HX * 2 - 70, 2.4, 3, M.belt, 0, 22, 10, beam);
    this._box(HX * 2 - 70, 2.4, 3, M.belt, 0, -6, 10, beam);
    // 梁端滑块
    this._box(34, 44, 46, M.frameMid, -(HX - 33), 8, 0, beam).castShadow = true;
    this._box(34, 44, 46, M.frameMid, HX - 33, 8, 0, beam);
  }

  /* ── 挤出头组件 ───────────────────────── */
  protected _buildToolhead(): void {
    const M = this._mats;
    const th = new THREE.Group();
    this.toolhead = th;
    th.position.set(0, 0, 22); // 挂在横梁正面
    this.beam.add(th);

    // 滑块 + 主板
    this._box(40, 42, 10, M.frameMid, 0, 8, 0, th);
    const shell = this._box(46, 58, 26, M.blackPlastic, 0, 2, 16, th);
    shell.castShadow = true;
    // 散热鳍片
    for (let i = 0; i < 7; i++) this._box(34, 1.8, 20, M.aluBright, 0, -12 - i * 3.1, 16, th);
    // 热端风扇（正面，旋转）
    this._box(30, 30, 4, M.blackPlastic, 0, -20, 30, th);
    this._cyl(3.5, 3.5, 5, M.frameMid, 0, -20, 31, th).rotation.x = Math.PI / 2;
    const rotor = new THREE.Group();
    rotor.position.set(0, -20, 32.5);
    for (let b = 0; b < 5; b++) {
      const blade = this._box(2.2, 11, 0.8, M.frameMid, 0, 0, 0, rotor);
      blade.position.set(Math.cos((b / 5) * Math.PI * 2) * 6, Math.sin((b / 5) * Math.PI * 2) * 6, 0);
      blade.rotation.z = (b / 5) * Math.PI * 2 + 0.6;
    }
    this.hotFan = rotor;
    th.add(rotor);
    // 物件冷却离心风扇（侧挂 + 导风嘴）
    const blower = this._box(20, 26, 22, M.blackPlastic, -30, -22, 14, th);
    blower.castShadow = true;
    this.partFan = this._cyl(8, 8, 6, M.frameMid, -30, -22, 26, th);
    this.partFan.rotation.x = Math.PI / 2;
    this._box(8, 16, 6, M.blackPlastic, -24, -38, 18, th);
    // 加热块 + 喷嘴
    this.heaterBlock = this._box(16, 11, 12, M.copper, 0, -36, 16, th);
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: 0xb98f3e,
      metalness: 1.0,
      roughness: 0.3,
      emissive: 0xff5a1e,
      emissiveIntensity: 0,
    });
    this.nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 3.4, 8, 14), nozzleMat);
    this.nozzle.position.set(0, -45.5, 16);
    this.nozzle.rotation.x = Math.PI;
    th.add(this.nozzle);
    // 熔融辉光点光源（挤出时开启）
    this.meltLight = new THREE.PointLight(0xff8a45, 0, 60, 2);
    this.meltLight.position.set(0, -47, 16);
    th.add(this.meltLight);
    // 状态 LED
    this._buildStateLED(18, -6, 30, th);
    // 顶部进料接头
    this._cyl(4, 4, 10, M.aluBright, 0, 34, 16, th);
    // 喷嘴尖端相对 toolhead 原点的偏移（世界换算用）
    this.nozzleTipLocal = V3(0, -49.5, 16);
    // 尖端相对横梁的 Z 偏移总量 = toolhead 挂装 22 + 尖端局部 16
    this.TIP_DZ = 22 + 16;
  }

  /* ── 耗材料盘（侧挂支架 + 断料传感器） ──
     挂点取右侧板纵向中部（z=-40）：overview 视角下若挂在 z=-110，
     耗材卷会正好横腰遮断右后立柱，立柱下半段看起来像一根悬空短柱 */
  protected _buildSpoolRig(): void {
    const M = this._mats;
    this._buildSpool(238, 300, -40);
    // 支架
    this._box(10, 60, 10, M.frameMid, 238, 250, -40);
    this._box(40, 6, 30, M.frameMid, 224, 222, -40);
    // 断料传感器盒
    this._box(18, 14, 12, M.blackPlastic, 238, 352, -40);
  }

  /* ── 舱内照明（中性白，避免给金属机身染蓝） ── */
  protected _buildChamberLights(): void {
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xf2eee4 });
    const s1 = this._box(360, 2.5, 5, stripMat, 0, 481, 196);
    const s2 = this._box(360, 2.5, 5, stripMat, 0, 481, -196);
    this.strips = [s1, s2];
    // r155+ 物理光照单位：点光源强度需按 mm 距离平方量级设定
    const l1 = new THREE.PointLight(0xf4efe4, 52000, 900, 1.9);
    l1.position.set(0, 460, 130);
    const l2 = new THREE.PointLight(0xe6e2d8, 36000, 900, 1.9);
    l2.position.set(0, 440, -150);
    this.group.add(l1, l2);
    this.chamberLights = [l1, l2];
    this._lightBase = [52000, 36000];
  }

  /* ══ 运动映射 ═══════════════════════════ */

  /** 模型坐标 (mx,my) → 世界：x=mx, z=-my。
      喷嘴尖端相对横梁存在 +Z 偏移（toolhead 挂梁前 22 + 尖端局部 16 = 38），
      此处反向补偿，保证喷嘴尖端正好落在 (mx, -my) 沉积点上方。 */
  setHeadXY(mx: number, my: number): void {
    this.headMX = mx;
    this.headMY = my;
    this.beam.position.z = -my - this.TIP_DZ;
    this.toolhead.position.x = mx;
  }

  protected _tubePts(tip: THREE.Vector3): THREE.Vector3[] {
    // 起点跟随断料传感器盒（_buildSpoolRig 挂点 z=-40）
    const headTop = V3(tip.x, 384 + 40, tip.z + 16);
    return [
      V3(238, 356, -40),
      V3(215, 430, -46),
      V3(headTop.x * 0.55 + 40, 468, headTop.z * 0.5 - 60),
      V3(headTop.x, headTop.y + 26, headTop.z),
      headTop,
    ];
  }
}

/* ══ 机型注册表（printers.ts 追加其余机型） ══ */

export interface PrinterDef {
  id: string;
  name?: string;
  desc?: string;
  icon?: string;
  cls: new () => FXPrinterBase;
  profile?: MachineSpec;
  community?: boolean;
}

export const FXPrinters = {
  list: [] as PrinterDef[],
  register(def: PrinterDef): PrinterDef {
    const old = this.list.find((x) => x.id === def.id);
    if (old) Object.assign(old, def);
    else this.list.push(def);
    return old || def;
  },
  registerProfile(profile: MachineSpec | null | undefined): PrinterDef | null {
    if (!profile) return null;
    const baseId = ({ corexy: "corexy", i3: "i3", delta: "delta", gantry: "gantry" } as Record<string, string>)[
      profile.kinematics
    ];
    const base = this.list.find((x) => x.id === baseId);
    if (!base) return null;
    const old = this.list.find((x) => x.id === profile.id);
    const def =
      old ||
      ({
        id: profile.id,
        cls: base.cls,
        icon: base.icon,
      } as PrinterDef);
    def.name = profile.name;
    def.desc = profile.description;
    def.profile = profile;
    def.community = !!profile.community;
    if (!old) this.list.push(def);
    return def;
  },
  create(id: string): FXPrinterBase {
    const d = this.list.find((x) => x.id === id) || this.list[0]!;
    const p = new d.cls();
    p.ID = d.id;
    if (d.profile) {
      p.MODEL_NAME = d.profile.name;
      p.MODEL_TAG = d.profile.tag;
      p.KIN_TAG = d.profile.kinematics;
      p.BUILD_VOLUME = Object.assign({}, d.profile.buildVolume);
      p.BED_SIZE = Math.max(d.profile.buildVolume.x, d.profile.buildVolume.y);
      p.PROFILE = d.profile;
      /* 原实现读 screenTex.image（CanvasTexture 字段名为 image），
         而基类存的是 {cv,c,tex} —— 条件恒 false，屏幕重绘从未执行。
         机械迁移保留该行为（不重绘），避免引入视觉差异。 */
      const tex = p.screenTex as unknown as { image?: HTMLCanvasElement; needsUpdate?: boolean } | undefined;
      if (tex && tex.image && typeof tex.image.getContext === "function") {
        const cv = tex.image;
        const c = cv.getContext("2d")!;
        c.fillStyle = "#10131a";
        c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = "#ff6a2b";
        c.font = "bold 18px monospace";
        c.fillText(p.MODEL_TAG, 14, 28);
        c.fillStyle = "#c9d0db";
        c.font = "13px monospace";
        c.fillText(p.KIN_TAG.toUpperCase() + " · READY", 14, 55);
        c.fillStyle = "#697387";
        c.fillText(`${p.BUILD_VOLUME!.x}×${p.BUILD_VOLUME!.y}×${p.BUILD_VOLUME!.z} mm`, 14, 82);
        tex.needsUpdate = true;
      }
    }
    return p;
  },
};

FXPrinters.register({
  id: "corexy",
  name: "FX-256 睿造",
  desc: "CoreXY · 封闭腔体",
  icon: '<rect x="10" y="5" width="40" height="36" rx="2"/><path d="M10 13h40M22 13v5h16v-5M30 18v5M27 23h6l-3 5z"/><path d="M14 41v3M46 41v3"/>',
  cls: FXPrinterCoreXY,
});
