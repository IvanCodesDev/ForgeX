/* FORGE·X — 机群视图：把分析结论映射到 3D 空间里的具体机台。

   为什么需要它：
   重构前有一个「在 3D 视口中定位 FX-256-03」的按钮，但它忽略参数、
   闪的是视口里唯一那台打印机——因为场景里本来就只有一台机器。
   P0 时把这个假动作降级成了诚实的提示（「机群视图尚未实现」），
   这里把它真正做出来。

   设计取舍：
   - **不渲染 N 台完整打印机**。8 台细节机型 = 8× 建模开销与 draw call，
     而机群视图要看的是「哪台有问题」，不是「喷头长什么样」。
     所以机群用低模机柜表示，细节模型只保留给当前选中的那一台。
   - **颜色编码承载统计信息**：色相由失败率决定，
     而**不透明度由置信区间宽度决定**——区间越宽（证据越弱）越透明。
     这样「1 单 1 失败 = 100% 故障率」的机台会显示为一个几乎透明的幽灵，
     一眼就能看出它不该被当真，而不是显示成最刺眼的红色。
   - 纯几何/配色逻辑抽成可测函数（layout / statusOf），
     THREE 相关的部分只做装配。 */
(function (root) {
  "use strict";

  var F = {};

  /* ══ 可测的纯逻辑 ══════════════════════════ */

  /** 机柜尺寸与间距（世界单位，与打印机模型同一量级） */
  F.CELL = 340;
  F.BOX = { w: 210, h: 260, d: 210 };

  /**
   * 机群网格布局：尽量接近正方形，行优先，整体居中于原点。
   * @returns {Array<{x, z, row, col}>}
   */
  F.layout = function (n) {
    if (!(n > 0)) return [];
    var cols = Math.ceil(Math.sqrt(n));
    var rows = Math.ceil(n / cols);
    var out = [];
    for (var i = 0; i < n; i++) {
      var r = Math.floor(i / cols);
      var c = i % cols;
      // 最后一行不满时居中摆放，避免整体重心偏移
      var inRow = Math.min(cols, n - r * cols);
      var offset = ((cols - inRow) * F.CELL) / 2;
      out.push({
        x: (c - (cols - 1) / 2) * F.CELL + offset,
        z: (r - (rows - 1) / 2) * F.CELL,
        row: r, col: c,
      });
    }
    return out;
  };

  /** 状态色阶（失败率 → 色相）。绿 → 琥珀 → 红。 */
  F.PALETTE = [
    { max: 0.05, hex: 0x2ca878, label: "良好" },
    { max: 0.12, hex: 0x8cb84a, label: "正常" },
    { max: 0.2, hex: 0xe59a3a, label: "偏高" },
    { max: 1.01, hex: 0xe0484d, label: "偏高严重" },
  ];

  /**
   * 由统计结果推出机台的视觉状态。
   *
   * 关键点：**不透明度由证据强度决定**。
   * 只看失败率会让「1 单 1 失败」显示成最刺眼的红色，
   * 而那恰恰是最不该相信的数字。这里让置信区间越宽的机台越透明——
   * 视觉上就是「这台看不清」，与统计上的「证据不足」对应。
   *
   * @param g {{rate, ci:{lo,hi}, n, significant}}
   * @returns {{hex, opacity, label, trustworthy}}
   */
  F.statusOf = function (g) {
    if (!g || !(g.n > 0)) {
      return { hex: 0x8d97a8, opacity: 0.22, label: "无数据", trustworthy: false };
    }
    var hex = F.PALETTE[F.PALETTE.length - 1].hex;
    var label = F.PALETTE[F.PALETTE.length - 1].label;
    for (var i = 0; i < F.PALETTE.length; i++) {
      if (g.rate < F.PALETTE[i].max) { hex = F.PALETTE[i].hex; label = F.PALETTE[i].label; break; }
    }
    // 区间宽度 0 → 完全不透明；宽度 ≥0.6（几乎没信息）→ 接近透明
    var width = g.ci ? Math.max(0, Math.min(1, g.ci.hi - g.ci.lo)) : 1;
    var opacity = Math.max(0.2, 1 - width * 1.35);
    return {
      hex: hex,
      opacity: opacity,
      label: label + (g.significant ? "（显著）" : width > 0.35 ? "（证据不足）" : ""),
      trustworthy: width <= 0.35,
    };
  };

  /**
   * 从分析报告的图表数据构造机群条目。
   * chart.items 已带 ciLo/ciHi/weak，正是这里需要的。
   */
  F.fromChartItems = function (items, highlightId) {
    return (items || []).map(function (it) {
      var g = {
        id: it.label,
        rate: it.value,
        n: it.weak ? 1 : 99,             // weak 已表示样本不足，具体 n 不影响配色
        ci: { lo: it.ciLo != null ? it.ciLo : 0, hi: it.ciHi != null ? it.ciHi : 1 },
        significant: false,
      };
      var st = F.statusOf(g);
      return {
        id: it.label, rate: it.value, hint: it.hint || "",
        status: st, highlighted: it.label === highlightId,
      };
    });
  };

  /* ══ THREE 装配 ════════════════════════════ */

  /**
   * 机群视图。挂到 FXScene 上，与详细打印机模型互斥显示。
   * @param scene THREE.Scene
   */
  F.View = function (scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);
    this.entries = [];
    this._t = 0;
  };

  F.View.prototype.build = function (machines) {
    this.clear();
    var pos = F.layout(machines.length);
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      var cell = this._buildCabinet(m, pos[i]);
      this.group.add(cell.group);
      this.entries.push(cell);
    }
    return this;
  };

  F.View.prototype._buildCabinet = function (m, p) {
    var g = new THREE.Group();
    g.position.set(p.x, 0, p.z);

    // 机柜本体：半透明，透明度承载证据强度
    var mat = new THREE.MeshStandardMaterial({
      color: m.status.hex,
      transparent: true,
      opacity: m.status.opacity * 0.55,
      roughness: 0.45,
      metalness: 0.1,
      depthWrite: false,
    });
    var box = new THREE.Mesh(new THREE.BoxGeometry(F.BOX.w, F.BOX.h, F.BOX.d), mat);
    box.position.y = F.BOX.h / 2;
    g.add(box);

    // 线框边：即使很透明也能看清轮廓与位置
    var edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(F.BOX.w, F.BOX.h, F.BOX.d)),
      new THREE.LineBasicMaterial({
        color: m.status.hex,
        transparent: true,
        opacity: Math.min(1, m.status.opacity + 0.25),
      })
    );
    edges.position.y = F.BOX.h / 2;
    g.add(edges);

    // 状态灯：被高亮的机台会呼吸闪烁
    var ledMat = new THREE.MeshBasicMaterial({ color: m.status.hex });
    var led = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 12), ledMat);
    led.position.set(0, F.BOX.h + 26, 0);
    g.add(led);

    // 标签：机台编号 + 失败率，画在贴图上（不引入字体依赖）
    var label = this._makeLabel(m);
    label.position.set(0, F.BOX.h + 74, 0);
    g.add(label);

    return { group: g, box: box, led: led, ledMat: ledMat, machine: m };
  };

  /** 用 canvas 贴图做文字标签：不引入字体加载，也不受 file:// 限制 */
  F.View.prototype._makeLabel = function (m) {
    var cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 160;
    var c = cv.getContext("2d");
    c.clearRect(0, 0, 512, 160);
    c.fillStyle = "rgba(20,24,31,0.82)";
    c.roundRect ? (c.beginPath(), c.roundRect(6, 6, 500, 148, 18), c.fill()) : c.fillRect(6, 6, 500, 148);

    c.textAlign = "center";
    c.fillStyle = "#eef1f6";
    c.font = "700 54px Consolas, monospace";
    c.fillText(m.id, 256, 66);
    c.fillStyle = "#" + m.status.hex.toString(16).padStart(6, "0");
    c.font = "600 40px 'Segoe UI', sans-serif";
    c.fillText((m.rate * 100).toFixed(1) + "%  " + m.status.label, 256, 122);

    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(230, 72, 1);
    return spr;
  };

  /** 高亮某台机器：呼吸灯 + 抬升，便于在一堆机柜里一眼找到 */
  F.View.prototype.highlight = function (id) {
    this.highlightId = id;
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      e.highlighted = e.machine.id === id;
      e.group.position.y = e.highlighted ? 26 : 0;
    }
    return this;
  };

  /** 每帧更新（呼吸动画）。由 FXScene 的 tick 调用。 */
  F.View.prototype.tick = function (dt) {
    if (!this.group.visible) return;
    this._t += dt;
    var pulse = 0.55 + 0.45 * Math.sin(this._t * 3.2);
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      e.ledMat.opacity = e.highlighted ? pulse : 1;
      e.ledMat.transparent = e.highlighted;
      e.led.scale.setScalar(e.highlighted ? 1 + pulse * 0.35 : 1);
    }
  };

  F.View.prototype.show = function (on) {
    this.group.visible = !!on;
    return this;
  };

  /** 相机应当看向哪里：整个机群，或某一台 */
  F.View.prototype.focusTarget = function (id) {
    var e = id && this.entries.filter(function (x) { return x.machine.id === id; })[0];
    if (e) {
      return {
        pos: new THREE.Vector3(e.group.position.x + 260, 300, e.group.position.z + 420),
        target: new THREE.Vector3(e.group.position.x, F.BOX.h / 2, e.group.position.z),
      };
    }
    var span = Math.max(1, Math.ceil(Math.sqrt(this.entries.length))) * F.CELL;
    return {
      pos: new THREE.Vector3(span * 0.55, span * 0.75, span * 0.95),
      target: new THREE.Vector3(0, F.BOX.h / 2, 0),
    };
  };

  F.View.prototype.clear = function () {
    for (var i = 0; i < this.entries.length; i++) {
      var e = this.entries[i];
      this.group.remove(e.group);
      e.group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
    }
    this.entries = [];
    return this;
  };

  root.FXFleetView = F;
})(typeof window !== "undefined" ? window : globalThis);
