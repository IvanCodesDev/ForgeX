# FORGE·X Insight

### Turn every print into an observable, reproducible, and analyzable digital experiment

[![CI](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml/badge.svg)](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.19.0-2563eb)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-16a34a)
![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f172a)
[![License](https://img.shields.io/badge/license-Apache--2.0-f97316)](./LICENSE)

[简体中文](./README.md) · **English**

**FORGE·X Insight** is an open-source, local-first FDM 3D-printing digital experimentation and production analytics platform. It connects model preparation, slicing, G-code visualization, machine simulation, real machine logs, time calibration, and statistical analysis in one traceable workflow.

Open the web app for a fully offline experience. Start the zero-runtime-dependency Node.js service to add persistence, sharing, knowledge retrieval, API-key authentication, reviewed calibration releases, and optional AI-assisted narratives. Core simulation, statistical computation, and evidence generation do not depend on cloud services.

> **Current release: v0.19.0.** The P0–P8 engineering roadmap is complete, with additional verifiable process-parameter effects: lines, diagonal grids, and honeycomb now generate different toolpaths, while retraction participates in motion timing and quality telemetry. Bundled data are conformance fixtures, not claims of factory accuracy.

## Problems it solves

| Common problem                                              | FORGE·X approach                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Simulation is only an animation and cannot be audited       | Toolpaths, telemetry, events, quality reports, and production records share one runtime data chain |
| G-code, slicer estimates, and machine logs are disconnected | Layer-by-layer 2D/3D replay, paired-log comparison, and holdout-validated time calibration         |
| Analytics provide conclusions without confidence            | Provenance, sample size, confidence intervals, significance, charts, and actions remain visible    |
| Calibration models lack release governance                  | Two-key review, no self-approval, atomic release, version audit, and drift-based deactivation      |
| Cloud AI becomes a runtime requirement                      | Local rules and statistics work by default; AI only narrates computed evidence                     |

## Core capabilities

### One workflow from model to insight

`Model or real G-code → Toolpath preview → Calibration → Replay → Quality → Insight`

- **Model preparation**: built-in parametric models, placement and scaling, image reliefs, and silhouette extrusion.
- **Slicing**: perimeters, solid skin, scanline infill, support, and skirt, with synchronized 2D/3D layer previews.
- **Real-job review**: import common Cura, PrusaSlicer, OrcaSlicer, and SuperSlicer dialects, preserve real E increments for replay, and compare slicer claims with machine logs.
- **Time calibration**: publish versioned candidates through two-key review, then match exact machine, firmware, and material scopes. Only real-provenance `active` models that pass at least five holdout jobs are applied automatically; later jobs continuously check error and drift.
- **Machine simulation**: separate CoreXY, i3, Delta, and large-format gantry kinematics across preheat, leveling, printing, pause, recovery, and completion.
- **Process monitoring**: live nozzle and bed temperatures, filament, load, progress, and event timeline.
- **Quality assessment**: task-level reports based on thermal deviation, leveling residuals, speed changes, and recorded faults.
- **Production insight**: explainable analysis across machines, materials, layer heights, costs, and failed batches.

## Why FORGE·X

### Physics-driven behavior

Toolpaths, thermal inertia, bed error, leveling compensation, and extrusion are computed at runtime. The thermal-runaway drill changes heater state and lets the monitoring chain detect the result; other fault drills exercise alarm and recovery flows. This makes the workspace useful for teaching, validation, and process discussion.

### One source for simulation and data

A single-machine run can become a production record, while the virtual-farm tool generates reproducible datasets from a fixed seed. Analytics consume the same data chain instead of a separate presentation-only dataset.

### Extensible, with explicit boundaries

Machine and material profiles are declarative JSON. Community bundles can extend build volumes, temperatures, density, flow, shrinkage, reference pricing, and physical traits, but cannot execute code, replace built-in IDs, or claim an unsupported kinematic model. Dataset manifests record provenance, licensing, privacy, reproduction commands, and file hashes.

### Operational calibration

Each G-code/machine-log pair is linked by SHA-256. Calibration bundles preserve the training-set fingerprint, provenance, scope, revision, holdout metrics, and admission thresholds. The service records submit, review, reject, and release events and prevents self-approval. Later paired jobs produce `stable`, `warning`, or `drift`; drifted models stop matching automatically. The bundled synthetic example demonstrates the format and makes no production-accuracy claim.

### Explainable statistics

Reports preserve sample size, confidence intervals, significance, and provenance. The statistics kernel includes Wilson intervals, Fisher's exact test, partial correlation, and the Mann–Kendall trend test, with explicit handling for insufficient evidence and confounding.

### Local-first, AI optional

The default rules engine completes statistical analysis without keys or external requests. When InfiniSynapse or an OpenAI-compatible endpoint is enabled, AI organizes the narrative while numbers, charts, and evidence remain generated by the local statistics pipeline.

## Quick start

### Open directly

Open `index.html`. No installation or network connection is required.

### Start the complete service

```bash
node server/index.js
# or
npm start
```

Visit [http://127.0.0.1:8787](http://127.0.0.1:8787).

Service mode also enables:

- persistent data sources, knowledge documents, share pages, and usage records;
- analysis progress events and result caching;
- API-key authentication plus AI concurrency and daily budget controls;
- `/healthz` health checks and Prometheus metrics at `/metrics`;
- candidate calibration submission, two-key review, atomic release, and browser synchronization.

> Node.js 18 or newer is required. The application has no npm runtime dependencies; ESLint, Prettier, and Playwright are development-only tools.

## Analytics

### Data inputs

| Source                     | Use                                                 |
| -------------------------- | --------------------------------------------------- |
| Built-in virtual-farm data | Explore the full analysis workflow immediately      |
| CSV upload                 | Analyze your own production-job records             |
| Simulation capture         | Turn the current print run into a production record |

Built-in and simulation-derived data carry provenance labels. Uploaded data retain their own provenance, which follows the result into reports and share pages.

### Analysis dimensions

1. Machine failure ranking and attribution
2. Material failure-rate comparison
3. Layer height versus print duration
4. Cost trend and composition
5. Failed-batch attribution

Each report combines a verdict, evidence, charts, confidence, and actionable recommendations. When a question falls outside the available dimensions or the evidence is insufficient, the interface offers supported directions for further analysis.

## Simulation and export

| Capability              | Implementation                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Slicing                 | Perimeter offset, even-odd scanline infill, solid skin, support, and skirt                            |
| G-code review           | Common Cura/Prusa comments, absolute/relative E, corner/center origin, 2D/3D replay                   |
| Machine logs and timing | Standard JSON or common CSV; versioned bundles, exact scopes, holdout admission, and drift monitoring |
| Thermal and leveling    | Inertial thermal model; 3×3 probing, 5×5 mesh, bilinear compensation                                  |
| Profile extensions      | Machine/material JSON bundles, schema, allowlist, range checks, reference pricing, local persistence  |
| Export                  | Binary STL, ASCII OBJ, and Marlin-style G-code                                                        |

Manufacturing files should be revalidated against the target slicer, firmware configuration, and machine-safety process before use on physical equipment.

## Architecture

```text
Browser
├─ 3D scene / printer kinematics / print animation
├─ slicer / G-code replay / machine-log comparison / time calibration
├─ profile + calibration registries / reviewed releases / simulator
├─ statistics kernel / insight engine / fleet view
└─ API client
        │
        ▼
Node.js service
├─ datasource / analysis / knowledge / share / calibration review
├─ file store / cache / auth / quota / metrics
└─ providers
   ├─ local rules
   ├─ InfiniSynapse
   └─ OpenAI-compatible endpoint
```

- **Frontend**: Three.js r152 and native JavaScript, runnable without a build step.
- **Backend**: native Node.js `http` with zero runtime dependencies.
- **Storage**: writes to `data/` by default; container deployments retain it through a volume.
- **Security**: static-resource allowlist, traversal protection, optional API keys, and AI budget gates.

## Verification

```bash
npm test             # 639 core/service assertions + 17 ecosystem, 61 fixture, 22 calibration, 25 release checks
npm run test:e2e     # 27 browser scenarios: full Chromium + critical Firefox/WebKit paths
npm run validate:fixtures
npm run validate:calibrations
npm run release:check
npm run lint
npm run format:check
```

Coverage includes slicing, G-code, machine logs, time calibration, profiles, leveling, simulation, exports, statistics, insights, virtual-farm datasets, backend contracts, and critical UI flows across three browser engines.

See [`validation/README.md`](./validation/README.md) for dialect fixtures and
the real-data contribution workflow, and [`calibration/README.md`](./calibration/README.md)
for the P7/P8 bundle, admission, reviewed-release, and drift lifecycle. Bundled reports and models
are `synthetic-conformance` and never match user jobs automatically.

After deployment:

```bash
node tests/deploy-check.js https://your-domain.example
```

## Deployment

### Docker Compose

```bash
docker compose up -d
```

The default configuration uses local analysis and requires no external AI service. `docker-compose.yml` includes a persistent volume.

### Node.js

```bash
copy server\.env.example server\.env
node server/index.js
```

Common environment variables:

| Variable                                  | Purpose                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `ANALYSIS_PROVIDER`                       | `auto`, `local`, `infinisynapse`, or `openai`                               |
| `DATA_DIR`                                | Persistence directory; defaults to the project `data/` directory when unset |
| `API_KEYS` / `REQUIRE_AUTH`               | API keys, global authentication, and two-key calibration review             |
| `AI_CONCURRENCY` / `AI_QUEUE_MAX`         | AI concurrency and queue limits                                             |
| `AI_DAILY_PER_CALLER` / `AI_DAILY_GLOBAL` | Per-caller and instance-wide daily budgets                                  |
| `PUBLIC_BASE`                             | Public base URL used for share links                                        |

See [`server/.env.example`](./server/.env.example) for the complete configuration and [`SECURITY.md`](./SECURITY.md) for deployment guidance.

## Repository layout

```text
css/                  interface design system
js/                   simulation, slicing, analytics and UI
server/               HTTP service, providers and platform controls
datasets/             reproducible virtual-farm datasets
profiles/             machine/material profile schema and examples
logs/                 machine-log schema and examples
validation/           paired G-code/log fixtures and calibration reports
calibration/          versioned calibration bundle schema and demonstration
tools/                headless simulation and dataset generation
tests/                unit, contract and end-to-end tests
```

## Project scope

FORGE·X Insight is designed for digital simulation, process exploration, education, and production-data analysis. It exports manufacturing files but does not directly connect to or control physical printers.

Release history is available in [`CHANGELOG.md`](./CHANGELOG.md).

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before contributing. New user-facing behavior should include tests and documentation, and every interface claim must be directly verifiable in the current implementation.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
