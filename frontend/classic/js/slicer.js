/* FORGE·X — 切片引擎（纯几何逻辑，不依赖 THREE，可在 node 中冒烟测试）
   输入：模型轮廓/高度场 + 工艺参数 → 输出：逐层挤出路径（周界/填充/支撑/裙边）与统计 */
(function (root) {
  "use strict";

  const S = {};
  const EPS = 1e-7;

  /* ── 基础几何 ─────────────────────────────── */

  /** 顶点法线小距偏置（外轮廓 CCW / 孔洞 CW 时，dist>0 向材料内部收缩） */
  S.offsetLoop = function (pts, dist) {
    const n = pts.length;
    if (n < 3) return null;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      let ax = p1.x - p0.x, ay = p1.y - p0.y;
      let bx = p2.x - p1.x, by = p2.y - p1.y;
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      ax /= la; ay /= la; bx /= lb; by /= lb;
      // 左法线（CCW 外轮廓的内侧）
      const n1x = -ay, n1y = ax, n2x = -by, n2y = bx;
      let mx = n1x + n2x, my = n1y + n2y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) { mx = n1x; my = n1y; } else { mx /= ml; my /= ml; }
      // 斜接长度限制
      const cosHalf = Math.max(0.35, mx * n1x + my * n1y);
      const d = dist / cosHalf;
      out[i] = { x: p1.x + mx * d, y: p1.y + my * d };
    }
    // 面积塌缩检查（收缩过度）
    if (dist > 0 && Math.abs(FXU.polyArea(out)) < Math.abs(FXU.polyArea(pts)) * 0.05) return null;
    return out;
  };

  /** 确保外轮廓 CCW、孔洞 CW */
  S.normalizeLoop = function (loop) {
    const a = FXU.polyArea(loop.pts);
    const wantCCW = !loop.hole;
    if ((a > 0) !== wantCCW) loop.pts = loop.pts.slice().reverse();
    return loop;
  };

  /** 平行线族与多边形组求交（奇偶规则）→ 挤出线段，蛇形串联 */
  S.hatchLoops = function (loops, angleDeg, spacing, connectDist) {
    if (!loops.length || spacing <= 0) return [];
    const ang = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(ang), dy = Math.sin(ang);       // 线方向
    const nx = -dy, ny = dx;                             // 法向（扫描方向）

    // 所有点在（法向 s，切向 t）坐标下的范围
    let sMin = Infinity, sMax = -Infinity;
    for (const lp of loops) for (const p of lp.pts) {
      const s = p.x * nx + p.y * ny;
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
    }
    if (!isFinite(sMin)) return [];

    const lines = [];
    let idx = 0;
    for (let s = sMin + spacing * 0.5; s < sMax; s += spacing, idx++) {
      // 收集该扫描线与全部边的交点（参数 t = 沿线方向坐标）
      const ts = [];
      for (const lp of loops) {
        const pts = lp.pts, n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          const sa = a.x * nx + a.y * ny - s;
          const sb = b.x * nx + b.y * ny - s;
          if ((sa > 0) === (sb > 0)) continue;           // 不跨线
          const f = sa / (sa - sb);
          const ix = a.x + (b.x - a.x) * f;
          const iy = a.y + (b.y - a.y) * f;
          ts.push(ix * dx + iy * dy);
        }
      }
      if (ts.length < 2) continue;
      ts.sort((p, q) => p - q);
      const spans = [];
      for (let i = 0; i + 1 < ts.length; i += 2) {
        if (ts[i + 1] - ts[i] < 0.6) continue;           // 过短跳过
        const t0 = ts[i] + 0.15, t1 = ts[i + 1] - 0.15;  // 微退让避免蹭周界
        spans.push({
          a: { x: nx * s + dx * t0, y: ny * s + dy * t0 },
          b: { x: nx * s + dx * t1, y: ny * s + dy * t1 },
          line: idx,
        });
      }
      if (idx % 2 === 1) spans.reverse();                // 蛇形
      for (const sp of spans) { if (idx % 2 === 1) { const t = sp.a; sp.a = sp.b; sp.b = t; } lines.push(sp); }
    }

    // 串联相邻线段为折线（减少空驶、贴近真实切片器）
    // 超过 72 点即无缝分段：保证管束几何 tubularSegments 不超限、揭示粒度稳定
    const polylines = [];
    let cur = null;
    const maxLink = connectDist == null ? spacing * 2.6 : connectDist;
    for (const sp of lines) {
      if (cur) {
        const last = cur[cur.length - 1];
        const gap = Math.hypot(sp.a.x - last.x, sp.a.y - last.y);
        if (gap <= maxLink) {
          cur.push(sp.a, sp.b);
          if (cur.length >= 72) { polylines.push(cur); cur = [{ x: sp.b.x, y: sp.b.y }]; }
          continue;
        }
        if (cur.length >= 2) polylines.push(cur);
      }
      cur = [sp.a, sp.b];
    }
    if (cur && cur.length >= 2) polylines.push(cur);
    return polylines;
  };

  /** 点是否位于多轮廓材料区：使用奇偶规则，因此天然支持孔洞与多岛。 */
  S.pointInLoops = function (p, loops) {
    let inside = false;
    for (const lp of loops) {
      const pts = lp.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if ((a.y > p.y) !== (b.y > p.y) &&
            p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    return inside;
  };

  /** 把有限线段裁剪到多轮廓材料区，返回位于材料内部的若干线段。 */
  S.clipSegmentLoops = function (a, b, loops) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const ts = [0, 1];
    for (const lp of loops) {
      const pts = lp.pts;
      for (let i = 0; i < pts.length; i++) {
        const c = pts[i], d = pts[(i + 1) % pts.length];
        const wx = d.x - c.x, wy = d.y - c.y;
        const den = vx * wy - vy * wx;
        if (Math.abs(den) < EPS) continue;
        const qx = c.x - a.x, qy = c.y - a.y;
        const t = (qx * wy - qy * wx) / den;
        const u = (qx * vy - qy * vx) / den;
        if (t > EPS && t < 1 - EPS && u >= -EPS && u <= 1 + EPS) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    const uniq = ts.filter((t, i) => i === 0 || Math.abs(t - ts[i - 1]) > 1e-6);
    const out = [];
    for (let i = 0; i + 1 < uniq.length; i++) {
      const t0 = uniq[i], t1 = uniq[i + 1];
      if (t1 - t0 < 1e-5) continue;
      const tm = (t0 + t1) * 0.5;
      const mid = { x: a.x + vx * tm, y: a.y + vy * tm };
      if (!S.pointInLoops(mid, loops)) continue;
      const p0 = { x: a.x + vx * t0, y: a.y + vy * t0 };
      const p1 = { x: a.x + vx * t1, y: a.y + vy * t1 };
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) >= 0.6) out.push([p0, p1]);
    }
    return out;
  };

  /**
   * 真六边形蜂窝：先生成共享边去重的六边形格，再按零件轮廓裁剪。
   * side 按目标线密度换算，使相同 density 下三种图案的材料量处于同一量级。
   */
  S.honeycombLoops = function (loops, spacing, phase) {
    if (!loops.length || spacing <= 0) return [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const lp of loops) for (const p of lp.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    const side = Math.max(0.9, spacing * 1.15);
    const hexH = Math.sqrt(3) * side;
    const xStep = side * 1.5;
    const pad = side * 2;
    const edges = new Map();
    const keyPoint = (p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
    const addEdge = (a, b) => {
      const ka = keyPoint(a), kb = keyPoint(b);
      const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      if (!edges.has(key)) edges.set(key, [a, b]);
    };
    let col = 0;
    const shiftX = phase ? xStep * 0.5 : 0;
    for (let cx = x0 - pad + shiftX; cx <= x1 + pad; cx += xStep, col++) {
      const yShift = (col % 2) * hexH * 0.5;
      for (let cy = y0 - pad + yShift; cy <= y1 + pad; cy += hexH) {
        const v = [];
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k;
          v.push({ x: cx + Math.cos(a) * side, y: cy + Math.sin(a) * side });
        }
        for (let k = 0; k < 6; k++) addEdge(v[k], v[(k + 1) % 6]);
      }
    }
    const clipped = [];
    for (const edge of edges.values()) {
      for (const seg of S.clipSegmentLoops(edge[0], edge[1], loops)) clipped.push(seg);
    }
    return S.chainSegments(clipped);
  };

  /** 根据 UI 选择生成真正不同的稀疏填充路径。 */
  S.patternFill = function (loops, pattern, spacing, layerIndex, angleOffset) {
    const name = String(pattern || "斜线网格");
    if (name.includes("蜂窝")) return S.honeycombLoops(loops, spacing, layerIndex % 2);
    const base = name === "直线" ? 0 : 45;
    const angle = base + (layerIndex % 2) * 90 + (angleOffset || 0);
    return S.hatchLoops(loops, angle, spacing);
  };

  /** 清理闭合轮廓，并依据嵌套深度标记外轮廓/孔洞。 */
  S.contourLoops = function (contours) {
    const clean = [];
    for (const source of contours) {
      let pts = source.slice();
      if (pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.05)
        pts = pts.slice(0, -1);
      if (pts.length >= 3 && Math.abs(FXU.polyArea(pts)) > 0.05) clean.push({ pts });
    }
    for (let i = 0; i < clean.length; i++) {
      let depth = 0;
      const probe = clean[i].pts[0];
      for (let j = 0; j < clean.length; j++) {
        if (i !== j && S.pointInLoops(probe, [clean[j]])) depth++;
      }
      clean[i].hole = depth % 2 === 1;
      S.normalizeLoop(clean[i]);
    }
    return clean;
  };

  /* ── 高度场 Marching Squares ──────────────── */

  /**
   * 提取 H(x,y) >= iso 的等值线段并链接为折线。
   * grid: { nx, ny, w, d, H }（H 长度 nx*ny，行主序；物理范围以原点居中）
   */
  S.gridContours = function (grid, iso) {
    const { nx, ny, w, d, H } = grid;
    const cw = w / (nx - 1), ch = d / (ny - 1);
    const ox = -w / 2, oy = -d / 2;
    const segs = [];
    const interp = (va, vb) => {
      const t = (iso - va) / (vb - va || 1e-9);
      return FXU.clamp(t, 0, 1);
    };
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v0 = H[j * nx + i], v1 = H[j * nx + i + 1];
        const v2 = H[(j + 1) * nx + i + 1], v3 = H[(j + 1) * nx + i];
        let c = 0;
        if (v0 >= iso) c |= 1;
        if (v1 >= iso) c |= 2;
        if (v2 >= iso) c |= 4;
        if (v3 >= iso) c |= 8;
        if (c === 0 || c === 15) continue;
        const x0 = ox + i * cw, y0 = oy + j * ch;
        // 四条边上的交点
        const eT = { x: x0 + interp(v0, v1) * cw, y: y0 };            // 上边(v0→v1)
        const eR = { x: x0 + cw, y: y0 + interp(v1, v2) * ch };       // 右边(v1→v2)
        const eB = { x: x0 + interp(v3, v2) * cw, y: y0 + ch };       // 下边(v3→v2)
        const eL = { x: x0, y: y0 + interp(v0, v3) * ch };            // 左边(v0→v3)
        const push = (a, b) => segs.push([a, b]);
        switch (c) {
          case 1: push(eL, eT); break;
          case 2: push(eT, eR); break;
          case 3: push(eL, eR); break;
          case 4: push(eR, eB); break;
          case 5: push(eL, eT); push(eR, eB); break;   // 歧义：分离处理
          case 6: push(eT, eB); break;
          case 7: push(eL, eB); break;
          case 8: push(eB, eL); break;
          case 9: push(eB, eT); break;
          case 10: push(eT, eR); push(eB, eL); break;  // 歧义
          case 11: push(eB, eR); break;
          case 12: push(eR, eL); break;
          case 13: push(eR, eT); break;
          case 14: push(eT, eL); break;
        }
      }
    }
    return S.chainSegments(segs);
  };

  /** 线段链接为折线（端点哈希） */
  S.chainSegments = function (segs) {
    const key = (p) => (Math.round(p.x * 50) + "_" + Math.round(p.y * 50));
    const map = new Map(); // 端点 → [segIdx...]
    segs.forEach((s, i) => {
      for (const p of [s[0], s[1]]) {
        const k = key(p);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
      }
    });
    const used = new Uint8Array(segs.length);
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const line = [segs[i][0], segs[i][1]];
      // 向尾部延伸
      let guard = segs.length;
      while (guard-- > 0) {
        const tail = line[line.length - 1];
        const cand = map.get(key(tail)) || [];
        let found = -1, pt = null;
        for (const ci of cand) {
          if (used[ci]) continue;
          const s = segs[ci];
          if (key(s[0]) === key(tail)) { found = ci; pt = s[1]; break; }
          if (key(s[1]) === key(tail)) { found = ci; pt = s[0]; break; }
        }
        if (found < 0) break;
        used[found] = 1;
        line.push(pt);
      }
      if (line.length >= 2) out.push(line);
    }
    return out;
  };

  /** 高度场逐行填充（材料区 H>=iso），返回蛇形折线组 */
  S.gridHatch = function (grid, iso, spacing) {
    const { nx, ny, w, d, H } = grid;
    const cw = w / (nx - 1), ch = d / (ny - 1);
    const ox = -w / 2, oy = -d / 2;
    const rowStep = Math.max(1, Math.round(spacing / ch));
    const polylines = [];
    let cur = null, dir = 1;
    for (let j = 0; j < ny; j += rowStep) {
      const y = oy + j * ch;
      const spans = [];
      let inside = false, startX = 0;
      for (let i = 0; i < nx; i++) {
        const v = H[j * nx + i];
        const on = v >= iso;
        if (on && !inside) {
          inside = true;
          if (i === 0) startX = ox;
          else {
            const vp = H[j * nx + i - 1];
            const t = (iso - vp) / (v - vp || 1e-9);
            startX = ox + (i - 1 + FXU.clamp(t, 0, 1)) * cw;
          }
        } else if (!on && inside) {
          inside = false;
          const vp = H[j * nx + i - 1];
          const t = (iso - vp) / (v - vp || 1e-9);
          const endX = ox + (i - 1 + FXU.clamp(t, 0, 1)) * cw;
          if (endX - startX > 0.8) spans.push([startX, endX]);
        }
      }
      if (inside) spans.push([startX, ox + (nx - 1) * cw]);
      if (dir < 0) spans.reverse();
      for (const sp of spans) {
        const a = { x: dir > 0 ? sp[0] : sp[1], y };
        const b = { x: dir > 0 ? sp[1] : sp[0], y };
        if (cur) {
          const last = cur[cur.length - 1];
          if (Math.hypot(a.x - last.x, a.y - last.y) <= spacing * 2.6) {
            cur.push(a, b);
            if (cur.length >= 72) { polylines.push(cur); cur = [{ x: b.x, y: b.y }]; }
            continue;
          }
          if (cur.length >= 2) polylines.push(cur);
        }
        cur = [a, b];
      }
      dir = -dir;
    }
    if (cur && cur.length >= 2) polylines.push(cur);
    return polylines;
  };

  /* ── 变换 ─────────────────────────────────── */

  S.transformPts = function (pts, tf) {
    const c = Math.cos(FXU.deg2rad(tf.rotZ || 0)), s = Math.sin(FXU.deg2rad(tf.rotZ || 0));
    const sc = tf.scale || 1;
    return pts.map((p) => {
      const x = p.x * sc, y = p.y * sc;
      return { x: x * c - y * s + (tf.offX || 0), y: x * s + y * c + (tf.offY || 0) };
    });
  };

  /* ── 主切片流程 ───────────────────────────── */

  /**
   * model: 见 models.js（outlinesAt(z)/grid/height/needSupport…）
   * tf: { scale, rotZ, offX, offY }
   * st: 工艺参数
   * 返回 { layers, totalLayers, height, stats }
   */
  S.slice = function (model, tf, st) {
    const scale = tf.scale || 1;
    const H = model.height * scale;
    const lh = st.layerHeight;
    const total = Math.max(3, Math.round(H / lh));
    const ew = st.extrusionWidth;
    const layers = [];

    let extTotal = 0, travelTotal = 0, timeTotal = 0;

    for (let li = 0; li < total; li++) {
      const z = (li + 1) * lh;                 // 该层顶面高度
      const zLocal = Math.min(z - lh * 0.5, H - EPS) / scale; // 层中心采样
      const isSolid = li < st.solidLayers || li >= total - st.solidLayers;
      const density = isSolid ? 1 : st.infillDensity;
      const solidAngle = (li % 2 === 0 ? 45 : 135) + (st.infillAngle || 0);
      const paths = [];

      /* 周界 + 填充 */
      if (model.kind === "grid") {
        const g = model.grid;
        const iso = zLocal; // H 为模型局部高度，在模型局部坐标切片后统一施加变换
        const contours = S.contourLoops(S.gridContours(g, iso).map((pts) => S.transformPts(pts, tf)));
        const innerMost = [];
        for (const lp of contours) {
          let prev = lp.pts;
          for (let k = 0; k < st.perimeters; k++) {
            const off = S.offsetLoop(prev, k === 0 ? ew * 0.5 : ew);
            if (!off) break;
            paths.push({ pts: off.concat([off[0]]), type: "perimeter", closed: true });
            prev = off;
          }
          innerMost.push({ pts: S.offsetLoop(prev, ew * 0.6) || prev, hole: lp.hole });
        }
        if (density > 0.02 && innerMost.length) {
          const spacing = Math.max(ew, ew / Math.max(0.04, density));
          const fills = isSolid || density >= 0.95
            ? S.hatchLoops(innerMost, solidAngle, spacing)
            : S.patternFill(innerMost, st.infillPattern, spacing, li, st.infillAngle);
          for (const f of fills) if (f.length >= 2)
            paths.push({ pts: f, type: isSolid ? "solid" : "infill", pattern: isSolid ? "solid" : st.infillPattern });
        }
      } else {
        const sec = model.outlinesAt(zLocal) || { loops: [] };
        const loops = (sec.loops || []).map((lp) => S.normalizeLoop({ pts: lp.pts.slice(), hole: !!lp.hole }));
        const tfLoops = loops.map((lp) => ({ pts: S.transformPts(lp.pts, tf), hole: lp.hole }));

        // 周界（从外到内）
        const innerMost = [];
        for (const lp of tfLoops) {
          let prev = lp.pts;
          for (let k = 0; k < st.perimeters; k++) {
            const off = S.offsetLoop(prev, k === 0 ? ew * 0.5 : ew);
            if (!off) break;
            paths.push({ pts: off.concat([off[0]]), type: "perimeter", closed: true });
            prev = off;
          }
          innerMost.push({ pts: S.offsetLoop(prev, ew * 0.6) || prev, hole: lp.hole });
        }
        // 填充
        if (density > 0.02 && innerMost.length) {
          const spacing = Math.max(ew, ew / Math.max(0.04, density));
          const fills = isSolid || density >= 0.95
            ? S.hatchLoops(innerMost, solidAngle, spacing)
            : S.patternFill(innerMost, st.infillPattern, spacing, li, st.infillAngle);
          for (const f of fills)
            paths.push({ pts: f, type: isSolid ? "solid" : "infill", pattern: isSolid ? "solid" : st.infillPattern });
        }
        // 支撑（模型给出支撑区域）
        if (st.supportEnabled && model.supportRegionAt) {
          const reg = model.supportRegionAt(zLocal);
          if (reg && reg.length) {
            const regTf = reg.map((lp) => ({ pts: S.transformPts(lp.pts, tf), hole: !!lp.hole }));
            const sf = S.hatchLoops(regTf, 0, st.supportSpacing, st.supportSpacing * 3);
            for (const f of sf) paths.push({ pts: f, type: "support" });
          }
        }
      }

      /* 首层裙边 */
      if (li === 0 && st.skirtLoops > 0) {
        const outers = paths.filter((p) => p.type === "perimeter");
        if (outers.length) {
          // 用全层包围盒近似生成圆角矩形裙边（工程上常见且稳健）
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of paths) for (const q of p.pts) {
            if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
            if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
          }
          for (let k = 0; k < st.skirtLoops; k++) {
            const m = st.skirtGap + k * ew * 2;
            const r = 4 + m;
            const rr = [];
            const cx0 = x0 - m, cy0 = y0 - m, cx1 = x1 + m, cy1 = y1 + m;
            const corner = (cx, cy, a0) => {
              for (let a = 0; a <= 6; a++) {
                const t = a0 + (a / 6) * (Math.PI / 2);
                rr.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
              }
            };
            corner(cx0 + r, cy0 + r, Math.PI); corner(cx1 - r, cy0 + r, Math.PI * 1.5);
            corner(cx1 - r, cy1 - r, 0); corner(cx0 + r, cy1 - r, Math.PI * 0.5);
            rr.push(rr[0]);
            paths.unshift({ pts: rr, type: "skirt", closed: true });
          }
        }
      }

      /* 统计 */
      let extLen = 0, travelLen = 0, tSec = 0;
      let prevEnd = null;
      const vPer = st.speed * 0.55, vInf = st.speed, vSup = st.speed * 0.9, vTrav = st.travelSpeed;
      const firstFactor = li === 0 ? 0.45 : 1;
      for (const p of paths) {
        const L = FXU.pathLen(p.pts);
        p.len = L;
        extLen += L;
        const v = (p.type === "perimeter" || p.type === "skirt" ? vPer : p.type === "support" ? vSup : vInf) * firstFactor;
        p.speed = v;
        tSec += L / v;
        if (prevEnd) {
          const d = Math.hypot(p.pts[0].x - prevEnd.x, p.pts[0].y - prevEnd.y);
          travelLen += d; tSec += d / vTrav;
          if (d > 2 && st.retraction > 0.05) tSec += (st.retraction * 2) / 40;
        }
        prevEnd = p.pts[p.pts.length - 1];
      }
      tSec += 1.1; // 换层（Z 移动 + 回抽）
      extTotal += extLen; travelTotal += travelLen; timeTotal += tSec;

      layers.push({ z, paths, extLen, travelLen, timeSec: tSec });
    }

    const filamentArea = ew * lh;            // 挤出截面近似 mm²
    const volumeMm3 = extTotal * filamentArea;
    return {
      layers,
      totalLayers: total,
      height: H,
      stats: {
        extLenMm: extTotal,
        travelMm: travelTotal,
        timeSec: timeTotal,
        volumeCm3: volumeMm3 / 1000,
        filamentM: (volumeMm3 / (Math.PI * 0.875 * 0.875)) / 1000, // ⌀1.75 折算
      },
    };
  };

  root.FXSlicer = S;
})(typeof window !== "undefined" ? window : globalThis);
