# Changelog

All notable ForgeX changes are recorded here. Entries describe reviewed repository stages rather
than implying that an unreleased build is already deployed.

## Unreleased

### Changed

- The engine migration to TypeScript is complete: all 25 classic `js/*.js` modules now have ESM
  twins under `frontend/src/engine/`, and the final holdout `ui.js` was absorbed — its surviving
  engine-glue duties (toast/confirm bus events, page-refresh dispatch, idle-ghost sync, model
  export, builtin catalog) moved into the typed `WorkbenchUi` class, while the brand mark and
  fullscreen button became React-rendered. The transitional `globals-bridge` and every `FX*`
  global read (`THREE`, `FXFarmDataset`, `FXInsightData`) were removed in favour of direct
  imports, so the React entry ships zero classic scripts (only the `window.FX` debug handle
  remains). Parity with the classic entry is re-verified by the `react-parity` layout/pixel gate
  and the `workbench-authority` C# wiring E2E.
- The React workbench (`/react`) now reproduces the original single-page 3D workbench instead of a
  separate multi-page layout: it reuses `css/style.css` byte-for-byte and re-implements the
  cockpit, workflow navigation, all four context pages, the process-parameter panel, overlays
  (toasts/modals/log/temperature chart), and the manufacturing-insight panel as React components.
  The classic entry (`/`) behaves exactly as before; `insight.js` is no longer loaded by the React
  entry.
- Behavioural parity between both entries is enforced by `tests/e2e/react-parity.spec.js`
  (per-selector layout contract plus whole-screen pixel comparison with the 3D canvas masked).
- G-code imports in the React workbench submit a durable C# analysis job (SSE progress with polling
  fallback) when built with `VITE_GCODE_AUTHORITY=dotnet`, presenting the authoritative summary next
  to the browser parse; the default browser build performs zero authority requests. Covered by
  `tests/e2e/workbench-authority.spec.js` against a fully validated 1.4 contract mock.
- Superseded multi-page React features, adapters, workers, and their styles were removed; the
  retained C# wiring (contract parsing, job client, generated OpenAPI types) moved to
  `frontend/src/authority/`. `react-router-dom`, npm `three`, and testing-library dependencies were
  dropped from the frontend workspace.

### Added

- Stage 6-B adds atomic per-owner/per-tenant active-job admission, stable 429 rejection codes,
  durable-state gauges, job-duration metrics, and a repeatable 16-request capacity fixture. Default
  limits are 4 active jobs per owner, 16 per tenant, and 64 queued items.
- Stage 6-C accepts one bounded previous internal secret during rotation, adds a lockfile/install
  script/registry/secret/container audit, and enables weekly npm, Actions, and Docker update review.
- Stage 6-D defines measurable availability, completion, failure, RPO, and RTO objectives plus six
  Prometheus alerts, incident procedures, a verified recovery drill, and image-tag rollback controls.

- Stage 6-A persists G-code job attempt counts, retry budgets, next-attempt timestamps, and
  dead-letter timestamps in the file repository and exposes them through the additive OpenAPI
  `retry` snapshot object.
- The C# worker classifies deterministic analysis failures separately from transient stream,
  storage, timeout, and unexpected failures; transient failures use bounded exponential backoff
  and become `failed / dead-letter / gcode_retry_exhausted` after the configured budget.
- Worker restart now requeues durable `running` jobs instead of immediately failing them. Prometheus
  output includes bounded queue depth/capacity plus retry, recovery, and dead-letter counters.

### Operations

- Added `security:audit`, `ops:check`, `dotnet:capacity`, and `dotnet:recovery-drill` release gates;
  their JSON artifacts are retained by CI for 14 days.
- Added `deploy/capacity-plan.md`, `deploy/SLO.md`, `deploy/RUNBOOK.md`, and Prometheus rules under
  `deploy/alerts/`. Stage 6 production hardening is now complete for the single-authority file-store
  topology; multi-replica execution still requires shared storage and exclusive job claiming.

- Added `GCodeJobs:QueueCapacity` and `GCodeJobs:Retry:*` configuration with fail-fast bounds.
- Expanded JobGate from 20 checks in Stage 5-D to 37 checks for retry policy, persistence migration,
  retry metadata, bounded queueing, and owner/tenant admission.
