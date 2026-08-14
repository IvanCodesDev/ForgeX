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
available until the configured TTL.

Production objectives and alert response are defined in [`SLO.md`](./SLO.md),
[`alerts/forgex.rules.yml`](./alerts/forgex.rules.yml), and [`RUNBOOK.md`](./RUNBOOK.md). Before each
release run `npm run dotnet:capacity`, `npm run dotnet:recovery-drill`, `npm run security:audit`,
`npm run ops:check`, and `npm run rollback:rehearse`, then archive the emitted JSON evidence.
