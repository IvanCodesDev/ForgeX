# FORGE·X Insight — 3D Printing Simulation × Production Data Analysis

[简体中文](./README.md) · **English**

A **physics-driven** additive manufacturing tool: a 3D printer simulator that really slices,
really models thermal inertia, and emits real G-code — paired with an insight panel that
aggregates production data.

> **Status: 0.x, under refactor.** This project started as a contest entry and is being
> rebuilt into an open-source project following the roadmap in `doc/优化文档.md`.
> Everything described below maps to capability that exists in the code today —
> **nothing aspirational is listed as shipped**. Planned work lives in the Roadmap section.

---

## Quick start

```bash
# Option 1: zero dependencies, open directly (no Node, no network)
open index.html

# Option 2: with backend (still zero npm dependencies, no npm install needed)
node server/index.js     # or: npm start
# then open http://127.0.0.1:8787
```

Run the tests:

```bash
npm test        # 260 assertions, zero dependencies
```

---

## What is real here

Credibility matters most for an open-source project, so let's be precise.

### ✅ Real

| Capability                     | Why it's trustworthy                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Slicing engine**             | Perimeter offsetting → even-odd scanline infill → top/bottom solid layers → overhang support → skirt. Real algorithms (`js/slicer.js`, 32 assertions)                                                                                                                                                                                      |
| **Thermal physics**            | First-order lag + overshoot + noise thermal model. Thermal-runaway protection discovers the fault from measured deviation (Marlin-like semantics), not from a scripted trigger                                                                                                                                                             |
| **Bed leveling data chain**    | Per-model deterministic bed error field → 9-point probing → fitted 5×5 compensation mesh → real-time bilinear-interpolated Z compensation during printing. Printing without leveling yields a genuine first-layer unevenness warning                                                                                                       |
| **Four kinematics**            | CoreXY enclosed / i3 gantry / Delta parallel-arm inverse kinematics / large-format gantry — separately implemented, not reskins (`js/printers.js`)                                                                                                                                                                                         |
| **G-code export**              | Generated from actual slice paths; extrusion computed for ⌀1.75 filament; ΣE is conserved against slice statistics (asserted). Loads in Cura / PrusaSlicer                                                                                                                                                                                 |
| **Post-print quality report**  | Temperature deviation integral, leveling residual, speed-variance fraction and fault log all come from this run's real telemetry — not a preset score                                                                                                                                                                                      |
| **Faults emerge from physics** | None of the five fault types (clog / runout / thermal / warping / overhang collapse) is drawn from a probability. Each machine has deterministic intrinsic characteristics (hotend fouling, feeder grip, heater power, ambient draft); a fault is what happens when those interact with the job's process parameters and cross a threshold |
| **Virtual print farm**         | `tools/farm-sim.js` produces production datasets by physics simulation, reproducible row-for-row from a seed. The bundled default dataset is its output                                                                                                                                                                                    |

### ⚠️ Things you should know

| Item                                    | Reality                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The "analysis engine" is not AI**     | The default engine (local and backend) is a **rules engine**: keyword intent routing + deterministic aggregation, covering 5 dimensions. The UI labels it "rules engine (no AI)". For questions outside those dimensions it **says so explicitly** and lists what it supports, rather than pretending to answer |
| **The default data is still simulated** | The default dataset comes from the virtual print farm — **not probability sampling** — so its conclusions are falsifiable: change the process parameters and the fault distribution changes with them. It is still not real production data and is badged accordingly. See `datasets/README.md`                 |
| **Cloud AI mode has _fewer_ features**  | With InfiniSynapse connected, you get text conclusions only — **no charts, no viewport linkage** (the rules engine has both). Reports state this gap explicitly. Fix is roadmap P3                                                                                                                              |
| **Viewport linkage is single-machine**  | The 3D scene holds exactly one printer. Highlighting is offered only when the conclusion points at that same model; otherwise the UI says fleet view isn't implemented                                                                                                                                          |
| **In-memory only**                      | Datasources, tasks and share pages live in memory; a restart clears everything. "Share valid for 24h" means within the process lifetime                                                                                                                                                                         |
| **No auth, no quota**                   | Read the Deployment section before exposing this publicly                                                                                                                                                                                                                                                       |

### ❌ Not present

