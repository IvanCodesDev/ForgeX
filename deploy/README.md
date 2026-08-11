# FORGE·X container deployment

This deployment runs the zero-runtime-dependency Node gateway and the .NET 10 authority as separate
containers. The gateway is the only published service; authority port `8788` stays on the Compose
network.

## First start

1. Copy `deploy/.env.example` to `deploy/.env`.
2. Generate a unique random secret of at least 32 bytes and set
   `GCODE_AUTHORITY_INTERNAL_SECRET`. Never reuse the example text from CI or documentation.
3. Build and start both services:

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

Before an upgrade, create and verify an authority repository backup using the commands in
`backend/README.md`, and separately back up the Node and authority named volumes according to the
container platform. The CI script `deploy/verify-containers.sh` rebuilds the runtime contract by
checking non-root identities, read-only roots, writable data volumes, health, React delivery,
authority metrics, and restart readiness.

## Rollback

1. Keep the current named volumes and the verified authority backup; do not delete or recreate them.
2. Set `GCODE_ASYNC_JOBS_ENABLED=0` if only the asynchronous authority path must be disabled.
3. Restore the previously tagged `forgex-insight` and `forgex-authority` images in the Compose file.
4. Run `docker compose ... up -d`, then verify `/healthz`, `/react/`, and authority `/health/ready`.
5. If the authority is being removed entirely, set the React build to browser authority before
   stopping `forgex-api`; the legacy `/` page remains the product rollback boundary.

The current PostgreSQL files are a frozen migration contract only. This Compose deployment keeps
`Persistence__Provider=file`; selecting `postgresql` remains a fail-fast configuration until the
pinned runtime driver and PostgreSQL integration gate are delivered.
