# FORGE·X container deployment

This deployment runs the Node gateway and the .NET 10 authority as separate containers. The gateway
is the only published service; authority port `8788` stays on the Compose network. The default file
provider remains lightweight; the optional PostgreSQL profile loads the pinned `pg` driver.

## First start

1. Copy `deploy/.env.example` to `deploy/.env`.
2. Generate a unique random secret of at least 32 bytes and set
   `GCODE_AUTHORITY_INTERNAL_SECRET`. Never reuse the example text from CI or documentation.
   Leave `GCODE_AUTHORITY_INTERNAL_SECRET_PREVIOUS` empty outside a documented rotation window.
3. Set `FORGEX_NODE_IMAGE` and `FORGEX_API_IMAGE` to immutable release tags for reversible deploys.
4. Build and start both services:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --pull
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/react/
```

The images are multi-stage builds pinned to explicit Node/.NET Alpine tags. Runtime containers use
UID `1000` and `1654`, read-only root filesystems, writable service-specific `/app/data` volumes,
`tmpfs` for `/tmp`, no Linux capabilities, and `no-new-privileges`.

## Operations and evidence

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=200 forgex forgex-api
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec forgex-api \
  wget -qO- http://127.0.0.1:8788/health/ready
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec forgex-api \
  wget -qO- http://127.0.0.1:8788/metrics
npm run containers:check
```

The C# service logs one JSON object per request. Metric route labels use templates such as
`/api/v1/jobs/{id}`; they do not contain concrete job IDs. Configure the container engine's log
shipping and Prometheus scraper according to the platform. The bundled `json-file` rotation is a
single-host default, not a centralized audit store.

Stage 6 adds `forgex_gcode_job_queue_depth`, `forgex_gcode_job_queue_capacity`,
`forgex_gcode_job_retries_total`, `forgex_gcode_job_recoveries_total`, and
`forgex_gcode_job_dead_letters_total`. During the measurement window, alert on a positive increase
of dead letters and sustained queue-depth/capacity ratio rather than a single queue sample. Final
thresholds and tenant quotas are documented in [`capacity-plan.md`](./capacity-plan.md). Override retry settings only
with bounded Compose environment values such as `GCodeJobs__Retry__MaxAttempts`; invalid values stop
the authority at startup instead of silently changing behavior.

Before an upgrade, create and verify an authority repository backup using the commands in
`backend/README.md`, and separately back up the Node and authority named volumes according to the
container platform. The CI script `deploy/verify-containers.sh` rebuilds the runtime contract by
checking non-root identities, read-only roots, writable data volumes, health, React delivery,
authority metrics, and restart readiness.

## Rollback

1. Keep the current named volumes and the verified authority backup; do not delete or recreate them.
2. Set `GCODE_ASYNC_JOBS_ENABLED=0` if only the asynchronous authority path must be disabled.
3. If only retry behavior is being rolled back, restore the previous retry environment values first;
   persisted Stage 6-A fields are additive and older readers ignore them.
4. Restore the previously tagged `forgex-insight` and `forgex-authority` images in the Compose file.
5. Run `docker compose ... up -d`, then verify `/healthz`, `/react/`, and authority `/health/ready`.
6. If the authority is being removed entirely, set the React build to browser authority before
   stopping `forgex-api`; the legacy `/` page remains the product rollback boundary.

The Node gateway now supports an optional PostgreSQL runtime for calibration governance, datasources,
knowledge documents, share snapshots, and Node analysis task history.
The default Compose profile remains `PERSISTENCE_PROVIDER=file` for the single-host rollback path. To
enable the shared stores, apply `backend/database/postgresql/migrations/` in order, set
`PERSISTENCE_PROVIDER=postgres`, `POSTGRES_URL`, and (for managed TLS) `POSTGRES_SSL=1` in the Node
environment, then verify `/healthz` reports `persistence=postgres`. Running tasks that are interrupted by
a process restart are recovered as explicit failed tasks; their event history and terminal reports remain
available until the configured TTL. `npm run postgres:migrate` applies the migrations with the pinned
`pg` driver (reads `POSTGRES_URL`, no `psql` needed); it is the same script CI uses against its
PostgreSQL service.

