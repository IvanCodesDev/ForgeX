# FORGE·X Insight — 3D-Printing Simulation & Data Analysis

[简体中文](./README.md) · **English**

A dual-engine application for additive manufacturing — **"FORGE·X Simulation × Data Analysis"**:

- **FORGE·X Simulation**: a structurally faithful, industrial-grade 3D printer sits at the center of a dark blue-grey engineering-grid space, with four switchable machine models — FX-256 (enclosed CoreXY, triple-leadscrew drop bed) / FX-220 (i3 gantry, Y-moving bed) / FX-Δ260 (Delta parallel arms, inverse kinematics) / FX-500 (large-format industrial gantry, four-corner leadscrew lift). Switch from the "Model" panel and watch slice-path planning, nozzle motion along toolpaths, layer-by-layer deposition, support structures and infill logic in real time;
- **Manufacturing Insight**: natural-language analysis over production data — machine-fault attribution, material failure-rate comparison, layer-height correlation, cost-trend breakdown — with a KPI dashboard, charts and actionable advice; a finding can be pinpointed back into the 3D viewport in one click (viewport linkage).

The UI uses light frosted-glass floating cards — the 3D viewport is the stage; panels expand on demand and collapse when done.

## Quick Start

**Zero-dependency, just open it**: double-click `index.html` (no server, no network required); the Insight panel uses the local demo analysis engine.

**Run with the backend (recommended, still zero-dependency)**:

```bash
node server/index.js        # or: npm start
# open http://127.0.0.1:8787 — front & back are same-origin, the Insight panel
# switches to the backend engine automatically and unlocks the "share page".
# No npm install required.
```

**Deploy**: the repo ships `render.yaml` (Render Blueprint, one-click) and `Dockerfile` (Fly.io / Railway / Zeabur / self-hosted). After deployment, run `node tests/deploy-check.js https://your-domain` to verify the whole chain (health check / static assets / analysis SSE / share page).

**Backend dual engine**: with no InfiniSynapse key it runs the **backend demo engine** (reuses the local analysis logic, isomorphic output); set `INFINI_API_KEY` and `INFINI_VERIFIED=1` in `server/.env` (see `server/.env.example`) and it switches to **real InfiniSynapse cloud analysis** (contract verified 2026-07: SSE event stream + multi-step SQL aggregation + structured report + workspace files) — with zero frontend changes.

**Browser support**: Chrome / Edge / Firefox / Safari, plus Chinese dual-core browsers (360 / QQ / Sogou, "speed mode"):

- Rendering is based on three.js r152; falls back from WebGL2 to WebGL1 automatically (old iGPUs / VMs / remote desktops all open, identical visuals, slightly lower performance);
- Declares `renderer=webkit` for dual-core browsers to avoid the IE-compatible kernel;
- Renderer creation retries "antialias → no-antialias → conservative params" to maximize startup on old GPUs;
- Rough floor: Chromium 58+ / Firefox 54+ / Safari 11+ (ES2017 baseline). Older kernels get a clear upgrade page instead of a blank screen.

You can also use a local server:

```bash
python -m http.server 8080
# open http://localhost:8080
```

## Feature Overview

| Area | Content |
|---|---|
| Top step pills | Model (incl. transforms) · Slice · Calibrate · Quality · **Insight**; click to expand the left floating card, click again to collapse |
| Manufacturing Insight panel | Data intake (sample / upload CSV / sim capture), KPI dashboard (jobs / yield / avg. good-part cost / key machine), natural-language questions, report & charts, analysis history, 3D viewport-linked locate |
| Parameters overlay (top-right) | Process presets (fine/standard/draft/strong), material system (PLA/PETG/ABS/TPU), layer height, perimeters, infill, temps, speed, retraction, fan, supports |
| Bottom control dock | Progress ring, start/pause/stop, current layer, ETA, nozzle/bed temperature at a glance |
| Monitor overlay (waveform button) | Live temperature curves, filament level, machine load, event log, fault-drill injection |
| Fullscreen 3D viewport | FORGE·X printer simulation + layer-by-layer animation; LMB orbit / RMB pan / wheel zoom; three camera presets (overview / nozzle / top) |

### Manufacturing Insight · Production Data Analysis (core feature)

Open the "Insight" panel, ask in natural language, and get "verdict + charts + advice" in seconds:

- **Typical questions**: which machine fails most and why / PLA vs PETG failure rate on overhangs / layer-height vs print-time correlation / this month's cost trend / common causes across failed batches;
- **Three data channels**: 96 built-in sample rows out of the box; upload your own CSV (loose CN/EN header matching, automatic yuan↔cent cost conversion); every completed/aborted simulated print is auto-captured as a "sim capture" dataset (**self-contained loop**: the full analysis chain works without any external data);
- **Viewport linkage**: after locating a problem machine, pinpoint it in the 3D viewport in one click (camera switch + status-LED blink);
- **Three engine tiers**: `file://` → local demo engine (zero-dep); `node server/index.js` → backend demo engine (isomorphic output + SSE progress + share page); InfiniSynapse key + verified endpoints → real cloud AI analysis. Progressive, with zero frontend change (see `js/api-client.js`);
- **Report sharing**: in backend mode a report can generate a public share page (server-rendered, valid for 24h);
- All amounts are stored as integer cents and displayed in yuan, to avoid floating-point error.

### Image → 3D Print (core feature)

The "Model Import" panel accepts drag-and-drop PNG / JPG / WebP:

- **Relief mode**: image brightness maps to surface height (Lithophane-like), good for photos and patterns;
- **Silhouette mode**: extract the subject outline by a brightness threshold and extrude it, good for logos and icons;
- Adjustable output width (40–140mm), max height and invert; it re-slices automatically and is ready to print.

### Simulation Details

- Real slicing pipeline: perimeter offset → even-odd scanline infill (45°/135° alternating) → top/bottom solid layers → overhang supports → first-layer skirt; the slice-panel slider **previews any layer's real extrusion toolpath directly in the 3D viewport** (same data source as the 2D preview);
- Thermal inertia model (first-order lag + overshoot + noise): preheat → 3×3 auto-level → layer-by-layer print → done, a full state machine;
- **Calibration is a real data chain**: each machine model has an intrinsic (deterministic) bed-error field → 9-point probe (logged values are the samples) → fit a 5×5 compensation mesh → bilinear Z compensation by nozzle position at print time (full on the first layer, fading out within 6mm); printing un-leveled yields a genuine first-layer unevenness warning;
- Temperature / speed / fan are adjustable mid-print; geometry is locked mid-print (matching real slicer behavior);
- Fault drills with a real detection chain: filament runout / clog are sensor-reported; **the thermal-runaway drill injects a "heater failure" physical disturbance** — temperature truly drops by thermal inertia and the runaway monitor (deviation >15°C, no recovery, sustained 3s, Marlin-like semantics) discovers it from measured deviation and cuts the heater; no false alarms during recovery;
- Dual quality view: pre-print **parameter estimate** (derived live from parameters) + post-print **measured report** — temperature-deviation integral, leveling residual, fault/pause/tuning records, and variable-speed time share, all from this print's real telemetry.

### Result Export (core feature)

The "Model" panel's "Export" supports three formats:

| Format | Content |
|---|---|
| STL (binary) | Result triangle mesh with current scale, Z-up; ready for Cura / PrusaSlicer re-slicing |
| OBJ (ASCII) | Generic 3D format; opens directly in modeling/rendering tools |
| **G-code** (Marlin-style) | Generated from the real slice toolpaths: temps, homing, leveling, per-layer XY/E/F, retraction/prime, fan control; extrusion computed for ⌀1.75 filament (ΣE conserved vs. slice stats, verified by test assertions) |

## Built-in Models

| Model | Highlights |
|---|---|
| Planetary gear | 26 teeth + center bore + 4 lightening holes, two-stage profile (gear body + hub boss) |
| Turbine impeller | 7 continuously twisting blades (per-layer cross-section computed), showcases complex-part slicing |
| Sensor bracket | Top flange overhanging >60°, demonstrates support generation and its effect |

## Architecture

