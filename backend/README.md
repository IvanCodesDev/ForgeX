# FORGE·X .NET 10 authority prototype

This directory is the sidecar authority introduced by the optimization manual. It does not replace the existing Node/JS application yet.

## Runtime contract

- SDK: .NET `10.0.302` (`global.json`)
- Target: `net10.0`
- Production projects: no external `PackageReference`
- Package sources: cleared by `backend/NuGet.Config`
- Default API binding: loopback only, `http://127.0.0.1:8788`
- Migration modes: `browser` (current default), `shadow`, then `dotnet`

The local SDK is discovered by `tools/run-dotnet.js`. CI may use a system SDK with the exact same version.

## Commands

```text
npm run dotnet:build
npm run dotnet:golden
npm run dotnet:jobs
npm run dotnet:persistence
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