### Stage 8.6a: moving datasources, knowledge and calibration governance to the C# authority

Since Stage 8.1 (`SHARES_AUTHORITY`) every resource leg moves with the same two-step ritual, one
resource at a time, so the browser contract never changes:

1. Enable the C# storage leg on `forgex-api`: `Shares__Provider`, `Datasources__Provider`,
   `Knowledge__Provider` or `Calibrations__Provider` = `file` (single-host, under the authority data
   volume) or `postgres` (same `POSTGRES_URL`, same tables and row-level security as Node). The
   Compose file exposes them as `CSHARP_*_PROVIDER`; the default `disabled` registers no endpoint.
   Optional tuning: `Datasources__TtlMs/MaxPerOwner`, `Knowledge__TtlMs/MaxPerOwner`,
   `Shares__TtlMs/MaxPerOwner`, `Calibrations__MaxSubmissions/TenantId/StateFile`,
   `Resources__SweepIntervalMs` (default 60000).
2. Flip the matching Node switch: `SHARES_AUTHORITY`, `DATASOURCES_AUTHORITY`,
   `KNOWLEDGE_AUTHORITY` or `CALIBRATION_GOVERNANCE_AUTHORITY` = `csharp`. Node keeps validating
   requests and API keys, then proxies over the trusted `GCODE_AUTHORITY_URL` channel (the internal
   secret is mandatory; `RESOURCE_AUTHORITY_TIMEOUT_MS`, default 15000, bounds the upstream wait).

Rollback is the reverse: set the switch back to `node` and restart. Data stays in its own store —
datasources, knowledge and shares are TTL-bound scratch data; calibration governance is the only
long-lived state, so copy Node's `DATA_DIR/calibrations.json` to `Calibrations__StateFile` (file leg)
before cutting over, or share one database (postgres leg) and no copy is needed.

Observability: while a resource runs on the C# leg, Node's `/metrics` gauges `forgex_datasources`,
`forgex_knowledge_docs` and `forgex_shares` read `0`; the authoritative values are the same gauge names
on the C# `/metrics` (plus `forgex_calibrations_approved` / `forgex_calibrations_pending`). Node's
`/healthz` keeps probing whichever leg is active and returns `503 persistence_unavailable` if the
authority is down. Cross-tenant reads return `404` on the C# leg where the Node file leg returned
`403` (the row-level-security convention already used by shares); this is the only approved
difference in the CI dual-run report `resource-authority-dualrun.json`, which since Stage 8.6b also
replays the shares flow (`SHARES_AUTHORITY`) on both storage legs — the public share page is compared
as a full HTML document, so a `csharp` cut-over renders byte-for-byte the same content Node did.
`SHARES_AUTHORITY_TIMEOUT_MS` (default 15000) bounds the share proxy's upstream wait.

### Stage 8.6c-1: analysis-task reads on the C# authority

