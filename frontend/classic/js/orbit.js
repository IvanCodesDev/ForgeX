/* FORGE·X — 轻量轨道控制器（自研，避免 ES Module 依赖，file:// 直开可用）
   左键旋转 · 右键/中键平移 · 滚轮缩放 · 带阻尼与目标点平滑过渡 */
(function (root) {
  "use strict";

  class FXOrbit {
    constructor(camera, dom) {
      this.camera = camera;
      this.dom = dom;
      this.target = new THREE.Vector3(0, 200, 0);

      // 球坐标
      this.radius = 900;
      this.theta = Math.PI * 0.28;   // 方位角
      this.phi = Math.PI * 0.42;     // 极角（0=顶部）

      this.minRadius = 220;
      this.maxRadius = 2400;
      this.minPhi = 0.08;
      this.maxPhi = Math.PI / 2 - 0.02;

      this.damping = 8;              // 阻尼系数
      this.enabled = true;

      // 目标值（阻尼收敛）
      this._tRadius = this.radius;
      this._tTheta = this.theta;
      this._tPhi = this.phi;
      this._tTarget = this.target.clone();

      this._drag = null;
      this._bind();
    }

    /** 立即/平滑设定视角 */
    setView(pos, target, immediate) {
      const off = new THREE.Vector3().subVectors(pos, target);
      const r = off.length();
      const phi = Math.acos(FXU.clamp(off.y / r, -1, 1));
      const theta = Math.atan2(off.x, off.z);
      this._tRadius = FXU.clamp(r, this.minRadius, this.maxRadius);
      this._tTheta = theta;
      this._tPhi = FXU.clamp(phi, this.minPhi, this.maxPhi);
      this._tTarget.copy(target);
      if (immediate) {
        this.radius = this._tRadius; this.theta = this._tTheta; this.phi = this._tPhi;
        this.target.copy(target);
      }
      // 归一化 theta 差值避免绕远路
      const d = this._tTheta - this.theta;
      if (d > Math.PI) this.theta += Math.PI * 2;
      else if (d < -Math.PI) this.theta -= Math.PI * 2;
    }

    /** 仅平滑移动目标点（跟踪喷头用） */
    follow(target) { this._tTarget.copy(target); }

    _bind() {
      const dom = this.dom;
      dom.addEventListener("contextmenu", (e) => e.preventDefault());

      const onMove = (e) => {
        if (!this._drag || !this.enabled) return;
        const dx = e.clientX - this._drag.x;
        const dy = e.clientY - this._drag.y;
        this._drag.x = e.clientX; this._drag.y = e.clientY;

        if (this._drag.btn === 0) {          // 旋转
          this._tTheta -= dx * 0.0055;
          this._tPhi = FXU.clamp(this._tPhi - dy * 0.0045, this.minPhi, this.maxPhi);
        } else {                              // 平移
          const scale = this._tRadius * 0.0011;
          const fwd = new THREE.Vector3().subVectors(this.target, this.camera.position).normalize();
          const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
          const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
          this._tTarget.addScaledVector(right, -dx * scale);
          this._tTarget.addScaledVector(up, dy * scale);
          this._tTarget.y = FXU.clamp(this._tTarget.y, 0, 620);
        }
      };
      const end = () => { this._drag = null; };

      if (window.PointerEvent) {
        dom.addEventListener("pointerdown", (e) => {
          if (!this.enabled) return;
          // 部分老实现（早期 Edge/国产内核）setPointerCapture 可能抛错，降级为无捕获拖拽
          if (dom.setPointerCapture) { try { dom.setPointerCapture(e.pointerId); } catch (err) {} }
          this._drag = { x: e.clientX, y: e.clientY, btn: e.button };
        });
        dom.addEventListener("pointermove", onMove);
        dom.addEventListener("pointerup", end);
        dom.addEventListener("pointercancel", end);
      } else {
        // 无 PointerEvent 的老浏览器（如 Safari ≤12）：鼠标事件回退，
        // move/up 绑在 window 上保证拖出画布后仍能跟踪与释放
        dom.addEventListener("mousedown", (e) => {
          if (!this.enabled) return;
          e.preventDefault();
          this._drag = { x: e.clientX, y: e.clientY, btn: e.button };
        });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", end);
      }

      const wheelEv = "onwheel" in dom ? "wheel" : "mousewheel";
      dom.addEventListener(wheelEv, (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const dy = e.deltaY != null ? e.deltaY : -(e.wheelDelta || 0);
        const f = Math.exp(dy * 0.001);
        this._tRadius = FXU.clamp(this._tRadius * f, this.minRadius, this.maxRadius);
      }, { passive: false });
    }

    update(dt) {
      const k = 1 - Math.exp(-this.damping * dt);
      this.radius += (this._tRadius - this.radius) * k;
      this.theta += (this._tTheta - this.theta) * k;
      this.phi += (this._tPhi - this.phi) * k;
      this.target.lerp(this._tTarget, k);

      const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
      const st = Math.sin(this.theta), ct = Math.cos(this.theta);
      this.camera.position.set(
        this.target.x + this.radius * sp * st,
        this.target.y + this.radius * cp,
        this.target.z + this.radius * sp * ct
      );
      this.camera.lookAt(this.target);
    }
  }

  root.FXOrbit = FXOrbit;
})(typeof window !== "undefined" ? window : globalThis);
