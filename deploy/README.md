# FORGE·X container deployment

默认部署由 **ForgeX.Api 单进程**承载 React 静态文件、公共 API、SSE、身份、分析和 G-code 作业，对外端口为 `8787`。Node 镜像只保留为 `legacy-node` 回滚入口。

## First start

1. 复制 `deploy/.env.example` 为 `deploy/.env`，填写 `POSTGRES_URL`。公共分析任务目前只支持 PostgreSQL；所有业务资源默认使用同一数据库。G-code 作业仍使用独立的文件卷，暂不支持多副本。
2. 先在受控环境运行 `npm ci`，设置同一 `POSTGRES_URL` 后执行 `npm run postgres:migrate -- --require`，确认六个迁移成功。迁移脚本幂等；部署不会自动改写既有数据库。
3. 生成至少 32 字节的 `GCODE_AUTHORITY_INTERNAL_SECRET`（仅用于观察期 Node 回滚通道）；保留空的 previous secret，除非正在轮换。配置 `API_KEYS`、`REQUIRE_AUTH` 和公开地址 `PUBLIC_BASE`。`TRUST_PROXY` 只在可信反向代理后启用。
4. 固定不可变镜像标签，启动默认 C# 服务：

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --pull forgex-api
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d forgex-api
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8787/react/
```

C# 镜像分前端构建、.NET 发布、最终运行三个阶段，运行层没有 Node 服务。Compose 使用非 root 用户、只读根文件系统、独立 `/app/data` 卷及临时目录，保留能力限制与日志轮换。旧版文件存储不会自动转换为 PostgreSQL；既有 Node file 部署须先制定并验证数据迁移方案。

部署探针 `/healthz` 覆盖业务数据库（含分享）与 G-code 存储、作业仓库和宿主就绪状态。返回 503 `gcode_unavailable` 时检查 `/health/ready`、数据卷权限及作业仓库；`persistence_unavailable` 时检查数据库连接和迁移。开启强制 API Key 后，同步计算与内部规则计算接口也会拒绝匿名请求。

### Render

`render.yaml` 使用 `deploy/Dockerfile.api`，需提供已迁移的 `POSTGRES_URL`、`DirectAuth__ApiKeys` 和 `PublicFacade__PublicBase`。默认关闭外部 AI 配置；有需要时另填 `OpenAi__BaseUrl`、`OpenAi__ApiKey`、`OpenAi__Model`。

现有 Render 服务同步蓝图时，新增的 `sync: false` 变量不会再次弹窗，须先在 Dashboard 手动补齐上述变量，再应用运行时切换。配置字段与行为见 [Render Blueprint 官方规范](https://render.com/docs/blueprint-spec)。

为保留 G-code 作业，蓝图使用 `starter` 与挂载在 `/app/data` 的 1 GB 持久磁盘；这不同于原来的免费 Node 配置，发布前须确认实际平台套餐和费用。这里只更新部署配置，不会创建或发布云端服务。

## Operations and evidence

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs --tail=200 forgex forgex-api
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec forgex-api \
  wget -qO- http://127.0.0.1:8787/health/ready
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec forgex-api \
  wget -qO- http://127.0.0.1:8787/metrics
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

发布后观察 **7 天**，保留两个不可变镜像、PostgreSQL 备份和 `/app/data` 卷；观察窗口从实际部署并验收成功后开始，不能以本地开发日期代替。

```sh
# 构建并在 8786 验证回滚网关；C# 仍在 8787，资源代理使用相同数据库。
docker compose --env-file deploy/.env -f deploy/docker-compose.yml --profile legacy-node build forgex
docker compose --env-file deploy/.env -f deploy/docker-compose.yml --profile legacy-node up -d forgex
curl --fail http://127.0.0.1:8786/healthz
```

Windows 可使用 `deploy/drills/rehearse-version-rollback.ps1 -PreviousNodeImage <TAG> -PreviousApiImage <TAG> -LegacyGateway` 先检查配置；确认标签后追加 `-Apply` 执行。该开关将入口切回 8787 的 Node 网关，C# 对外改为 8788。

如需将公网入口切回 Node，在部署环境设置 `FORGEX_PORT=8788`、`FORGEX_LEGACY_PORT=8787`，然后运行同一 profile 的 `up -d --no-build`，同时更新负载均衡探针。C# 容器内端口仍为 8787，Node 的内部代理地址不变。切回 C# 时恢复原端口并停止 `forgex` 服务。

网关默认将业务资源继续转发至 C#，保证调用身份和 PostgreSQL 数据归属一致。回滚 C# 自身时使用上一份已验证、支持单进程公共门面的镜像，按 [`RUNBOOK.md`](./RUNBOOK.md) 验证数据库兼容性；保留所有卷，禁止通过删卷回滚。若回到更早的 8788 sidecar 镜像，必须同时恢复对应版本的编排文件，不能直接混用当前端口配置。

`npm run dotnet:single-process` 在本地起一个 C# 服务，验证上传、分析、公共 SSE、分享/撤销和重启持久化。需要已构建的 React、Release API 与已迁移的 `POSTGRES_URL`。E2E 默认也直连 C#：

```sh
npm run frontend:build
npm run dotnet:build
npm run dotnet:single-process
npm run test:e2e:chromium
```

需要专门验证旧网关时显式设置 `E2E_SERVER=node`。以下 Stage 8.6a～8.6d-1 内容记录迁移期开关；当前部署默认值以本页和 `.env.example` 为准。

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
