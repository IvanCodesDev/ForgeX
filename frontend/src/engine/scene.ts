/* FORGE·X — 场景：渲染器 / 中性影棚环境光 / 深蓝灰工程网格空间 / 相机预设。
   自 js/scene.js 机械迁移：逻辑逐行保留，THREE 改由 npm 包引入（r152 同版），
   打印机注册表与机群视图均为直接 import。 */
import * as THREE from "three";
import { FXOrbit } from "./orbit.ts";
import { View as FleetView } from "./fleet-view.ts";
import { FXPrinters, type FXPrinterBase } from "./printer3d.ts";
import "./printers.ts"; // 副作用：注册 i3 / delta / gantry 机型

export class FXScene {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: FXOrbit;
  printer: FXPrinterBase;
  fleet: FleetView;
  camMode: string;
  onTick: ((dt: number, t: number) => void) | null;

  private _clock: THREE.Clock;
  private _tmpV: THREE.Vector3;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 本项目光照按 r155+ 物理单位标定（见 printer3d.js 舱内点光源 52000/36000）。
    // r152~r154（useLegacyLights 默认 true 的旧版）的 legacy 衰减会把
    // 900mm 范围内全部打成纯白过曝，必须显式切回物理光照；r155+ 本身即默认 false。
    const legacyRenderer = renderer as THREE.WebGLRenderer & { useLegacyLights?: boolean };
    if (parseInt(THREE.REVISION, 10) < 155 && "useLegacyLights" in legacyRenderer) {
      legacyRenderer.useLegacyLights = false;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    // 雾色近中性（等亮度微冷）：FogExp2 在整机距离上混入约 15%+，
    // 旧蓝灰雾会持续给金属机身罩蓝调；地面/穹顶自身颜色不受此影响
    this.scene.fog = new THREE.FogExp2(0x292a2e, 0.00044);

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 5, 8000);
    this.orbit = new FXOrbit(this.camera, canvas);

    this._buildEnvironment();
    this._buildLights();
    this._buildFloorAndBackdrop();

    this.printer = FXPrinters.create("corexy");
    this.scene.add(this.printer.group);

    // 机群视图：与详细打印机模型互斥显示（见 fleet-view 的设计取舍）
    this.fleet = new FleetView(this.scene);

    this.camMode = "overview";
    this.setCameraPreset("overview", true);

    window.addEventListener("resize", () => this.resize());
    this.resize();