- **Knowledge base / RAG** — `/api/knowledge` has storage but **no retrieval**; uploaded documents never enter any prompt. The endpoint is kept to reuse the storage plumbing when RAG lands, and it honestly reports `retrievalEnabled: false`
- **Multi-machine fleet view**
- **Connecting to physical printers** (you can export G-code / STL / OBJ into a real workflow)

---

## Features

| Area              | Contents                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Top flow pills    | Model (with transform) · Slice · Calibrate · Quality · **Insight**                                                                  |
| Insight panel     | Data sources (synthetic sample / CSV upload / simulator capture), KPI board, questions, reports & charts, history                   |
| Parameter overlay | Process presets, material system (PLA/PETG/ABS/TPU), layer height, perimeters, infill, temperature, speed, retraction, fan, support |
| Bottom dock       | Progress ring, start/pause/stop, current layer, ETA, nozzle/bed temperature                                                         |
| Monitor overlay   | Live temperature curves, filament remaining, load, event log, fault injection                                                       |
| 3D viewport       | Printer simulation + layer-by-layer animation; LMB orbit / RMB pan / wheel zoom; three camera presets                               |

### Simulation details

- The slice panel slider previews **any layer's real extrusion paths directly in the 3D viewport** (same data as the 2D preview);
- Full state machine: preheat → 3×3 auto bed leveling → layer-by-layer printing → done;
- Temperature / speed / fan adjustable mid-print; geometry parameters locked during printing (matching real slicer behavior);
- Fault drills: runout and clog are reported by sensors; **the thermal-runaway drill injects a heater failure** — temperature falls per thermal inertia and the runaway monitor discovers it from measured deviation.

### Image to 3D print

Drag in PNG / JPG / WebP:

- **Relief mode** — luminance mapped to surface height (lithophane-like);
- **Silhouette mode** — threshold extraction and extrusion;
- Adjustable width (40–140mm), max height, invert. Re-slices automatically.

### Data analysis

Five supported dimensions (anything else is explicitly declined):

1. Machine failure-rate ranking and attribution
2. Material failure-rate comparison
3. Layer height vs. print duration
4. Cost trend and breakdown
5. Failed-batch attribution

Statistical discipline:

- **Minimum sample guard** — a group needs ≥ 5 jobs to be ranked, so a machine with one failed job can't top the chart at "100% failure rate";
- **Confidence labeling** — every report carries a `confidence`; when evidence is thin it refuses to conclude rather than picking something;
- **Confounder disclosure** — correlation analysis states that material/model differences are not controlled for, and never presents correlation as causation;
- **Cost basis disclosed with the report** — the price table is an **estimate, not authoritative data**; it ships with its provenance and can be replaced via `FXInsightData.setCostProfile()`.

### Export

| Format                    | Contents                                                     |
| ------------------------- | ------------------------------------------------------------ |
| STL (binary)              | Triangle mesh with current scale, Z-up                       |
| OBJ (ASCII)               | Generic 3D format                                            |
| **G-code** (Marlin style) | From real slice paths; ΣE conserved against slice statistics |

---

## Architecture

Zero-build frontend: `three.js r152` (vendored in `js/vendor/`; the UMD build keeps `file://`
working. r152 is the last release with full official WebGL1 auto-fallback, maximizing
compatibility) + vanilla JS classic scripts.

Backend: Node ≥18 native `http`, **zero npm dependencies**.

```
index.html            layout
css/style.css         "blueprint glass" design system
js/util.js            utilities (thermal model, noise, event bus)
js/orbit.js           custom orbit controller
js/slicer.js          slicing engine (pure logic, testable)
js/models.js          parametric models + image→heightfield
js/printer3d.js       procedural printer modeling and print animation
js/printers.js        extended machine library (three more kinematics)
js/scene.js           renderer / lighting / engineering grid floor
js/sim.js             simulation state machine (motion / thermal / leveling / filament / faults / telemetry / quality)
js/exporter.js        export engine (STL / OBJ / G-code, pure logic, testable)
js/machine-profile.js machine intrinsic characteristics + fault mechanism models (pure logic)
js/farm-dataset.js    bundled farm dataset (generated; do not hand-edit)
js/insight-data.js    data layer (CSV / provenance / fault taxonomy / dataset management)
js/insight-engine.js  rules analysis engine (intent routing / aggregation / statistical guards)
js/api-client.js      backend API client
js/insight.js         insight panel
js/ui.js              flow pills / floating panels / dock / monitor
js/main.js            bootstrap
server/               thin backend (zero npm dependencies)
tools/headless-sim.js headless simulation driver (full state machine under node)
tools/farm-sim.js     virtual print farm: physics-generated datasets
datasets/             farm datasets and companion telemetry
doc/优化文档.md        current-state audit + refactor roadmap (Chinese)
doc/samples/          legacy probability-synthesized data (regression input only)
tests/                6 suites, 260 assertions total
```