Pure frontend, zero build: `three.js r152` (localized under `js/vendor/`, UMD build guarantees file:// use; r152 is the last version with full official WebGL1 auto-fallback, widest compatibility) + vanilla JS classic scripts.

```
index.html            layout skeleton
css/style.css         design system "Blueprint Glass" (dark blue-grey grid + light frosted cards + orange accents)
js/util.js            utilities (thermal inertia model, noise, event bus, etc.)
js/orbit.js           in-house orbit controller
js/slicer.js          slicing engine (polygon offset / scanline infill / Marching Squares, pure & testable)
js/models.js          built-in parametric models + image→heightfield model
js/printer3d.js       printer procedural modeling & print animation (progressive tube reveal + clip-plane freeze + 3D toolpath preview)
js/scene.js           renderer / neutral studio lighting / dark blue-grey engineering-grid floor
js/sim.js             simulation state machine (motion / thermal / bed-error field & leveling compensation / filament / faults / run telemetry / quality estimate & measured)
js/exporter.js        result export engine (binary STL / OBJ / Marlin G-code, pure & testable)
js/insight-data.js    insight data layer (sample generation / CSV parse-export / dataset management, pure & testable)
js/insight-engine.js  local demo analysis engine (intent detection / aggregation / report generation, isomorphic with backend output)
js/api-client.js      own-backend API client (healthz probe / analysis task / SSE; switches to cloud once the backend is up)
js/insight.js         Manufacturing Insight panel (data intake / KPI dashboard / questions / report charts / viewport linkage / share)
js/ui.js              step pills / floating panels / bottom dock / monitor overlay & interactions
js/main.js            bootstrap
server/               own thin backend (Node ≥18 native http, zero npm deps)
  index.js            startup / routing / CORS / rate limit / static hosting (node server/index.js)
  routes/…            analyze (SSE progress) / datasource / knowledge / share
  services/…          infini (the only key holder) / local-engine / analysis / storage
  .env.example        env-var reference (the key lives only in server/.env, excluded by .gitignore)
doc/samples/print_jobs_sample.csv  sample production data (96 rows, upload to try directly)
tests/smoke.js        slicing engine smoke test (32 assertions)
tests/sim-calib.test.js simulation core: leveling data chain / telemetry / measured quality (33 assertions)
tests/exporter.test.js  export engine: STL/OBJ structure / G-code semantics & extrusion conservation (24 assertions)
tests/insight.test.js insight data & analysis engine test (35 assertions)
tests/server.test.js  backend contract test (44 assertions)
tests/check-refs.js   HTML ↔ JS DOM-id cross-check
tests/deploy-check.js post-deploy online smoke (node tests/deploy-check.js <public URL>, 10 assertions)
tests/infini-smoke.js InfiniSynapse connectivity/task smoke (--task fires a real cloud task and prints the event sequence)
package.json          npm start / npm test unified entry (still zero npm deps)
render.yaml           Render Blueprint one-click deploy config
Dockerfile            containerized deploy (Fly.io / Railway / Zeabur / self-hosted)
```

## Tests

```bash
npm test                     # runs the six local suites below (zero-dep, no install)
node tests/smoke.js          # slicing engine: geometry/infill/isolines/three-model slicing/transforms, 32 assertions
node tests/sim-calib.test.js # simulation core: bed-error field/leveling data-chain consistency/full state machine/telemetry & measured quality, 33 assertions
node tests/exporter.test.js  # export engine: triangle extraction/binary STL structure/OBJ/G-code semantics & extrusion conservation, 24 assertions
node tests/insight.test.js   # insight: sample data/CSV parse round-trip/aggregation/intent detection/report structure, 35 assertions
node tests/server.test.js    # backend contract: healthz/datasource/analysis+SSE/knowledge/share/rate limit/path traversal, 44 assertions
node tests/check-refs.js     # HTML ↔ JS DOM-id cross-check

node tests/deploy-check.js https://your-domain   # post-deploy online smoke: health/assets/analysis end-to-end/share page
```

## InfiniSynapse Integration (summary)

The frontend only talks to our own thin backend; the backend is the **only holder of the `sk-` key** and proxies the InfiniSynapse Server API (official best practice: backend proxy + Server API). The analysis flow:

1. The backend generates a `connId` and subscribes to the SSE event stream first (`GET {server}/api/ai/events?connId=…`) — subscribe before creating the task, or early events are lost;
2. Create the task (`POST {server}/api/ai/message`, `{type:"newTask", connId, text, chatSettings:{mode:"act"}}`); the `taskId` comes back via SSE, not in the response body;
3. The cloud runs multiple steps autonomously (inline JSON → Infinity SQL aggregation → conclusion); completion is signaled by `completion_result` with `partial:false`;
4. Fetch workspace artifacts (`GET {server}/api/ai_task/getTaskWorkspace/<taskId>`) and map the cloud result into the frontend-isomorphic report.

Every call logs its `taskId`; reviewers can cross-check the same `taskId` in the platform console at `app.infinisynapse.cn/tasks`.

## Known Limitations

- This platform is a **simulator**: it does not connect to a physical printer (it can export real G-code / STL / OBJ into a physical slicing & printing workflow);
- The honeycomb infill pattern is rendered visually as a diagonal grid;
- Desktop ≥1280px width is recommended (16:9 layout is best);
- It cannot run where WebGL is disabled by system policy (e.g. enterprise control, no GPU driver with software rendering disabled) — a clear notice is shown;
- On Chromium <84 kernels some spacing degrades slightly (no flex-gap support); functionality is unaffected.

## License

UNLICENSED — for the InfiniSynapse × CSDN "Vibe Coding" data-analysis contest submission.
