# FORGE·X .NET 10 authority prototype

This directory is the sidecar authority introduced by the optimization manual. It does not replace the existing Node/JS application yet.

## Runtime contract

- SDK: .NET `10.0.302` (`global.json`)
- Target: `net10.0`
- Production projects: no external `PackageReference`
- Package sources: cleared by `backend/NuGet.Config`
- Default API binding: loopback only, `http://127.0.0.1:8788`
- Migration modes: G-code defaults to `browser`; Analytics defaults to `dotnet` with `shadow` and `browser` rollback modes

The local SDK is discovered by `tools/run-dotnet.js`. CI may use a system SDK with the exact same version.

## Commands

```text
npm run dotnet:build
npm run dotnet:golden
npm run dotnet:jobs
npm run dotnet:persistence
npm run dotnet:analytics
npm run dotnet:api
```

Health and contracts:

```text
GET  /health/live
GET  /health/ready
GET  /healthz
GET  /metrics
GET  /openapi/v1.json
POST /api/v1/gcode/analyze
```

The G-code endpoint accepts the raw `application/x-gcode` body. The first slice returns an authoritative summary only; the React Worker remains responsible for immediate 3D preview geometry.

The API writes JSON console logs with a bounded route template, status, elapsed milliseconds, and
trace ID. `/metrics` emits Prometheus text with bounded method/route/status labels, request duration
histograms, uptime, build identity, and the latest file repository readiness/count. Concrete job IDs
are never used as metric labels. This uses only the ASP.NET shared framework; no telemetry package is
added in this slice.

## Stage 4 analytics dual-run

`ForgeX.Analytics` is the analysis migration core. It has no external package reference and ports
the existing browser contract for CSV aliases/status normalization, Wilson intervals, Fisher exact
tests, Pearson correlation, within-group centered partial correlation, Mann-Kendall trend tests,
sample-size guarded failure-rate ranking, and dashboard KPIs. It does not replace the React
report engine by default. Stage 4-D completes the deterministic report-core port for `machine_fault`,
`material_cmp`, `corr_layer`, `cost_trend`, `fail_root`, and the unmatched-question `overview`,
including confidence, evidence, explanatory sections, chart DTOs, machine highlights, and the
reviewed cost profile.

`tests/golden/stage4-analytics-golden.json` freezes four malformed/aliased CSV cases, five Wilson
vectors, four Fisher vectors, six Pearson cases, four partial-correlation cases, seven Mann-Kendall
cases, one ranking matrix, and the existing 400-row physical-farm dataset. The JS validator must
reproduce the JSON byte-for-byte at the semantic level. Twelve report cases additionally freeze all
six report paths over the 400-row farm dataset plus insufficient-sample, non-significant,
short-date, and no-failure edge paths.
`ForgeX.AnalyticsGate` then reads the same inputs and emits
`backend/artifacts/analytics-golden-diff.json` with per-field absolute/relative deltas. Updating this
baseline is an explicit reviewed operation:

```text
node tools/validate-stage4-analytics-golden.js
npm run dotnet:analytics
npm run analytics:golden:update   # only after reviewing and approving an intentional change
```

Stage 4-E adds a stateless `POST /api/v1/analytics/reports` boundary. It accepts `application/json`,
at most 5 MiB and 5000 normalized rows, validates provenance row counts, and returns the same
deterministic report DTO with engine evidence. Node exposes only this fixed same-origin path after
its existing identity and rate-limit guards, streams the body without re-encoding, and strips all
browser credentials before calling the loopback sidecar. Stage 4-F makes `dotnet` the online default:
React computes a temporary JS fallback, compares every browser-owned field, strips authority-only
fields, and uses the C# object for display and export only after an exact match. Mismatch, timeout,
or transport failure leaves the JS report visible with a degraded status. `shadow` remains a
comparison-only mode; `browser` remains the one-release rollback and offline path with zero requests.
Set `ANALYTICS_AUTHORITY_ENABLED=0` to close the proxy independently. Rollback restores Stage 4-E
without changing the frozen golden or stored user data.

Async job endpoints are tenant/owner scoped. In production, configure the same secret as Node's
`GCODE_AUTHORITY_INTERNAL_SECRET` through `InternalAuth__SharedSecret`. Node resolves the browser
session or API key first, derives opaque `tn_` / `ow_` identifiers, and sends those values over the
loopback sidecar boundary. Missing or invalid internal authentication is rejected before job storage;
cross-tenant status, SSE, and cancellation requests return the same not-found response. An empty
secret keeps the explicit `tn_local` / `ow_local` development scope for direct local smoke tests.

## Persistence and recovery

`Persistence:Provider=file` remains the only active runtime provider in this slice. The file job
repository now exposes a readiness probe plus a versioned `forgex-gcode-job-backup/v1` archive.
Archives contain a manifest, tenant/owner metadata, raw job JSON, and a SHA-256 for every entry.
Restore validates the complete archive before writing and accepts only a new or empty target.

```text
node tools/run-dotnet.js run --project backend/tools/ForgeX.PersistenceTool/ForgeX.PersistenceTool.csproj -- backup --source data/dotnet-preview/jobs --output backup/jobs.fxbackup
node tools/run-dotnet.js run --project backend/tools/ForgeX.PersistenceTool/ForgeX.PersistenceTool.csproj -- verify --input backup/jobs.fxbackup
node tools/run-dotnet.js run --project backend/tools/ForgeX.PersistenceTool/ForgeX.PersistenceTool.csproj -- restore --input backup/jobs.fxbackup --target data/restore-drill/jobs
```

`backend/database/postgresql/manifest.json` pins the forward-only PostgreSQL v1 schema by SHA-256.
`npm run postgres:migrations:check` validates ordering, transaction boundaries, tenant/owner keys,
idempotency uniqueness, event storage, row-level security, and the absence of destructive DDL. The
schema is deployment-ready, but selecting `Persistence:Provider=postgresql` fails fast until a
pinned runtime driver and a real PostgreSQL integration environment are added.

## Rollback boundary

The old page remains at `/`, the React page remains at `/react/`, and the default G-code authority remains the browser. Rollback therefore builds React with `VITE_REACT_GCODE_ENABLED=0` and `VITE_GCODE_AUTHORITY=browser`, clears `GCODE_AUTHORITY_URL`, and stops the .NET process. The gateway route may remain deployed: while unconfigured it returns a structured `503` and receives no requests from the rolled-back UI. Keep the file-job backup and any applied PostgreSQL expand migration during the rollback window; no Node data migration is required for this slice.
