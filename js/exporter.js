/* FORGE·X — 成品导出引擎：STL（二进制）/ OBJ / G-code（Marlin 风格）
   纯逻辑可在 node 中测试（tests/exporter.test.js）；浏览器仅负责 Blob 下载。
   数据源与仿真同源：STL/OBJ 来自模型三角网格，G-code 来自真实切片路径。 */
(function (root) {
  "use strict";

  const E = {};
  const FILAMENT_AREA = Math.PI * 0.875 * 0.875;   // ⌀1.75 耗材截面 mm²

  /* ── 三角网格提取 ─────────────────────────────
     输入 BufferGeometry 形状的对象（只读 attributes.position.array / index.array，
     不依赖 THREE API，node 中可喂等价结构测试）。
     世界系 Y-up → 3D 打印惯例 Z-up：(x, y, z) → (x, -z, y)。 */

  E.trianglesFromGeometry = function (geo, scale) {
    const sc = scale || 1;
    const pos = geo.attributes.position.array;
    const idx = geo.index ? geo.index.array : null;
    const n = idx ? idx.length : pos.length / 3;
    const tris = [];
    const vert = (vi) => ({
      x: pos[vi * 3] * sc,
      y: -pos[vi * 3 + 2] * sc,
      z: pos[vi * 3 + 1] * sc,
    });
    for (let t = 0; t < n; t += 3) {
      const a = vert(idx ? idx[t] : t);
      const b = vert(idx ? idx[t + 1] : t + 1);
      const c = vert(idx ? idx[t + 2] : t + 2);
      tris.push([a, b, c]);
    }
    return tris;
  };

  E._normal = function (a, b, c) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; } else { nx = ny = 0; nz = 1; }
    return [nx, ny, nz];
  };

  /* ── STL（二进制，小端）：80B 头 + uint32 三角数 + 每三角 50B ── */

  E.stlFromTriangles = function (tris, name) {
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    const header = "FORGE-X binary STL " + String(name || "").replace(/[^\x20-\x7e]/g, "?");
    for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
    dv.setUint32(80, tris.length, true);
    let off = 84;
    for (const [a, b, c] of tris) {
      const nrm = E._normal(a, b, c);
      for (const v of nrm) { dv.setFloat32(off, v, true); off += 4; }
      for (const p of [a, b, c]) {
        dv.setFloat32(off, p.x, true); off += 4;
        dv.setFloat32(off, p.y, true); off += 4;
        dv.setFloat32(off, p.z, true); off += 4;
      }
      dv.setUint16(off, 0, true); off += 2;
    }
    return buf;
  };

  /* ── OBJ（ASCII，单位 mm，Z-up） ── */

  E.objFromTriangles = function (tris, name) {
    const out = [
      "# FORGE-X Insight — exported model",
      "# name: " + (name || "model"),
      "# units: millimeters, Z-up",
      "o " + String(name || "forgex_model").replace(/\s+/g, "_"),
    ];
    const f = (v) => (Math.round(v * 1000) / 1000).toString();
    for (const [a, b, c] of tris)
      for (const p of [a, b, c]) out.push(`v ${f(p.x)} ${f(p.y)} ${f(p.z)}`);
    for (let i = 0; i < tris.length; i++) {
      const b = i * 3;
      out.push(`f ${b + 1} ${b + 2} ${b + 3}`);
    }
    return out.join("\n") + "\n";
  };

  /* ── G-code（Marlin 风格，相对挤出 M83）─────────
     直接消费 FXSlicer.slice 的真实路径与速度：与视口中打印动画走的是同一份数据。
     床心原点 → 床角原点（+128,+128），落在 0..256mm。 */

  E.gcode = function (slice, st, meta) {
    meta = meta || {};
    const lines = [];
    const P = (v, d) => v.toFixed(d == null ? 3 : d);
    const extArea = st.extrusionWidth * st.layerHeight;
    const eScale = extArea / FILAMENT_AREA;             // 路径 mm → 耗材 mm（相对挤出）
    const fanPWM = Math.round(FXU.clamp(st.fanSpeed, 0, 100) * 2.55);
    const TYPE_TAG = { perimeter: "WALL-OUTER", solid: "FILL", infill: "FILL", support: "SUPPORT", skirt: "SKIRT" };
    const totalG = slice.stats.volumeCm3 * (meta.densityG || 1.24);

    lines.push(
      "; FORGE-X Insight — generated G-code (simulation twin)",
      `; model: ${meta.model || "unknown"}  printer: ${meta.printer || "FORGE-X"}  material: ${st.material}`,
      `; layer_height: ${st.layerHeight}mm  extrusion_width: ${st.extrusionWidth}mm  perimeters: ${st.perimeters}  infill: ${Math.round(st.infillDensity * 100)}%`,
      `; layers: ${slice.totalLayers}  est_time: ${Math.round(slice.stats.timeSec + 95)}s  filament: ${slice.stats.filamentM.toFixed(2)}m (${totalG.toFixed(1)}g)`,
      ";FLAVOR:Marlin",
      `;LAYER_COUNT:${slice.totalLayers}`,
      "G21 ; units = mm",
      "G90 ; absolute positioning",
      "M83 ; relative extrusion",
      `M140 S${st.bedTemp}`,
      `M104 S${st.nozzleTemp}`,
      `M190 S${st.bedTemp}`,
      `M109 S${st.nozzleTemp}`,
      "G28 ; home all axes",
      st.autoLevel ? "G29 ; auto bed leveling" : "; G29 skipped (auto-level off)",
      "G92 E0",
      "M107 ; fan off for first layer"
    );

    const X = (x) => P(x + 128), Y = (y) => P(y + 128);
    const ret = st.retraction || 0;
    let cur = null;                                     // 当前喷头位置（床心系）
    for (let li = 0; li < slice.totalLayers; li++) {
      const layer = slice.layers[li];
      lines.push(`;LAYER:${li}`, `G0 Z${P(layer.z, 2)} F720`);
      if (li === 1 && fanPWM > 0) lines.push(`M106 S${fanPWM}`);
      let lastType = null;
      for (const p of layer.paths) {
        if (p.pts.length < 2 || p.len < 0.4) continue;
        if (p.type !== lastType) { lines.push(`;TYPE:${TYPE_TAG[p.type] || "FILL"}`); lastType = p.type; }
        const s0 = p.pts[0];
        const jump = cur ? Math.hypot(s0.x - cur.x, s0.y - cur.y) : Infinity;
        if (jump > 0.05) {
          const withRet = ret > 0.05 && jump > 2;
          if (withRet) lines.push(`G1 E-${P(ret, 2)} F2400 ; retract`);
          lines.push(`G0 F${Math.round(st.travelSpeed * 60)} X${X(s0.x)} Y${Y(s0.y)}`);
          if (withRet) lines.push(`G1 E${P(ret, 2)} F2400 ; unretract`);
        }
        const F = Math.round(p.speed * 60);
        for (let i = 1; i < p.pts.length; i++) {
          const a = p.pts[i - 1], b = p.pts[i];
          const seg = Math.hypot(b.x - a.x, b.y - a.y);
          if (seg < 1e-4) continue;
          lines.push(`G1 F${F} X${X(b.x)} Y${Y(b.y)} E${P(seg * eScale, 5)}`);
        }
        cur = p.pts[p.pts.length - 1];
      }
    }

    lines.push(
      "; ── end of print ──",
      "M107 ; fan off",
      "M104 S0 ; nozzle off",
      "M140 S0 ; bed off",
      "G91", "G1 Z10 F720 ; lift", "G90",
      "G28 X0 Y0 ; present print",
      "M84 ; disable steppers",
      ""
    );
    return lines.join("\n");
  };

  /* ── 浏览器下载壳 ── */

  E.download = function (filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  root.FXExport = E;
})(typeof window !== "undefined" ? window : globalThis);