    this._clock = new THREE.Clock();
    this.onTick = null; // sim 挂载
    const loop = () => {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      const dt = Math.min(0.05, this._clock.getDelta());
      const t = this._clock.elapsedTime;
      if (this.onTick) this.onTick(dt, t);
      if (this.fleet) this.fleet.tick(dt);
      // 喷头特写跟随
      if (this.camMode === "nozzle") {
        const tip = this.printer.getNozzleTip(this._tmpV);
        this.orbit.follow(tip);
      }
      this.orbit.update(dt);
      this.printer.update(dt, t);
      renderer.render(this.scene, this.camera);
    };
    this._tmpV = new THREE.Vector3();
    loop();
  }

  /* 环境贴图：中性影棚光盒（白/灰软箱）。
     机身金属 metalness 0.8~1.0，反射色几乎全部来自这里——
     早期蓝色系软箱会把整机映成蓝调，改用中性色板才有真实钢铝质感；
     各面板强度维持原值，整体曝光不变 */
  private _buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    const grad = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x121212 })
    );
    env.add(grad);
    const mk = (
      w: number,
      h: number,
      c: number,
      i: number,
      x: number,
      y: number,
      z: number,
      rx: number,
      ry: number
    ) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c }));
      m.material.color.multiplyScalar(i);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      env.add(m);
    };
    mk(40, 14, 0xf5efe4, 3.2, 0, 28, 0, Math.PI / 2, 0); // 顶部主软箱（近白微暖）
    mk(26, 10, 0xe9e7e2, 1.6, -30, 12, 0, 0, Math.PI / 2); // 左侧副软箱（中性）
    mk(26, 10, 0xdcdddd, 1.1, 30, 8, -6, 0, -Math.PI / 2); // 右侧（等亮度去蓝，仅留一丝冷灰层次）
    mk(30, 8, 0x8b8b8a, 0.7, 0, 6, -30, 0, 0); // 背板（中灰，去蓝）
    this.scene.environment = pmrem.fromScene(env, 0.05).texture;
    pmrem.dispose();
  }

  private _buildLights(): void {
    // 主光（近中性白，投影）——强度沿用原值，仅去蓝调
    const key = new THREE.DirectionalLight(0xf7f2e8, 2.6);
    key.position.set(420, 760, 380);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -500;
    sc.right = 500;
    sc.top = 500;
    sc.bottom = -500;
    sc.near = 100;
    sc.far = 2000;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    // 逆光轮廓（中性银灰，与原钢青等亮度——保留边缘分离，不再给金属染蓝）
    const rim = new THREE.DirectionalLight(0xbcbab6, 1.1);
    rim.position.set(-520, 420, -560);
    this.scene.add(rim);
    // 低角度补光（中性灰，与原灰紫等亮度）
    const fill = new THREE.DirectionalLight(0x949391, 0.5);
    fill.position.set(-300, 120, 500);
    this.scene.add(fill);
    // 环境半球（中性灰天光，等亮度去蓝）
    this.scene.add(new THREE.HemisphereLight(0x40403f, 0x0b0b0b, 1.35));
  }

  private _buildFloorAndBackdrop(): void {
    // 地面：深蓝灰哑光 + 工程网格纹理（图三蓝图质感）
    const tile = document.createElement("canvas");
    tile.width = 256;
    tile.height = 256;
    const c = tile.getContext("2d")!;
    c.fillStyle = "#2e3440";
    c.fillRect(0, 0, 256, 256);
    // 细网格 4×4
    c.strokeStyle = "rgba(196,210,232,0.075)";
    c.lineWidth = 1;
    for (let i = 0; i <= 256; i += 64) {
      c.beginPath();
      c.moveTo(i + 0.5, 0);
      c.lineTo(i + 0.5, 256);
      c.stroke();
      c.beginPath();
      c.moveTo(0, i + 0.5);
      c.lineTo(256, i + 0.5);
      c.stroke();
    }
    // 粗格边缘
    c.strokeStyle = "rgba(196,210,232,0.13)";
    c.lineWidth = 1.6;
    c.strokeRect(0.8, 0.8, 254.4, 254.4);
    const tex = new THREE.CanvasTexture(tile);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(22, 22);
    tex.anisotropy = 8;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(7000, 7000),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.88, metalness: 0.06 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -14;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 设备灰色垫台（哑光深灰圆盘，替代亮色光池）
    const padCv = document.createElement("canvas");
    padCv.width = 512;
    padCv.height = 512;
    const pc = padCv.getContext("2d")!;
    const pg = pc.createRadialGradient(256, 256, 40, 256, 256, 252);
    pg.addColorStop(0, "#3a404c");
    pg.addColorStop(0.75, "#353b46");
    pg.addColorStop(0.97, "rgba(49,55,66,0.25)");
    pg.addColorStop(1, "rgba(49,55,66,0)");
    pc.fillStyle = pg;
    pc.fillRect(0, 0, 512, 512);
    // 外缘细环标线
    pc.strokeStyle = "rgba(196,210,232,0.14)";
    pc.lineWidth = 2;
    pc.beginPath();
    pc.arc(256, 256, 238, 0, Math.PI * 2);
    pc.stroke();
    const padTex = new THREE.CanvasTexture(padCv);
    padTex.colorSpace = THREE.SRGBColorSpace;
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(560, 64),
      new THREE.MeshStandardMaterial({ map: padTex, transparent: true, roughness: 0.92, metalness: 0.04 })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -13.6;
    pad.receiveShadow = true;
    this.scene.add(pad);

    // 背景穹顶：深蓝灰渐变（顶点着色）
    const domeGeo = new THREE.SphereGeometry(3600, 32, 20);
    const pos = domeGeo.attributes.position!;
    const colors = new Float32Array(pos.count * 3);
    const cTop = new THREE.Color(0x3a4150),
      cMid = new THREE.Color(0x2a2f3a),
      cBot = new THREE.Color(0x1d212a);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 3600;
      const col = y > 0 ? cMid.clone().lerp(cTop, Math.pow(y, 0.7)) : cMid.clone().lerp(cBot, Math.min(1, -y * 2));
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    domeGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const dome = new THREE.Mesh(
      domeGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })
    );
    this.scene.add(dome);
  }

  setCameraPreset(mode: string, immediate?: boolean): void {
    this.camMode = mode;
    const P = this.printer;
    if (mode === "overview") {
      this.orbit.setView(P.CAM.pos.clone(), P.CAM.target.clone(), immediate);
    } else if (mode === "nozzle") {
      const tip = P.getNozzleTip(new THREE.Vector3());
      this.orbit.setView(tip.clone().add(new THREE.Vector3(120, 70, 150)), tip, immediate);
    } else if (mode === "top") {
      this.orbit.setView(new THREE.Vector3(8, P.CAM.topH, 180), new THREE.Vector3(0, P.getBedWorldY(), 0), immediate);
    }
  }

  /** 机型热切换：卸载旧机（释放 GPU 资源）→ 装配新机 → 重取景 */
  swapPrinter(id: string): FXPrinterBase {
    const old = this.printer;
    this.scene.remove(old.group);
    old.dispose();
    this.printer = FXPrinters.create(id);
    this.scene.add(this.printer.group);
    this.setCameraPreset(this.camMode, false);
    return this.printer;
  }

  resize(): void {
    const w = window.innerWidth,
      h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
