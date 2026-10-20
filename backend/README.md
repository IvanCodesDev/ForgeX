# FORGE·X .NET 10 authority prototype

This directory is the sidecar authority introduced by the optimization manual. It does not replace the existing Node/JS application yet.

## Runtime contract

- SDK: .NET `10.0.302` (`global.json`)
- Target: `net10.0`
- Production projects: no external `PackageReference` beyond the reviewed pinned allowlist (manual V2.0 §4.2: `Npgsql` 9.0.3 in `ForgeX.Infrastructure` only, tracked in `config/dependency-policy.json`)
- Package sources: reset by `backend/NuGet.Config` to nuget.org only; every new dependency needs review and a pinned version
- Default API binding: loopback only, `http://127.0.0.1:8788`
- Migration modes: G-code defaults to `browser`; Analytics defaults to `dotnet` with `shadow` and `browser` rollback modes

The local SDK is discovered by `tools/run-dotnet.js`. CI may use a system SDK with the exact same version.

## Commands

```text
npm run dotnet:build
npm run dotnet:golden
npm run dotnet:jobs
npm run dotnet:resilience
npm run dotnet:gcode-benchmark
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

启用 `PublicFacade__Enabled=true` 时，同步计算端点（`/api/v1/gcode/analyze`、`/api/v1/analytics/*`、`/api/v1/calibration/*`）沿用 `DirectAuth` 和可信内部通道。配置 `DirectAuth__RequireAuth=true` 后，匿名或错误 key 返回 401；有效内部令牌仍须附带规范租户与所有者上下文。公开校准目录 `/api/v1/calibrations` 保持原访问规则。关闭公共门面时保留原 sidecar 兼容行为。

单进程部署的 `/healthz` 同时检查业务持久化（包含分享）、G-code 文件存储、作业仓库、队列和工作线程启动状态；业务存储失败返回 503 `persistence_unavailable`，G-code 依赖不可用返回 503 `gcode_unavailable`。健康响应保留原能力字段，不包含内部路径或底层异常。ResourceGate 用真实文件目录故障与恢复验证探针。

公共 `/api/*` 的未知路径与不支持方法返回 404 `{error: "接口不存在"}`；内部 `/api/v1/*` 保留 404、405（含 `Allow`）和 415 的 problem+json 契约。API 路径文字按 Kestrel 规则忽略大小写，身份边界采用相同规则；资源 ID 不转换大小写，用户隔离及校准审核权限保持原语义。

The G-code endpoint accepts the raw `application/x-gcode` body. It returns an authoritative summary,
a bounded per-layer plan, and packed display-only extrusion geometry. The React Worker still owns
the immediate preview used by `browser` and `shadow` modes.

## STL / 3MF 原件几何校验

`POST /api/v1/meshes/analyze?format=stl|3mf` 接收 `application/octet-stream` 原始文件字节，使用 API Key / 可信通道边界，返回 OpenAPI 生成的 `MeshAnalysisResult`。上传字节不写入持久化存储；结果包含原始 SHA-256、字节数、尺寸、面数、表面积与拓扑检查。当前网格引擎 `1.2.0`、响应契约 `1.1`，新增的顶点和连通分量字段为必需项；前端拒绝旧 `1.0` 契约，保留预览并提示校验未完成。

- 二进制和 ASCII STL 按毫米解释；3MF 支持核心几何与 Production 分件引用子集。按 `_rels/.rels` 选择根模型；根模型的 build item / component 可通过 Production 命名空间的 `path` 引用包内其他模型。前缀不要求固定为 `p`，但必须声明对应的必需扩展，分件必须有根模型 `.rels` 关系。对象 ID 按模型隔离；只读取实际构建涉及的模型，子模型 build 不执行，非根组件跨文件引用明确拒绝。
- 各模型顶点与本地平移按各自 unit 解释；跨文件先换算到父模型单位，再应用引用变换。返回的 `unit` 是根模型单位，`sizeMm` 始终为毫米。根模型及引用模型的未知必需扩展（含 Alternatives、加密等）拒绝处理。引用环、无效索引、重复几何容器和非有限坐标明确拒绝。本接口不执行完整 XML Schema / UUID 合规认证，也不解释颜色、材料或切片参数。依据 [3MF 核心规范](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md)和 [Production 规范](https://github.com/3MFConsortium/spec_production/blob/master/3MF%20Production%20Extension.md)。
- 文件、ZIP 总声明解压量和所读 XML 累计实际解压量上限 64 MiB，单 XML 16 MiB，ZIP 条目 256，三角面 250000，已读取模型的资源对象总数与组件展开次数分别不超过 4096，嵌套深度 32。部件缓存避免重复解压；解压长度必须与目录一致。禁止 DTD / 外部 XML 实体、包外模型关系、包路径穿越及重复路径，不提取到磁盘、不请求网络。每进程仅同时处理一份网格，繁忙返回 429 和 `Retry-After: 2`，20 秒超时返回 408；超限 413、损坏或不支持内容 422。
- 拓扑基于有效三角面和坐标完全相同的顶点焊接，不执行容差吸附或修复。`nonManifoldVertices` 检查顶点周围的面是否形成单一扇区，边界度数是否为 0/2，以及是否与非流形边相接；`vertexManifold` 为零异常顶点时的结果，允许正常开口边界。`connectedComponents` 按共享无向边连接面，只有一个公共顶点的曲面仍计作两个面连通分量。顶点、面两套并查集避免逐顶点扫描整份网格；实现检查可参考 [CGAL 的组合网格流形定义](https://doc.cgal.org/latest/PMP_Mesh_repair/group__PMP__combinatorial__repair__grp.html)。
- 体积仅是单对象、单面连通分量、边闭合、顶点流形且朝向一致时的有向几何估算；其他情况返回显式 `null`，界面说明原因。即使一个 STL 或 3MF object 内含多个闭合壳体，也不推断其相互分离、相交或内外嵌套关系。未执行自相交、壳体包含、组件重叠或布尔并集，不能视为水密认证或材料实测。表面积仍按三角面累加，可能包含内部面。
- React 的 `VITE_MESH_AUTHORITY=dotnet` 在预览成功后校验原件；大小写扩展名、文件指纹、数值和拓扑状态均做客户端校验。失败保留预览，换模型或退出页面取消旧请求；本地切片继续使用预览几何，数值有差异时会提示核对。默认开发开关为 browser，C# Docker 镜像开启 dotnet；Node 兼容网关未代理此新接口，应使用 browser。file:// / offline 保持零请求。
- 浏览器同样限制 ZIP / XML 解压量、资源与组件展开，并按包关系处理根模型、Production 分件和单位，排除 `printable=false/0` 的构建项。无根 `.rels` 的旧文件仍保留预览兼容回退，C# 校验要求完整包关系。预览最大 1000000 面，超出后端 250000 面门槛时可继续预览，但不会显示校验成功。

`ForgeX.ResourceGate` 覆盖几何解析和真实 HTTP 拒绝路径；前端单测覆盖文件绑定、结构漂移、取消、超时与 ZIP 限制；CI 增加 `E2E_MESH_AUTHORITY=dotnet` 的真实 C# Chromium 专项。

## Stage 5-A G-code Profile authority

Both `POST /api/v1/gcode/analyze` and `POST /api/v1/gcode/analyses` accept optional
`machineProfileId` and `materialProfileId` query values. Identifiers are limited to 1–80 ASCII
letters, digits, `.`, `_`, or `-` and must start with a letter or digit. The authority response binds
those identifiers to the effective bed size, coordinate origin, and filament density in `profile`,
plus a deterministic lowercase SHA-256 fingerprint. Async idempotency includes this fingerprint, so
the same bytes with different Profile inputs are distinct jobs. GoldenDiff verifies determinism,
material sensitivity, invalid-ID rejection, malformed input, cancellation, non-seekable streams, and
UTF-8/CRLF boundaries. The outer response schema
remains `1.0` because the OpenAPI schema is the negotiated source for generated clients.

## Stage 5-B authoritative layer plan

The same synchronous and asynchronous result now includes `layers` with stable zero-based indices,
Z, path count, extrusion/travel/time/filament totals, and per-path-type counts. Analysis rejects a
fixture above 20,000 layers with stable code `GCODE_MAX_LAYERS_EXCEEDED`; the OpenAPI response also
publishes `maxItems: 20000`. The React Worker derives its complete layer summaries before applying
the separate geometry sampling budget, then `shadow`/`dotnet` compare every layer and path-type
count. Sampled Three.js geometry remains a visualization detail and cannot change the comparison.

`tests/golden/stage5-layer-plan-golden.json` is generated from the reviewed browser parser for four
fixture/origin combinations. `ForgeX.GoldenDiff` consumes that exact artifact and compares all
layer fields against C#, in addition to invariant and limit probes. The default validator is
read-only; regenerate only after reviewing an intentional contract change:

```text
node tools/validate-stage5-layer-plan-golden.js
npm run dotnet:golden
npm run gcode:layer-golden:update   # reviewed update only
```

## Stage 5-C authoritative packed toolpath

The `visualization` response carries at most 100,000 extrusion segments. The
`forgex-toolpath-f32le-v1` payload is Base64 over fixed 20-byte little-endian records: four float32
XY endpoint coordinates and one int32 path-type index. Layer descriptors provide contiguous segment
slices plus exact pre-sampling segment counts. When the stream exceeds the budget, the analyzer
raises a deterministic power-of-two sampling stride while retaining each layer's first segment; it
never needs a seekable input or an unbounded point list. The 16 MiB benchmark currently verifies a
sub-4 MiB result, sub-64 MiB private-memory delta, first-read progress, cancellation latency, and
payload/layer-slice consistency.

React validates encoding, counts, slices, Base64 length, finite coordinates, and path-type indices
before `dotnet` mode switches. It decodes only the selected layer into typed arrays for Three.js.
`shadow` deliberately retains browser geometry, and `VITE_GCODE_AUTHORITY=browser` remains the
single-switch rollback.

## Stage 5-D authoritative material cost and preflight risk

Both G-code endpoints now accept bounded material Profile inputs for direct price, nozzle range,
minimum bed temperature, maximum extrusion-move speed, and maximum volumetric flow. These values
join density and machine geometry in `forgex-gcode-profile/2`, so async idempotency separates jobs
whose operational limits or price differ even when their bytes and Profile IDs match. Engine
`1.4.0` returns a `material` estimate whose direct CNY cost is `filamentMassG * priceCnyPerKg /
1000`, plus a `risk` assessment with a bounded score, low/medium/high level, observed metrics, and
stable findings for bounds, temperature, speed, flow, homing, single-layer completeness, and arc
approximation. Energy and machine-time cost are intentionally excluded until auditable power and
rate inputs exist.

The G-code engine contract version is `1.4.0`.
New asynchronous idempotency fingerprints use `forgex-gcode-job/2`. A completed Stage 5-A file-job
record without `layers`, a Stage 5-B record without `visualization`, or a Stage 5-C record without
`material`/`risk`, is reopened as a stable
`degraded / gcode_result_contract_outdated` terminal snapshot rather than an invalid response; its
input and provenance remain stored, and resubmission with a new idempotency key produces a Stage 5-D
result. Missing persisted limits migrate to their current defaults on read.

The API writes JSON console logs with a bounded route template, status, elapsed milliseconds, and
trace ID. `/metrics` emits Prometheus text with bounded method/route/status labels, request duration
histograms, uptime, build identity, and the latest file repository readiness/count. Concrete job IDs
are never used as metric labels. This uses only the ASP.NET shared framework; no telemetry package is
added in this slice.

## Stage 6-A durable job resilience

Every new asynchronous job persists `attemptCount`, `maxAttempts`, `nextAttemptAtUtc`, and
`deadLetteredAtUtc`. Deterministic `GCodeAnalysisException` inputs fail once with their original
stable code. Stream-read, content-store I/O, timeout, and unexpected failures are transient: the
worker writes a `queued / retry-wait` event before scheduling bounded exponential backoff. After the
configured budget, the snapshot becomes `failed / dead-letter / gcode_retry_exhausted`; the previous
retry events retain the last classified error code. A process restart changes a persisted `running`
record to `queued / recovered` and schedules it again, unless its budget was already exhausted.

Defaults and deployment-style environment names are:

```text
GCodeJobs__QueueCapacity=64
GCodeJobs__Retry__MaxAttempts=3
GCodeJobs__Retry__BaseDelayMilliseconds=250
GCodeJobs__Retry__MaxDelayMilliseconds=10000
```

Queue capacity is limited to 1–4096, attempts to 1–10, base delay to 10–60000 ms, and maximum delay
to the base delay through 300000 ms. Invalid configuration fails during startup. `/health/ready`
reports queue depth/capacity; `/metrics` exports `forgex_gcode_job_queue_depth`,
`forgex_gcode_job_queue_capacity`, and cumulative retry, recovery, and dead-letter counters without
job ID labels. The additive OpenAPI snapshot `retry` object lets operations and clients inspect the
durable state without changing outer schema version `1.0`.

## Stage 6-B through 6-D production hardening

Job admission is evaluated atomically with idempotency replay under the repository lock. Defaults
permit four active jobs per owner and sixteen per tenant; exceeding them returns 429 with
`gcode_owner_active_quota_exceeded` or `gcode_tenant_active_quota_exceeded` and `Retry-After: 5`.
Configure `GCodeJobs__Admission__MaxActivePerOwner` and `MaxActivePerTenant` only from measured
capacity, with tenant greater than or equal to owner. `/metrics` now exports bounded status gauges,
quota rejection counters, and a durable job-duration histogram.

`InternalAuth:PreviousSharedSecret` may hold exactly one previous secret during a rotation overlap.
Both values must be at least 32 bytes and different. Start with the authority, switch the gateway,
verify, then clear the previous value. The full procedure and alert response are in
`deploy/RUNBOOK.md`; capacity assumptions and SLOs are in `deploy/capacity-plan.md` and
`deploy/SLO.md`.

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

Stage 4 tail configuration is explicit as well: `CALIBRATION_AUTHORITY_ENABLED` controls the C#
calibration-training proxy, `CALIBRATION_AUTHORITY_TIMEOUT_MS` bounds its upstream wait, and the
request body is hard-capped at 2 MiB. `SERVER_RULES_AUTHORITY=0` is the documented rollback switch
for the Node rules leg; the default keeps the configured C# Analytics authority online.

Async job endpoints are tenant/owner scoped. In production, configure the same secret as Node's
`GCODE_AUTHORITY_INTERNAL_SECRET` through `InternalAuth__SharedSecret`. Node resolves the browser
session or API key first, derives opaque `tn_` / `ow_` identifiers, and sends those values over the
loopback sidecar boundary. Missing or invalid internal authentication is rejected before job storage;
cross-tenant status, SSE, and cancellation requests return the same not-found response. An empty
secret keeps the explicit `tn_local` / `ow_local` development scope for direct local smoke tests.

## Stage 8.6a resource authority (datasources, knowledge, calibration governance)

ForgeX.Api now owns the storage and semantics of the three remaining Node-side resources, behind
internal endpoints that stay out of the public OpenAPI document (the Stage 8.1 shares precedent):

| Resource                     | Endpoints                                                                                                                                                          | Provider key            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Datasources                  | `POST /api/v1/datasources`, `GET /api/v1/datasources/{id}` (incl. `sample`)                                                                                        | `Datasources:Provider`  |
| Knowledge                    | `POST /api/v1/knowledge`, `GET /api/v1/knowledge`, `POST /api/v1/knowledge/search`                                                                                 | `Knowledge:Provider`    |
| Calibration governance       | `GET /api/v1/calibrations`, `GET /api/v1/calibrations/stats`, `GET/POST /api/v1/calibrations/submissions`, `POST /api/v1/calibrations/{id}/revisions/{rev}/review` | `Calibrations:Provider` |
| Shares (8.1, file leg added) | unchanged                                                                                                                                                          | `Shares:Provider`       |

Every provider accepts `disabled` (default: nothing registered), `file` (JSON documents under
`Storage:Root/{datasources,knowledge,shares}` and `Calibrations:StateFile`, which reads and writes
Node's `forgex-calibration-service-state` v1 file so a Node state file can be taken over as-is) or
`postgres` (`{Section}:PostgresUrl`, falling back to `POSTGRES_URL`; the same tables and RLS
policies Node uses, migrations `0002`–`0005`). The connection string may be either the libpq URI Node's
`pg` takes (`postgres://user:pass@host:5432/db?sslmode=require`, normalized by
`PostgresConnectionString`) or Npgsql's `Host=...;Username=...` keyword form, so one `POSTGRES_URL`
serves both runtimes. Limits mirror Node: `Datasources:TtlMs/MaxPerOwner`,
`Knowledge:TtlMs/MaxPerOwner`, `Shares:TtlMs/MaxPerOwner`, `Calibrations:MaxSubmissions`; capacity
eviction removes the oldest records on both legs (decision A5 also fixed the Node PostgreSQL stores,
which used to delete the newest row). A `ResourceSweeper` hosted service expires records every
`Resources:SweepIntervalMs` (default 60000) and `/metrics` publishes Node's gauge names and HELP texts
(`forgex_datasources`, `forgex_knowledge_docs`, `forgex_shares`, `forgex_calibrations_approved`,
`forgex_calibrations_pending`) so dashboards survive the cut-over.

Identity rides the trusted sidecar channel: Node derives `X-ForgeX-Tenant-Id` / `X-ForgeX-Owner-Id`
from the API key or client IP exactly as its own stores do, and for calibration governance adds the
pair `X-ForgeX-Actor-Key-Id` + `X-ForgeX-Actor-Role` (`submitter` | `reviewer`, both or neither) so
the four-eyes rule (a submitter cannot approve its own bundle) is enforced in C#. Governance is
deployment-scoped (`Calibrations:TenantId`, default `tn_local`), matching Node. Cross-tenant reads
return not-found on the C# legs (RLS convention); the Node file leg answered `403` — the single
approved waiver in the dual-run report.

Byte-level parity with the JavaScript implementation is pinned in three Analytics primitives:
`JsJson` (JSON.stringify semantics for digests, incl. lone surrogates and duplicate keys),
`Bm25Retrieval` (per-character `toLowerCase` folding, identical scoring/rounding) and
`DatasetProvenanceSanitizer`. `ForgeX.ResourceGate` (224 checks on the file leg; the postgres leg
runs automatically when `POSTGRES_URL` is set) consumes Node-generated fixtures
(`npm run resources:fixtures[:check]`), and `npm run dotnet:resource-authority` runs a real dual-run:
one ForgeX.Api plus a node-authority and a csharp-authority Node instance replay the same corpus and
every normalized response must match (artifact `backend/artifacts/resource-authority-dualrun.json`).
Since Stage 8.6b the corpus also covers shares end to end (`SHARES_AUTHORITY`): creation, the public
page as a full HTML comparison after entity canonicalization (Node's `escapeHtml` writes `&#39;`,
.NET's `HtmlEncoder` writes `&#x27;` and numeric entities for non-ASCII text), wrong-key and foreign
revocation, revoke / re-revoke / revoked-page semantics. Since Stage 8.6c-1 the postgres leg also
runs the analysis-task switch (`ANALYSIS_TASKS_AUTHORITY=csharp`): the csharp-authority Node
instance creates every task through `POST /api/v1/analysis-tasks` (executed in-process since 8.6c-2b:
the C# analytics engine for the rules leg, the OpenAI-compatible provider with Node's prompt, merge
rules, cost gate and result cache for the AI leg; persisted per event into
`forgex.node_analysis_tasks`) and reads result / poll through `GET /api/v1/analysis-tasks/{id}` and
the progress stream through `/{id}/events` (re-framed by Node into unnamed `data:` frames). The
node-authority instance still creates in Node with the JS engine and Node's own provider / gate /
cache, both talking to one fake OpenAI endpoint, so the comparison proves the C#-created report
(merged narrative, token usage, degrade section), event sequence, quota verdicts and snapshot equal
Node's (numbers within a 1e-9 relative tolerance — JS and .NET `exp`/`pow` differ in the last digits
of p-values). On the file leg C# has no analysis-task provider and both instances stay on Node
(recorded in the artifact's `authority.analysisTasks`). The ResourceGate section
`analysis-tasks-postgres` covers the C# side alone: validation messages, execution to `done`, the JS
report shape, event replay, foreign-tenant 404s, stale-running recovery, the BYO endpoint (bearer
header, prompt, key never persisted), cache hits and quota degradation. Since Stage 8.6d-1 the postgres
leg also starts a second ForgeX.Api with `PublicFacade__Enabled=true` and replays the corpus a third
time **directly against the C# public facade** (`results[].via = csharp-direct`): Node's public routes,
`{error}` bodies, unnamed SSE frames and 202 shapes served by C# alone must equal Node's;
`npm run dotnet:public-facade` (`tools/verify-public-facade.js`) adds the server-layer contract the
corpus cannot express — CORS / OPTIONS, `/api/*` 404 text, per-IP rate limiting, `/healthz`,
`/metrics`, `REQUIRE_AUTH`, `TRUST_PROXY`. The fake-sidecar contract tests live in
`tests/resource-authority.test.js`, `tests/shares-authority.test.js` and
`tests/analysis-tasks-authority.test.js`.
CI provides a PostgreSQL service and applies the migrations with `npm run postgres:migrate -- --require`
so both legs are covered on every push.

Node-side switches (default `node`, zero change): `DATASOURCES_AUTHORITY`, `KNOWLEDGE_AUTHORITY`,
`CALIBRATION_GOVERNANCE_AUTHORITY` (`csharp` requires `GCODE_AUTHORITY_URL` and
`GCODE_AUTHORITY_INTERNAL_SECRET`; `RESOURCE_AUTHORITY_TIMEOUT_MS` bounds the upstream wait). In
`csharp` mode Node's own `/metrics` resource gauges read `0` — use the C# `/metrics`.

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

## Stage 8.6d-3 前置：Node 服务契约的 C# 替身

本轮增加 `npm run dotnet:server-contract`：真实启动 ForgeX.Api，直接验证公共 HTTP 契约，不导入 `server/` 或经典脚本。需要 Release API、React 构建产物以及完成六个迁移的隔离测试 `POSTGRES_URL`。缺少数据库时明确失败；测试使用规则引擎，无外部 AI 计费。

`tests/server.test.js` 的分段对应关系如下，供后续删除逐项核销；这是验收准备，暂不删除 Node 测试：

1. 健康与引擎模式 → 公共契约第 1 组。
2. 静态路径与 React 映射（含 2b）→ 公共契约第 2 组及 `ForgeX.StaticGate` 的临时静态根、缺失回退、原始路径和缓存测试。
3. 上传与来源标记 → 公共契约第 3 组，包含 413 与非法 JSON。
4. 分析/SSE/轮询 → 公共契约第 4 组。
5. 上传数据分析 → 公共契约第 5 组。
6. 参数校验 → 公共契约第 6 组。
7. 知识登记 → 公共契约第 7 组。
8. 分享页面 → 公共契约第 8 组。
9. 限流 → 公共契约第 9 组。
10. Provider 选择 → `ServerProviderSection` 的 `server-10-*`。
11. AI 叙述与权威数字合并 → `server-11-*`，保留图表、证据、来源与统计小节。
12. 简报与数据规模解耦 → `server-12-*`。
13. 缓存 → `server-13-*`，含租户 scope、数据源、provider 隔离和 LRU/TTL。
14. 检索 → `server-14-*`；逐字节语义继续由 ResourceGate 的 Node 生成夹具把关。
15. 检索能力标记 → 公共契约第 15 组。
16. 持久化 → 公共契约第 16 组，测试真实进程重启与 PostgreSQL；原 Node 的纯内存模式不作为 C# 公共部署模式保留。
17. 文件存储原语 → ResourceGate 的 `FileCollectionSection`（原子写、TTL、容量、损坏文件等）；Node 的既有 file 数据不会自动迁入 PostgreSQL，部署前仍需另行验证迁移。
18. 成本闸门 → `server-18-*` 的个人/全局日限额、UTC 日期、并发、排队和释放；AI 耗尽端到端降级及缓存不扣费由 `AnalysisTasksSection` 验证。**既定差异：C# 额度与缓存为进程内状态，`persisted=false`；旧 Node 的 usage.json 跨重启保留并未迁移，不宣称等价。**
19. 身份与隔离 → 公共契约第 19 组及 `ForgeX.AuthGate` 的授权矩阵。
20. 额度/规则引擎行为 → 公共契约第 20 组（本机假 AI 验证公共端点、缓存不扣额、额度耗尽降级与密钥不落快照）及 ResourceGate 的 `analysis-ai-quota-degraded`。
21. 指标 → 公共契约第 21 组。
22. 分享披露与撤销 → 公共契约第 22 组。
23. G-code → 公共契约第 23 组验证直接权威端点和作业身份边界，异步持久化由单进程部署演练/JobGate 补齐。Node 的流式代理实现测试在代理删除后才退役，不能用直连接口通过来宣称这些代理分支已逐条迁移。
24. 单进程路由错误 → 公共契约第 24 组验证内部 405/415、`Allow`、公共中文 404，以及 GET/POST/DELETE/HEAD 和大小写路径。

公共 HTTP 契约现为 196 项；ResourceGate 为 569 项（file + postgres 双腿，包含 provider 等内部契约 59 项、部署健康故障验证 16 项和网格解析/HTTP 验证 127 项）。CI 分别保存 `csharp-server-contract.json` 与 `resource-authority-gate.json`。测试数量不能替代删除审批、真实容器验收和生产观察；现阶段仍保留 Node、经典前端及原测试链。