`ANALYSIS_TASKS_AUTHORITY=csharp` moves the read routes — `GET /api/analyze/:id/result`, the
`GET /api/analyze/:id` poll and (since 8.6c-2a) the `/stream` SSE — onto the C# endpoints
`GET /api/v1/analysis-tasks/{id}` and `/{id}/events`. Since 8.6c-2b the switch also moves creation:
every `POST /api/analyze` is validated by Node (identity, rate limit, question, BYO endpoint syntax)
and created through C# `POST /api/v1/analysis-tasks`, where an in-process host executes it — the
rules engine directly, or the OpenAI-compatible provider with the same prompt, merge rules, cost gate
and result cache Node had — and persists the same per-event snapshots Node wrote. The AI side of
`forgex-api` is configured like Node's `OPENAI_*` / `AI_*` / `RESULT_CACHE_*`: `Analysis__Provider`
(`auto` | `openai` | `rules`), `OpenAi__BaseUrl` / `OpenAi__ApiKey` / `OpenAi__Model` /
`OpenAi__TimeoutMs` (120000), `Analysis__AiConcurrency` (2), `Analysis__AiQueueMax` (8),
`Analysis__AiDailyPerCaller` (20), `Analysis__AiDailyGlobal` (200, 0 = unlimited),
`Analysis__CacheTtlMs` (1800000), `Analysis__CacheMax` (200). The gate and the cache are in-process
(they reset with the process, like a single Node instance); a caller-supplied endpoint only ever
lives in the request and the in-memory work item. Host tuning: `AnalysisTasks__Concurrency` (2),
`AnalysisTasks__QueueCapacity` (256, a full queue back-pressures instead of answering 503),
`AnalysisTasks__TtlMs` (3600000, Node's `TASK_TTL_MS`), `AnalysisTasks__StaleRunningMs` (60000 — a
running row nobody updated for that long is recovered as failed「服务重启时任务中断」on the owner's
next create, Node's `ready()` semantics without cross-tenant access). The two SSE dialects differ (Node emits
unnamed `data:` frames consumed by `EventSource.onmessage`, C# emits `id/event` named frames), so Node
re-frames the C# stream: progress/message frames are forwarded verbatim (their payload is the very
event object Node persisted), heartbeats pass through, and C#'s closing `done` snapshot is only turned
into a Node-shaped terminal event when the persisted events lack one (e.g. a task recovered as
`failed` after a restart). Prerequisites, enforced at Node start-up: the same
`GCODE_AUTHORITY_URL` + internal secret as every other leg, **and** `PERSISTENCE_PROVIDER=postgres`
with `CSHARP_ANALYSIS_TASKS_PROVIDER=postgres` (`AnalysisTasks__Provider`) on `forgex-api` — C# reads
the very rows Node persists into `forgex.node_analysis_tasks`, so there is no file leg for this switch.
Node persists snapshots asynchronously per task, so right after a task finishes the C# leg may answer
`202 running` once before `200`; clients already poll. Foreign tasks return `404` on the C# leg where
Node answered `403` (same convention as above). Rollback: set the switch back to `node` and restart.

### Stage 8.6d-1: the C# public facade (Node's dialect without Node)

`PublicFacade__Enabled=true` makes `forgex-api` serve Node's public routes itself — `/api/analyze[/…]`
(unnamed `data:` SSE frames), `/api/datasource`, `/api/knowledge[/search]`, `/api/share/*`,
`/api/calibrations/*`, `/healthz` in the shape the frontend probes, Node's `/metrics` series names, the
`/api/auth/infini/me` tombstone — with Node's `{ "error": "…" }` bodies and messages, so the browser
does not notice whether a Node proxy sits in front. Server-layer semantics travel with it:
`PublicFacade__AllowOrigins` (comma list; `OPTIONS` always answers `204`, CORS headers only for listed
origins), `PublicFacade__RateLimitMs` (default 5000, per-IP cooldown on task creation only),
`PublicFacade__TrustProxy=true` (take the client IP from the first `X-Forwarded-For` hop, as
`TRUST_PROXY=1` did), `PublicFacade__PublicBase` (falls back to `Shares__PublicBase`; share links use
it, else the request `Origin`). Direct identity is the Stage 8.2 mapping (`DirectAuth__ApiKeys`,
`DirectAuth__CalibrationReviewKeys`, `DirectAuth__RequireAuth` ≙ `API_KEYS`, `CALIBRATION_REVIEW_KEYS`,
`REQUIRE_AUTH`), which hashes to the same tenant / owner ids Node wrote, so existing rows stay owned.
The facade requires `AnalysisTasks__Provider=postgres` plus the four resource providers; the internal
`/api/v1/*` contract is unchanged. Evidence: the dual-run replays its whole corpus a third time against
the facade directly (`results[].via = csharp-direct`) and `npm run dotnet:public-facade` covers CORS,
404 text, rate limiting, `/healthz`, `/metrics`, `REQUIRE_AUTH` and `TRUST_PROXY`. Until 8.6d-2 the
facade stays off in the shipped Compose file; Node remains the entry point.

Production objectives and alert response are defined in [`SLO.md`](./SLO.md),
[`alerts/forgex.rules.yml`](./alerts/forgex.rules.yml), and [`RUNBOOK.md`](./RUNBOOK.md). Before each
release run `npm run dotnet:capacity`, `npm run dotnet:recovery-drill`, `npm run security:audit`,
`npm run ops:check`, and `npm run rollback:rehearse`, then archive the emitted JSON evidence.
