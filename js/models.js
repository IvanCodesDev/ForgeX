/* FORGE·X — 模型库：内置工程零件（参数化轮廓）+ 图片转3D模型（浮雕/剪影）
   轮廓逻辑纯 JS 可测；THREE 几何构建仅在浏览器调用 */
(function (root) {
  "use strict";

  const M = {};

  /* ── 轮廓生成工具 ─────────────────────────── */

  function circle(r, n, cx, cy) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: (cx || 0) + Math.cos(a) * r, y: (cy || 0) + Math.sin(a) * r });
    }
    return pts;
  }

  function roundRect(cx, cy, w, h, r, seg) {
    const pts = [];
    const hw = w / 2 - r, hh = h / 2 - r;
    const corner = (ox, oy, a0) => {
      for (let i = 0; i <= (seg || 5); i++) {
        const a = a0 + (i / (seg || 5)) * (Math.PI / 2);
        pts.push({ x: cx + ox + Math.cos(a) * r, y: cy + oy + Math.sin(a) * r });
      }
    };
    corner(hw, hh, 0); corner(-hw, hh, Math.PI / 2);
    corner(-hw, -hh, Math.PI); corner(hw, -hh, Math.PI * 1.5);
    return pts;
  }

  /* ── 内置模型 1：行星齿轮 ─────────────────── */

  function gearOutline() {
    const teeth = 26, rootR = 24.2, tipR = 27.6;
    const pts = [];
    const pitch = (Math.PI * 2) / teeth;
    for (let t = 0; t < teeth; t++) {
      const a0 = t * pitch;
      // 齿根段 → 齿侧 → 齿顶 → 齿侧
      const w1 = pitch * 0.26, w2 = pitch * 0.16; // 根宽/顶宽（半角）
      const seq = [
        [rootR, a0 - pitch * 0.5 + 0.02],
        [rootR, a0 - w1],
        [tipR, a0 - w2],
        [tipR, a0 + w2],
        [rootR, a0 + w1],
      ];
      for (const [r, a] of seq) pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return pts;
  }

  function makeGear() {
    const body = gearOutline();
    const bore = circle(5.2, 40).reverse();
    const lightHoles = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      lightHoles.push(circle(5.4, 30, Math.cos(a) * 14.5, Math.sin(a) * 14.5).reverse());
    }
    const zones = [
      {
        z0: 0, z1: 10,
        loops: [{ pts: body }, { pts: bore, hole: true }].concat(lightHoles.map((h) => ({ pts: h, hole: true }))),
      },
      {
        z0: 10, z1: 16,
        loops: [{ pts: circle(9.5, 48) }, { pts: bore, hole: true }],
      },
    ];
    return {
      id: "gear", kind: "outline", name: "行星齿轮",
      dims: "Ø55 × 16 mm", height: 16, zones,
      outlinesAt(z) {
        const zn = zones.find((q) => z >= q.z0 && z < q.z1) || zones[zones.length - 1];
        return { loops: zn.loops };
      },
      needSupport: false,
      footprintR: 30,
    };
  }

  /* ── 内置模型 2：涡轮叶轮（连续扭转，动态轮廓） ── */

  function makeImpeller() {
    const H = 30, blades = 7, twist = FXU.deg2rad(72) / H; // 每 mm 扭转
    const hubR = (z) => 13.5 - z * 0.16;
    const outR = (z) => 25.5 - z * 0.22;
    function bladeLoop(z, k) {
      const a = k * ((Math.PI * 2) / blades) + z * twist;
      const r0 = Math.max(2, hubR(z) - 0.35), r1 = outR(z);
      const hw = 1.35; // 半厚
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = -sa, ny = ca;
      // 梯形叶片截面（根部厚、梢部薄）
      return [
        { x: ca * r0 + nx * hw, y: sa * r0 + ny * hw },
        { x: ca * r1 + nx * (hw * 0.55), y: sa * r1 + ny * (hw * 0.55) },
        { x: ca * r1 - nx * (hw * 0.55), y: sa * r1 - ny * (hw * 0.55) },
        { x: ca * r0 - nx * hw, y: sa * r0 - ny * hw },
      ];
    }
    return {
      id: "impeller", kind: "outline", name: "涡轮叶轮",
      dims: "Ø51 × 30 mm", height: H, dynamicOutlines: true,
      outlinesAt(z) {
        z = FXU.clamp(z, 0, H - 0.01);
        const loops = [];
        if (z < 2.4) {
          loops.push({ pts: circle(outR(0) + 0.5, 72) });
          loops.push({ pts: circle(3.6, 32).reverse(), hole: true });
        } else {
          loops.push({ pts: circle(hubR(z), 48) });
          loops.push({ pts: circle(3.6, 32).reverse(), hole: true });
          for (let k = 0; k < blades; k++) loops.push({ pts: bladeLoop(z, k) });
        }
        return { loops };
      },
      needSupport: false,
      footprintR: 27,
    };
  }

  /* ── 内置模型 3：传感器支架（悬垂 → 需要支撑） ── */

  function makeBracket() {
    // 坐标：底板中心为原点。后墙位于 y ∈ [-15,-10]，顶部法兰前伸至 y=+12（悬空）
    const basePlate = { pts: roundRect(0, 0, 46, 30, 3) };
    const baseHoles = [
      { pts: circle(2.6, 24, -17, 5).reverse(), hole: true },
      { pts: circle(2.6, 24, 17, 5).reverse(), hole: true },
    ];
    const wall = { pts: roundRect(0, -12.5, 46, 5, 1.5) };
    const flange = { pts: roundRect(0, -1.5, 46, 27, 2.5) };
    const flangeHoles = [
      { pts: circle(2.2, 24, -14, 6).reverse(), hole: true },
      { pts: circle(2.2, 24, 14, 6).reverse(), hole: true },
    ];
    const zones = [
      { z0: 0, z1: 4, loops: [basePlate].concat(baseHoles) },
      { z0: 4, z1: 26, loops: [wall] },
      { z0: 26, z1: 30, loops: [flange].concat(flangeHoles) },
    ];
    const supportRegion = [{ pts: roundRect(0, 1.2, 42, 21, 2) }]; // 法兰悬空区域
    return {
      id: "bracket", kind: "outline", name: "传感器支架",
      dims: "46 × 30 × 30 mm", height: 30, zones,
      outlinesAt(z) {
        const zn = zones.find((q) => z >= q.z0 && z < q.z1) || zones[zones.length - 1];
        return { loops: zn.loops };
      },
      supportRegionAt(z) {
        return z >= 4 && z < 26 ? supportRegion : null;
      },
      needSupport: true,
      footprintR: 28,
    };
  }

  /* ── 图片 → 3D 模型 ───────────────────────── */

  /**
   * lum: Float32Array 亮度 0..1（nx*ny，行主序，y 向上已翻转）
   * opts: { mode: 'relief'|'silhouette', widthMm, maxH, invert, threshold }
   */
  M.gridFromLuminance = function (lum, nx, ny, opts) {
    const w = opts.widthMm;
    const d = (w * ny) / nx;
    const H = new Float32Array(nx * ny);
    const base = 1.6;
    if (opts.mode === "silhouette") {
      const th = opts.threshold == null ? 0.5 : opts.threshold;
      for (let i = 0; i < lum.length; i++) {
        let on = lum[i] < th;            // 默认深色为主体
        if (opts.invert) on = !on;
        H[i] = on ? opts.maxH : 0;
      }
      // 轻度模糊让边缘可插值（等值线更平滑）
      M._blurGrid(H, nx, ny, 1);
    } else {
      for (let i = 0; i < lum.length; i++) {
        let v = opts.invert ? lum[i] : 1 - lum[i]; // 默认深色更高（浮雕）
        H[i] = base + v * (opts.maxH - base);
      }
      M._blurGrid(H, nx, ny, 1);
    }
    // 边界一圈强制归零：保证任意切片高度上等值线闭合（Marching Squares 不吐出网格外边界）
    for (let i = 0; i < nx; i++) { H[i] = 0; H[(ny - 1) * nx + i] = 0; }
    for (let j = 0; j < ny; j++) { H[j * nx] = 0; H[j * nx + nx - 1] = 0; }
    let maxH = 0;
    for (let i = 0; i < H.length; i++) if (H[i] > maxH) maxH = H[i];
    return { nx, ny, w, d, H, maxH };
  };

  M._blurGrid = function (H, nx, ny, r) {
    const tmp = new Float32Array(H.length);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const x = i + di, y = j + dj;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          s += H[y * nx + x]; c++;
        }
        tmp[j * nx + i] = s / c;
      }
    }
    H.set(tmp);
  };

  /** 由浏览器 Image 对象构建（downscale + 亮度提取，y 翻转为模型坐标） */
  M.fromImage = function (img, opts) {
    const maxRes = 108;
    const ar = img.naturalHeight / img.naturalWidth;
    let nx, ny;
    if (ar >= 1) { ny = maxRes; nx = Math.max(16, Math.round(maxRes / ar)); }
    else { nx = maxRes; ny = Math.max(16, Math.round(maxRes * ar)); }
    const cv = document.createElement("canvas");
    cv.width = nx; cv.height = ny;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, nx, ny);
    const px = ctx.getImageData(0, 0, nx, ny).data;
    const lum = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const si = (j * nx + i) * 4;
        const a = px[si + 3] / 255;
        const l = (0.2126 * px[si] + 0.7152 * px[si + 1] + 0.0722 * px[si + 2]) / 255;
        // 透明像素视为背景（亮）
        const v = l * a + (1 - a);
        lum[(ny - 1 - j) * nx + i] = v;   // 翻转 y
      }
    }
    return M.buildImageModel(lum, nx, ny, opts);
  };

  M.buildImageModel = function (lum, nx, ny, opts) {
    const grid = M.gridFromLuminance(lum, nx, ny, opts);
    const model = {
      id: "image", kind: "grid", name: opts.name || "自定义模型",
      dims: `${grid.w.toFixed(0)} × ${grid.d.toFixed(0)} × ${grid.maxH.toFixed(1)} mm`,
      height: grid.maxH, grid,
      needSupport: false,
      footprintR: Math.hypot(grid.w, grid.d) / 2,
      _lum: lum, _nx: nx, _ny: ny, _opts: opts,   // 保留源数据便于改参重建
    };
    return model;
  };

  M.rebuildImageModel = function (model, opts) {
    return M.buildImageModel(model._lum, model._nx, model._ny, Object.assign({}, model._opts, opts));
  };

  /* ── THREE 几何构建（仅浏览器） ────────────── */

  M.buildGeometry = function (model) {
    if (typeof THREE === "undefined") return null;
    if (model.kind === "grid") return M._gridGeometry(model.grid);
    return M._outlineGeometry(model);
  };

  /** 射线法点在多边形内判定 */
  M.pointInPoly = function (pt, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };

  /** 轮廓模型：分区挤出并合并；动态轮廓按步长采样 */
  M._outlineGeometry = function (model) {
    const geoms = [];
    const zones = [];
    if (model.dynamicOutlines) {
      const dz = Math.max(0.8, model.height / 30);
      for (let z = 0; z < model.height - 1e-6; z += dz) {
        zones.push({ z0: z, z1: Math.min(z + dz, model.height), loops: model.outlinesAt(z + dz * 0.5).loops });
      }
    } else {
      for (const zn of model.zones) zones.push(zn);
    }
    for (const zn of zones) {
      const outers = zn.loops.filter((l) => !l.hole);
      const holes = zn.loops.filter((l) => l.hole);
      for (const o of outers) {
        const shape = new THREE.Shape(o.pts.map((p) => new THREE.Vector2(p.x, p.y)));
        for (const h of holes) {
          // 孔洞只归属于包含它的外轮廓（叶轮：中心孔属于轮毂而非叶片）
          if (!M.pointInPoly(h.pts[0], o.pts)) continue;
          shape.holes.push(new THREE.Path(h.pts.map((p) => new THREE.Vector2(p.x, p.y))));
        }
        const g = new THREE.ExtrudeGeometry(shape, { depth: zn.z1 - zn.z0, bevelEnabled: false, curveSegments: 8 });
        g.translate(0, 0, zn.z0);
        geoms.push(g);
      }
    }
    const merged = M._mergeGeoms(geoms);
    merged.rotateX(-Math.PI / 2);   // (x,y,z) → (x,z,-y)：模型 z 变为世界 y（高度）
    merged.computeVertexNormals();
    return merged;
  };

  /** 高度场模型：顶面 + 四侧裙墙 + 底面 */
  M._gridGeometry = function (grid) {
    const { nx, ny, w, d, H } = grid;
    const pos = [], idx = [];
    const cw = w / (nx - 1), ch = d / (ny - 1);
    const ox = -w / 2, oy = -d / 2;
    const at = (i, j) => H[j * nx + i];
    // 顶面顶点（世界系：x=mx, y=高度, z=-my）
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        pos.push(ox + i * cw, Math.max(0.02, at(i, j)), -(oy + j * ch));
    const vid = (i, j) => j * nx + i;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), e = vid(i, j + 1);
        idx.push(a, b, c, a, c, e);
      }
    }
    // 侧墙 + 底面
    let base = pos.length / 3;
    const wall = (i0, j0, i1, j1) => {
      const x0 = ox + i0 * cw, z0 = -(oy + j0 * ch), h0 = Math.max(0.02, at(i0, j0));
      const x1 = ox + i1 * cw, z1 = -(oy + j1 * ch), h1 = Math.max(0.02, at(i1, j1));
      pos.push(x0, 0, z0, x1, 0, z1, x1, h1, z1, x0, h0, z0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    };
    for (let i = 0; i < nx - 1; i++) { wall(i, 0, i + 1, 0); wall(i + 1, ny - 1, i, ny - 1); }
    for (let j = 0; j < ny - 1; j++) { wall(0, j + 1, 0, j); wall(nx - 1, j, nx - 1, j + 1); }
    // 底面
    pos.push(ox, 0, -oy, ox + w, 0, -oy, ox + w, 0, -(oy + d), ox, 0, -(oy + d));
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  M._mergeGeoms = function (geoms) {
    // 手工合并（非索引化），避免依赖 BufferGeometryUtils
    let total = 0;
    const list = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
    for (const g of list) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3);
    let off = 0;
    for (const g of list) {
      pos.set(g.attributes.position.array, off * 3);
      off += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return out;
  };

  M.createBuiltins = function () {
    return [makeGear(), makeImpeller(), makeBracket()];
  };

  root.FXModels = M;
})(typeof window !== "undefined" ? window : globalThis);