---

## Tests

```bash
npm test                     # run all local suites

node tests/smoke.js          # slicer: geometry / infill / contours / models / transforms (32)
node tests/sim-calib.test.js # sim core: bed error field / leveling chain / state machine / telemetry (44)
node tests/exporter.test.js  # export: STL / OBJ / G-code semantics and extrusion conservation (24)
node tests/insight.test.js   # insight: data / parsing / stats / guards / provenance / honesty (66)
node tests/farm.test.js      # virtual farm: determinism / emergent discrimination / effect inversion (48)
node tests/server.test.js    # backend contract: healthz / datasource / analyze+SSE / share / rate limit / traversal (46)
node tests/check-refs.js     # HTML ↔ JS DOM id cross-check

node tests/deploy-check.js https://your-domain   # post-deploy smoke test
```

**Testing principle**: assert the engine's _properties_, never "the generator planted X so
the analyzer found X". The failure-ranking tests construct datasets with a known injected
effect and check the engine finds it — then **invert the effect and require the conclusion
to invert too**, proving it computes rather than echoes constants.

---

## Deployment

⚠️ **Read before exposing publicly.**

There is currently **no authentication, no quota, and no concurrency cap**. If you configure
an InfiniSynapse key and expose the service, anyone can trigger real cloud tasks
**billed to you**.

For public deployment either:

- **don't** configure `INFINI_API_KEY` (rules engine only), or
- add access control at your reverse proxy, or
- wait for the cost gate in roadmap P4.

`render.yaml` (Render Blueprint) and `Dockerfile` (Fly.io / Railway / Zeabur / self-hosted)
are included. After deploying, run `node tests/deploy-check.js https://your-domain`.

Environment variables: see `server/.env.example`. Secrets go only in `server/.env`
(git-ignored).

---

## Browser support

Chrome / Edge / Firefox / Safari, plus Chinese dual-core browsers in fast mode.

- Falls back to WebGL1 when WebGL2 is unavailable;
- Renderer creation retries with progressively conservative parameters;
- Approximate floor: Chromium 58+ / Firefox 54+ / Safari 11+ (ES2017 baseline). Older engines get an explicit upgrade notice instead of a blank page.

---

## Roadmap

Full version in `doc/优化文档.md`. Summary:

| Phase                        | Contents                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0 Honesty** ✅            | Remove everything claimed-but-not-implemented; statistical guards; provenance; real progress events                                                                                                                                  |
| **P1 Open-source readiness** | LICENSE, CI, lint, community files, English-first code, DOM-level tests                                                                                                                                                              |
| **P2 Real data** ✅          | **Virtual print farm** shipped: each machine has deterministic intrinsic characteristics, all five fault types emerge from physics, simulator telemetry reaches the analysis layer, and the default dataset is now physics-generated |
| **P3 Real analysis**         | Stats kernel (confidence intervals + significance tests + partial correlation), QueryPlan layer, provider abstraction (InfiniSynapse / OpenAI-compatible / local), cloud output isomorphic with local, fleet view, real RAG          |
| **P4 Productionization**     | SQLite persistence, auth, quotas and cost gate, observability                                                                                                                                                                        |
| **P5 Ecosystem**             | Machine/material profile plugins, real G-code import & replay, community datasets                                                                                                                                                    |

---

## Known limitations

- This is a **simulator**: it does not drive physical printers;
- Honeycomb infill renders visually as a diagonal grid;
- Desktop ≥1280px recommended;
- Cannot run when WebGL is disabled by policy (an explicit notice is shown);
- Minor spacing degradation on Chromium <84 (no flex gap); functionality unaffected.

---

## Contributing

The project is in a 0.x refactor; see the roadmap above. One **hard rule**:

> Any PR that introduces text, comments, or documentation claiming capability that isn't
> implemented **will be rejected**.

This is the dividing line between a demo and an engineering product. No exceptions.
