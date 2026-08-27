# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

`0.x` 为演进期；`1.0.0` 固化 README 所声明的可交付产品边界，后续多租户工业平台能力作为 2.0 路线演进。

---

## [Unreleased]

### Stage 10.1：TypeScript 编译约束补齐（工程强化）
- `tsconfig.app.json` 启用 `useUnknownInCatchVariables` 与 `verbatimModuleSyntax`（V1 §5.2
  推荐项落地）：探针实验确认开关真实生效（TS1484），现有代码零改动通过——TS 迁移期
  已统一 `import type` 风格；
- 新增 `frontend/src/engine/engine-invariants.test.ts`：slicer 纯几何、内置模型轮廓、
  G-code 解析器声明字段的关键数值锁定为断言，防后续迁移/重构静默漂移（Stage 10.4
  引擎单测扩面起步）。前端 vitest 61/61、typecheck 零错误。

### Stage 8.3：Node 规则计算腿迁 C#（规则引擎权威边界）
- ForgeX.Analytics 吃下 Node/classic 的最后一条规则计算腿：`RawDatasetCsv`（经典
  `parseCsv`/`toCsv` 逐字节移植）、`DatasetCatalog`（字段与 provenance 目录）、
  `FarmDataset`（内置机群数据集改嵌入资源 `Resources/farm-dataset.csv`，sha256 与
  经典运行时一致）、`AnalyticsBriefEngine`（`brief.js` 统计简报）、
  `CalibrationBundleValidator`（`validateBundle`，依托 `JsValue`/`JsDate` 复刻 JS
  值强转与日期文法语义）。ForgeX.Api 新增五个内部端点：数据集 normalize / meta /
  farm、统计简报、校准包验证（沿用 Stage 8.1 先例，内部端点不进公开 OpenAPI 文档）。
- 双跑揪出并修复两处 .NET/JS 静默语义差异：`JsFormat` 负数平局舍入（对齐 JS
  `Math.round` 向正无穷取整），以及严格数字正则 —— .NET 的 `\d` 匹配 Unicode 数字，
  全角数字会越过文法检查落进「超出有限数值范围」的错误分支，显式改 ASCII `[0-9]`
  并暴露 `IsStrictNumber` 供原始 CSV 解析器复用同一判定。
- Node 侧新增迁移期双向开关 `RULES_ENGINE_AUTHORITY=node|csharp`（默认 node，
  行为零变化；csharp 需 `GCODE_AUTHORITY_URL`，与 G-code 权威共用同一 sidecar）与
  `RULES_ENGINE_TIMEOUT_MS`（默认 30000）。新增 `server/services/rules-engine.js`
  统一异步规则引擎边界（normalizeCsv / farm / meta / buildBrief / validateBundle /
  analyze），datasource / calibration / providers / analysis 及两个 postgres 存储
  全部改为消费该边界，classic 的 require 收敛为 node 模式下的惰性加载 ——
  切到 C# sidecar 不再需要触碰任何消费方。
- 验证三层：AnalyticsGate 新增规则腿金样断言（期望值取自 Node 实测）至 1062 项；
  `tests/rules-authority.test.js` 以假 sidecar 做 57 项断言（csharp 直连、消费链路
  端到端、默认 node 零 HTTP 请求、6 类错误路径、配置校验）；
  `tools/verify-rules-authority.js` 双跑门禁拉起真实 sidecar 对照 classic 权威，
  292/292 全绿（25 组 CSV、11 组简报、29 组校准包、farm 全量 400 行；7 条零行
  CSV 语料的既定差异记录于报告 waivers），报告随 CI `dotnet-authority` job 上传
  artifact，`npm run dotnet:rules-authority` 入册。

### Stage 7.1 / 8.1 / 8.2 补记（同一未发布批次中已提交的工作）
- **Stage 8.1**：分享权威迁 C# —— ForgeX.Api 新增分享创建/撤销与公共只读页，
  `PostgresShareRepository` 为首个 C# PostgreSQL 访问层，复用 forgex.shares 表与
  RLS 契约（令牌形态、撤销哈希、TTL、过期即删、访问计数与 Node 版逐字节对齐），
  Node 侧 `SHARES_AUTHORITY=csharp` 把分享路由切为迁移代理；Node 分析任务历史与
  SSE 亦由 C# 提供（`AnalysisTasks:Provider=postgres` 下三个只读端点，复用 G-code
  jobs 的 SSE 线格式，计算腿留待 Stage 8.3）。
- **Stage 8.2**：C# `CallerContext` 支持直连身份解析 —— API Key（Authorization
  Bearer / X-API-Key）与匿名 ip 身份由 `DirectAuth:*` 配置启用，租户/所有者 id
  派生与 `server/lib/auth.js`、`identity.js` 逐字节一致（常数时间比对），未配置时
  信任边界行为不变，流量迁离 Node 后租户数据无缝保留。
- **Stage 7.1**：React 工作台接管根路径 `/`（存在构建产物时），经典入口降级
  `/legacy` 保留一个发布周期；纯净检出无构建产物时根路径回退经典页，保住
  clone-and-run 承诺与免构建 CI 冒烟，E2E（boot、react-parity）与服务端 212 项
  测试同步迁移后通过。

### 修复（React 引擎机型状态回归）
- 修复前端引擎 TS 迁移引入的 ES2022 类字段回归：四个机型子类的字段声明会在基类构造期
  `_buildMachine()` 赋值之后重新 define，把 `zCarriage` / `zGantry` / `beam` / `_arms` /
  `BED_Y` / `TIP_DZ` 抹回 `undefined/0`，表现为 FX-220 轻锋、FX-500 巨匠切换即崩，
  FX-Δ260 迅影并联臂断线，FX-256 睿造开始打印后移动喷头即崩。子类字段改为 `declare`
  纯类型声明（零运行时发射，保留构造期赋值），几何数值一行未动。
- 新增 `frontend/src/engine/printers.test.ts`：四机型构造后虚拟 Z / 喷头运动 / 每帧更新
  可用性与 `BED_Y`、`TIP_DZ`、并联臂逆解的七条回归断言（暂存修复时全部红、恢复后全绿）；
  Playwright 实测四机型切换与开始打印零页面错误。

---

## [1.0.0] — 2026-08-14

### Release boundary
- 1.0 includes the offline `file://` experience, Docker one-command deployment, deterministic FDM simulation and process exploration, C# G-code and Analytics authority with browser/shadow rollback modes, calibration governance, optional PostgreSQL persistence, sharing, task recovery, SLO/runbook evidence, and the release/CI gates documented in the README.
- 1.0 does not directly control printers. Real STL/3MF mesh import, multi-tenant industrial-platform features, multi-replica coordination, and energy or machine-time costing without auditable power/rate inputs remain 2.0 or later work. The classic entrypoint remains a documented rollback baseline.

### Stage 3 data source persistence slice
- Added PostgreSQL v3 datasource storage with tenant/owner RLS, normalized CSV content hashes, deduplication, TTL expiry, and fail-closed readiness checks. The Node gateway keeps the existing file provider as the default and only enables the PostgreSQL datasource path when `PERSISTENCE_PROVIDER=postgres` is selected.

### Stage 3 knowledge persistence slice
- Added PostgreSQL v4 knowledge document storage with tenant/owner RLS, TTL expiry, per-owner capacity eviction, and readiness loading before search or AI analysis. The file provider remains the default fallback.

### Stage 3 share persistence slice
- Added PostgreSQL v5 share snapshots with public-token reads, owner-only revoke, expiry cleanup, and access-audit counters. The file provider remains the default fallback.

### Stage 3 analysis task persistence slice
- Added PostgreSQL v6 Node analysis task history with tenant/owner RLS, event/report snapshots, TTL cleanup, and explicit recovery of in-flight tasks after restart. The file provider remains the default fallback.

### Stage 4 authority tail closure
- Completed the Node rules-authority and C# calibration-training configuration contract. Calibration proxy enablement, timeout, and the hard 2 MiB request budget are now defined in `getConfig`; both authority boundary tests are part of the main test chain, and `SERVER_RULES_AUTHORITY=0` is an explicit Node-rules rollback switch.

### 阶段 3：共享持久化首片
- 新增可选 `PERSISTENCE_PROVIDER=postgres`：Node 校准治理提交、四眼审核、发布目录和审计事件使用 PostgreSQL v2 迁移、事务与 RLS；未配置时继续使用 file 存储。
- 新增 `pg` 固定版本运行时依赖、连接池/事务封装、健康检查持久化状态和 PostgreSQL v2 迁移门禁。数据源、知识库、分享和 Node 分析任务仍待后续迁移。

### 变更（引擎 TS 迁移）

- 引擎层持续从 `js/` 经典脚本迁移到 `frontend/src/engine/*.ts`，React 工作台改为直接消费
  TS 模块，未迁脚本经 `globals-bridge` 读取同一实现；每个模块迁移均通过与 JS 原版的
  逐位数值对比（切片全量输出、G-code 解析、STL 二进制、分析报告等 130+ 项断言）。
  - 第二批：`slicer` / `models` / `gcode-parser` / `machine-log` / `time-calibration` /
    `calibration-registry`。
  - 第三批：`exporter` / `api-client` / `insight-data` / `farm-dataset` / `insight-engine`；
    `auth.js` 收编为 React `useAuth` hook（登录门与账号胶囊改受控渲染，顺带修复
    logout 按钮在 React 入口下未绑定监听的时序问题）。
  - 第四批：`orbit` / `fleet-view` / `scene` / `printer3d` / `printers` / `sim` /
    `profile-registry`；THREE 改由 npm 包（`three@0.152.2`，与原 vendor r152 同版）引入，
    React 入口不再预载 `three.min.js` 经典脚本。
  - 收尾批：`ui.js` 收编完成——其在 React 入口仍存活的引擎联动职责（toast/confirm 事件化、
    renderCtx 页级刷新、state→ghost 联动、成品导出、内置模型目录）迁入类型化的
    `WorkbenchUi`（`frontend/src/workbench/workbench-ui.ts`），品牌 SVG 与全屏按钮改由
    React 组件渲染；`models` / `insight-data` / `profile-registry` 的过渡期全局读取
    （`THREE` / `FXFarmDataset` / `FXInsightData`）全部换成直接 import；`globals-bridge`
    随最后一个消费者消失而删除。React 入口自此零经典脚本、零 `FX*` 全局
    （仅保留 `window.FX` 调试句柄），`legacy/engine.ts` 成为纯类型收窄与服务聚合边界。
    两入口一致性由 `react-parity`（布局契约 + 整屏像素）与 `workbench-authority`
    （C# 权威接线）E2E 复验通过。
- 旧入口（`index.html` + `js/`）保持原样，作为迁移期的像素/布局对照基线与回滚路径。

### 仓库整理

- 经典入口的 `css/` 与 `js/` 收进 `frontend/classic/`，根目录不再裸露旧版前端资产。
  `js/` 的身份不只是浏览器脚本——Node 服务端（`local-engine` / `calibration`）在运行时
  require 它跑服务端引擎，约 30 个 Node 测试与 tools 校验器直接加载它，两份金样本还把
  它的路径记进指纹。搬迁同步更新：根 `index.html` 的 27 处资产引用（file:// 直开语义不变）、
  服务端静态白名单、Vite 的 legacy-assets 源路径（顺带修正了构建阶段缺 `css/` 拷贝的
  Dockerfile 隐患）、eslint/prettier/gitattributes 的分层规则、CI 工作流的内联 require，
  以及 stage0 金样本的 `engineSourceSha256`（该指纹把源文件路径卷入哈希，重生成后
  24 个用例逐字节一致，仅指纹一个字段变化，证明引擎输出零漂移）。`npm run check` 45/0，
  E2E 12 条全过（含旧入口 file:// 直开与两入口像素级一致）。
- 五个数据契约目录（`calibration` / `datasets` / `logs` / `profiles` / `validation`）收敛到
  `contracts/` 之下。它们本就是同一类东西——对外承诺的 schema、示例载荷与验证基线，此前平铺在
  根目录，把仓库首屏挤成了一份目录清单。搬迁牵动 44 个文件：schema `$id` 与互相之间的
  `$schema` 引用、服务端静态白名单（`server/lib/http.js`）、前端两个入口的下载链接、
  Dockerfile 与 `.dockerignore`、`tools/` 下的校验器，以及三份金样本里内容寻址的路径字段；
  `contracts/calibration/example-bundle.json` 的 `trainingSetSha256` 因指向的 fixture manifest
  换了路径而重新绑定。`npm run check`（45 项发布门禁）与 `react-parity` / `boot` E2E 全绿。
- Changelog 迁回仓库根目录 `CHANGELOG.md`（原 `.github/CHANGELOG.md`），同时退役需要并行
  维护的英文摘要副本；README、英文 README、PR 模板与 `tools/release-audit.js` 的引用同步更新。
- `optimization/` 阶段证据归档撤出版本控制。这批文件在 `.gitignore` 收录该目录之前就已被跟踪，
  内含构建日志、基线压缩包，以及带有绝对工作区路径的验证记录，不属于公开源码仓库的内容；
  文件保留在本地作为回滚参考。

### 新增

- G-code 同步/异步权威响应新增机型与材料 Profile 标识、生效参数和确定性 SHA-256 指纹；
  React 在接纳 C# 结果前校验 Profile 与提交参数一致。
- GoldenDiff 增加 Profile 指纹确定性、材料敏感性和非法 ID 稳定错误码探针。
- G-code 同步/异步响应新增完整逐层计划；React 在几何采样前生成逐层摘要，并在
  `shadow` / `dotnet` 模式核验 Z、路径数、挤出、空驶、时间、耗材与路径类型计数。
- 新增 Stage 5-B 浏览器层计划金样本；C# GoldenDiff 复用同一基线执行 392 个字段检查，
  并覆盖逐层聚合不变量与 20,000 层稳定上限错误码。
- G-code 权威响应新增 `forgex-toolpath-f32le-v1` 有界二进制可视化：每段以 20 字节
  little-endian 记录传输，按层提供连续切片，并在 100,000 段硬预算内流式均匀抽样。
- React `dotnet` 模式会在切换摘要前校验完整工具路径载荷，并把选中层直接解码为
  Three.js BufferGeometry；`browser` 与 `shadow` 继续使用原 Worker 预览作为回滚路径。
- 智造洞察接入 C# Analytics 权威（阶段 4 收尾）：`VITE_ANALYTICS_AUTHORITY` 此前只有
  类型声明与示例文档，本次补齐实现——`browser` 零请求维持本地 TS 规则引擎；`shadow`
  同一份数据后台送 `/api/v1/analytics/reports` 并按 stage4 金样本容差（abs/rel 1e-9）
  逐字段对照，差异只进控制台不改展示；`dotnet` 下 C# 结果经完整结构校验与行数回声核对后
  原子成为展示报告（引擎标识「C# 权威统计引擎（无 AI）」），失败或数据集超出契约
  （>5000 行、非法 status、问题超 500 字）自动回退本地并在报告中明示。调度上真 AI
  管线保持最高优先——权威接管的是规则计算腿（本地与 Node 规则），不是叙述能力。
  新增 `frontend/src/authority/analytics-authority.ts` 与 17 项 vitest（模式解析、
  行清洗、响应收窄、问题+json 错误映射、双跑容差、报告映射）。

### 变更

- 异步 G-code 幂等指纹现在绑定完整 Profile 摘要，避免相同文件在不同机型或材料下误复用作业。
- G-code 引擎契约版本提升到 `1.3.0`；权威层计划与有界工具路径均由 C# 生成，
  Three.js 仍只负责 GPU 显示，不参与权威计算。
- 异步幂等指纹提升为 `forgex-gcode-job/2`；旧的无逐层结果会以稳定降级终态读取，
  已存输入与责任链不丢失；缺少 Stage 5-C 可视化的旧结果同样按该路径降级。

### 修复（CI 长期红灯清账）

主分支 CI 自 7 月底起持续存在三个失败作业，本轮逐一定位修复：

- **离线单文件演示包**：React 入口手写的设计系统样式链接不带 `crossorigin`，
  打包器只内联 Vite 生成的链接，收尾校验因残留外链而拒绝；且 `style.css` 经
  `@import` 引 `tokens.css`，内联进单 HTML 后相对导入会悬空。打包器现在对
  `crossorigin` 可选匹配，并递归展开 CSS `@import`（仍受 dist 越界防护约束）。
- **容器契约（`ready 400`）**：C# 权威服务 `AllowedHosts` 只放行
  `localhost;127.0.0.1`，网关容器经 compose 服务别名 `forgex-api` 访问时被
  主机过滤中间件拒为 400——生产 compose 部署同样受影响。别名现已通过环境变量
  进入白名单（compose 与容器契约脚本同步），保持严格默认不放宽为 `*`。
- **E2E 超时**：免费 runner 只有 2 核且走 SwiftShader 软渲染，重 3D 用例
  实测贴着 60s 上限（本地独跑 17s 的用例在批跑中即超时）。分两层处理：
  CI 环境下用例与断言超时预算翻倍（120s/20s，本地不变）；两条实测超过
  2 分钟的最重用例（五流程页遍历、演示套件整条导入链）按实情标注
  `test.slow()`（预算 ×3）。Firefox 侧问题更深：无 GPU 的 Linux runner 上
  headless Firefox 拿不到 WebGL context（软件 WebGL prefs 亦无效，本机
  Windows 无此问题），应用落入 fallback 导致启动等待必超时——CI 改由
  `xvfb-run` 包裹 E2E、Firefox 项目在 CI 走有头模式取 Mesa 软渲染 GL
  （Playwright 官方推荐路径）；用例内部写死的 30s 启动等待在 CI 放宽到
  90s，且超时时转储启动诊断（兼容守卫结论、WebGL1/2 可用性、fallback
  文案），失败不再只能靠猜。

### 计划中

- 新模块 ESM 化与 i18n 抽取

---

## [0.19.0] — 2026-07-28

**工艺参数因果化。** 参数面板中的每个选项都必须改变路径、运行状态、导出结果、
物理风险或视觉呈现，并由自动化测试证明差异。

### 新增

- **三种真实填充路径**：直线使用 0°/90° 交错扫描，斜线网格使用 45°/135°，
  蜂窝生成共享边去重并按零件轮廓裁剪的六边形网格。
- **回抽运行状态**：打印过程按“回抽 → 空驶 → 回填 → 挤出”执行，回抽距离进入估时、
  当前动作、跨路径渗料风险和成品质量遥测。
- **参数因果门禁**：新增层高、周界、实心层、密度、图案、速度、空驶、回抽和支撑间距
  的差异断言，并增加浏览器端图案切换回归。

### 修复

- 图片浮雕与剪影模型现在响应周界圈数，不再固定为单轮廓。
- 待机时修改打印速度、空驶速度和回抽距离会立即重算切片估时。
- 材料切换触发速度上限时同步重算路径速度；外观颜色明确标注为仅改变显示。
- 提高参数分区标题对比度，避免半透明面板上文字不清。

---

## [0.18.0] — 2026-07-28

**P8「审核发布」阶段。** 把 P7 的单浏览器校准注册表扩展为服务端候选提交、双人审核、
原子发布、审计记录和浏览器只读同步。

### 新增

- **服务端校准仓库**：候选 bundle、当前 active 发布版本和完整审计事件统一写入
  `data/calibrations.json`，一次审批通过以单文件临时写入 + rename 原子落盘。
- **审核 API**：公开 `GET /api/calibrations` 只返回已批准 active bundle；候选提交、
  审核队列和 approve/reject 写接口始终要求有效 API Key。
- **四眼原则**：提交者不能批准自己提交的 bundle；审核原因、匿名 key 摘要、时间、
  内容 SHA-256 和状态变化进入审计记录。
- **发布门槛复核**：客户端只能提交 `candidate`；批准时服务端重新提升为 `active` 并复算
  真实来源、至少五个 holdout、MAPE 与偏差阈值，不能靠请求字段绕过 P7 准入。
- **浏览器同步**：服务模式启动后拉取已审核目录并导入本地注册表；`file://`、服务离线、
  本地版本更高或单包冲突时保留本地能力，不阻塞仿真器。
- **运营可见性**：`/healthz` 与 `/metrics` 增加已发布、待审核校准包计数和写接口状态。
- 新增 26 项服务端审批断言和 1 个 Chromium 提交 → 审核 → 浏览器同步场景。

### 变更

- 跨域部署允许 `Authorization` 与 `X-API-Key` 请求头。
- 核心/服务断言增至 622 项，Playwright 浏览器场景增至 26 个。
- 版本提升到 `0.18.0`，浏览器资产缓存键统一为 `v18`。

---

## [0.17.0] — 2026-07-28

**P7「校准运营」阶段。** 把 P6 的一次性校准报告升级为可导入、可准入、可精确匹配、
可持续监测的版本化模型生命周期。

### 新增

- **校准 bundle 契约**：`calibration/` 提供声明式 JSON schema、运行时严格白名单、
  示例和生命周期说明；bundle 保留 revision、来源、训练集 SHA-256、作用域、系数、
  holdout 指标与阈值。
- **准入与匹配**：只有 `real-anonymized` / `real-consented` 来源、至少五个 holdout 且
  误差通过阈值的 `active` 模型会自动生效；按机型、固件和材料精确匹配。
- **浏览器运营链路**：校准包可从 UI 导入并在本地持久化；同 bundle 只接受更高 revision，
  同任务观测自动去重。
- **漂移监测**：后续配对任务按中位绝对相对误差、中位偏差和 P90 误差形成
  `insufficient`、`stable`、`warning` 或 `drift`；漂移模型停止后续自动匹配。
- **校准结果展示**：真机日志对比同时显示命中的模型 revision、校准估算、holdout
  不确定区间与当前漂移状态。
- **自动化门禁**：新增 23 项注册表断言、16 项校准运营检查和 1 个 Chromium
  持久化/匹配浏览器场景，发布审计同步检查 bundle、加载顺序与测试接线。

### 变更

- 合成 P6 模型只能以 `demonstration-only` 导入，默认永不参与用户任务匹配。
- 核心/服务断言增至 596 项，Playwright 浏览器场景增至 25 个。
- 版本提升到 `0.17.0`，浏览器资产缓存键统一为 `v17`。

---

## [0.16.0] — 2026-07-27

**P6「真实验证」阶段。** 把 P5 的单任务对比升级为可审计的配对夹具、稳健时间校准、
跨浏览器回归和一键发布门禁。

### 新增

- **时间校准核**：`js/time-calibration.js` 使用 Theil–Sen 中位斜率，从至少三个不同时长的
  G-code/真机日志配对任务拟合固定开销与运动倍率，输出训练、留一交叉验证和 holdout 指标。
- **方言夹具契约**：`validation/` 为 Cura/Marlin、PrusaSlicer/Marlin、
  OrcaSlicer/Klipper、SuperSlicer/RepRapFirmware 建立 G-code、日志、SHA-256、来源、
  预期路径和训练/留出角色的一体化 manifest。
- **真实性边界**：内置夹具固定标记为 `synthetic-conformance`，只验证兼容性和校准管线，
  不冒充生产机台精度；真实夹具贡献需要采集、匿名化、许可和同任务哈希责任链。
- **跨浏览器关键链路**：Chromium 继续跑全量场景，Firefox 与 WebKit 增加启动、
  WebGL、G-code 导入、真机日志和校准观测回归。
- **发布门禁**：`npm run release:check` 串联 lint、格式、572 项核心/服务断言、
  17 项生态检查、61 项夹具检查、13 项发布一致性检查和 24 个浏览器场景。

### 变更

- 真机日志 v1 可携带 `jobId`、`machineId`、`firmware`、`slicer` 与 `gcodeSha256`，
  UI 展示设备/固件和单任务原始时差倍率，并明确单任务不能拟合完整校准模型。
- G-code 解析器读取 Cura `;FLAVOR:` 固件声明；校准报告和 manifest 可由服务端安全白名单访问。
- 版本提升到 `0.16.0`，浏览器资产缓存键统一为 `v16`。

---

## [0.15.0] — 2026-07-27

**P5「生态」阶段。** 把自产模型工作流扩展为可导入、可复盘、可验证来源的开放工作流。

### 新增

- **真实 G-code 导入与回放**：解析 Cura / PrusaSlicer 常见注释、绝对/相对坐标与 E 模式，
  保留每条路径的真实挤出增量，在 2D/3D 中逐层预览并复用仿真状态机回放。
- **三层对账**：切片器自报时间/耗材、本地 G-code 重算、真机 JSON/CSV 任务日志并列展示；
  明确区分匀速估算与机台实测，不把差异直接解释成任一侧错误。
- **机型与材料 Profile bundle**：声明式 JSON、schema、运行时白名单和范围校验；
  社区配置只能复用已实现运动学，不能执行代码或覆盖内置 ID。
- 社区材料参考价格可带来源进入成本分析口径，不再只停留在展示字段。
- **数据集 manifest**：来源类型、许可证、隐私声明、复现命令、SHA-256、表头与行数契约；
  `tools/validate-ecosystem.js` 在主测试链中核验仓库内容。
- Profile、真机日志和数据集的示例、schema、贡献说明。
- P5 浏览器场景：G-code → 对账 → 3D 路径 → 真机日志，以及社区 Profile 即时进入 UI。

### 变更

- 平台尺寸、G-code 坐标偏移、调平探测与 HUD 坐标改为读取当前 machine profile；
  Delta 可使用中心原点，其他机型默认床角原点。
- 主测试链纳入 G-code、真机日志、Profile 与生态完整性校验。
- E2E 场景由 16 增至 18。

### 安全边界

- G-code 回放不模拟固件宏、压力提前、输入整形或真实加速度；圆弧当前按端点直线近似并告警。
- 社区机型的 3D 外观复用对应运动学基座，不宣称是目标设备的精确 CAD。
- 数据 manifest 能证明文件与声明一致，不能单独证明贡献内容来自真实产线。

---

## [0.14.0] — 2026-07-26

**补上仓库最大的测试盲区。** `js/ui.js`（1000+ 行）与 `js/insight.js`（700+ 行）
此前零覆盖：纯逻辑有 460+ 项断言护着，而用户实际点到的那一层一行没测。

### 新增

- **E2E 测试（Playwright，16 项）**，覆盖纯逻辑测试永远抓不到的三类问题：
  - **「打不开」**：启动无控制台报错、WebGL 兜底页未出现、3D 与仿真器就绪；
    `file://` 直开单独测一遍——那是本项目的零依赖承诺，坏了等于核心卖点没了。
  - **「点了没反应」**：五个流程面板都能展开且有内容、切换机型会重新调平并更新机台编号、
    材料切换联动温度与风扇、打印中几何参数被锁定。
  - **「界面说了假话」**（重构最该守住的地方）：合成数据标记在数据接入区与报告里都在、
    规则引擎不冒充 AI、结论带置信区间与 p 值、证据链默认折叠但可展开、
    图表真的画出了误差线（取像素校验，不是只看元素存在）、
    不显著时措辞收住且可信度降 low、样本全不足时拒绝排名、
    听不懂时明说、KPI 不再写死「近三周」、机群视图可进可退、
    进度来自后端真实事件而非固定动画。
- `tests/e2e/serve.js`：E2E 专用服务器（规则引擎 + 临时数据目录），
  不依赖任何外部密钥，也不污染仓库。
- CI 新增 `e2e` job，失败时上传 trace 与截图。
- `npm run test:e2e`。

### 修复

- **合成数据的来源标记穿不过后端**（由 E2E 抓到）。
  前端把「机群仿真」数据上传给后端分析，`DatasourceStore.create()` 一律标成
  `user-upload`（`synthetic: false`）——于是**合成数据经过后端一趟就变成了「真实数据」**，
  报告里的合成标记随之消失。这正是 provenance 契约要防的头号问题。
  修法：上传时携带来源，后端做白名单校验。方向是单向的——
  客户端只能让标记**更谨慎**（声明 synthetic 一律采信），不能更宽松
  （声明「这是真实产线数据」不采信，后端无从验证）。已补后端契约断言。

全套 464 → 468 项单元断言 + 16 项 E2E。

---

## [0.13.0] — 2026-07-26

**P4「生产化」阶段。** 主题：把 SECURITY.md 里那条「已知边界」变成防护。

### 新增

- **`server/lib/store.js` 文件持久化层**：数据源 / 知识文档 / 分享页落盘。
  原子写（临时文件 + rename），TTL 与容量淘汰语义与内存版一致，
  单条记录损坏不影响其余加载。`DATA_DIR=` 留空可显式退回纯内存。
- **`server/lib/quota.js` 成本闸门**（公网部署的生死线）：
  AI 并发上限 / 排队上限 / 单调用方日额度 / 全实例日额度四道闸，
  用量跨重启保留（否则重启就等于重置额度，闸门形同虚设）。
- **`server/lib/auth.js` API Key 鉴权**：默认关闭（本地开发零摩擦），
  配了 `API_KEYS` 才启用。key 比较为常数时间；完整 key 绝不进日志或响应，
  身份标识只用摘要前 8 位。`REQUIRE_AUTH=1` 但没配 key 时会响亮地降级并警告——
  配置矛盾必须说出来，否则会以为自己受保护、实际大门敞开。
- **`/metrics`**：Prometheus 文本格式，无依赖。任务数 / 失败 / 降级 / 缓存命中 /
  配额用量 / 存储规模。
- **provider 启动探活**：AI 通道不可用时立刻降级为规则引擎。
  取代此前的人工 `INFINI_VERIFIED=1` 门禁——那个开关只能证明「有人核准过端点」，
  证明不了「此刻密钥还有效」。探活是运行时事实，人工标记是历史记忆。
- **分享页可撤销**：创建时返回的 `revokeKey` 只出现一次，服务端只存哈希，
  比较用常数时间。分享出去的东西必须能收回来。
- `docker-compose.yml`：默认配置是安全的（不带 AI 密钥），
  持久化卷 + 只读根文件系统 + no-new-privileges。

### 变更

- **额度用尽时降级而不是罢工**。规则引擎不花钱，凭什么限流——
  额度耗尽或队列满时自动降级为规则引擎继续给结论（统计口径、置信区间、
  显著性检验与 AI 模式完全一致），并在报告里说明为什么降级。
- `POST /api/analyze` 返回 `authenticated` / `willUseAi` / `quota`，
  提前告诉调用方会不会降级，而不是等报告出来才发现没有 AI 叙述。
- `/healthz` 报出 quota / auth / persistence 状态——
  访问者不必撞上限制才知道有限制。
- 分享页披露可信度与数据来源；引擎标注跟上 provider 改名。
- **SECURITY.md 那条「没有鉴权、没有配额、没有并发上限」的警告已删除**，
  改为说明已有防护与仍需自己做的事。README 同步。

### 修复

- 测试会往仓库的 `data/` 里写持久化文件。改为每个实例一个临时目录，
  跑完删掉——测试必须与真实数据完全隔离。
- 存储层记录 id 经字符白名单 + 点号折叠：功能上前者已足够，
  但留着 `..` 会让「这里安不安全」需要想一下才能确定。不变量应当一眼可验证。

### 备注：为什么不是 SQLite

早期方案曾考虑 SQLite（Node 22+ 内置 `node:sqlite`），实际落地时否掉了：
① 会把兼容下限从 Node 18 抬到 22，而 CI 正在三档上跑；
② 单进程、无并发写、无复杂查询、数据量几百条，用不上 SQLite 的长处；
③ 出问题时 `cat data/tasks/xxx.json` 就能看，不需要 sqlite3 客户端。
将来若出现真实的并发写或复杂查询需求再换是合理的，但那应该由真实问题驱动。

全套 409 → 462 项断言。

---

## [0.12.0] — 2026-07-26

**P3「分析真实化」阶段。** 主题：让「A 比 B 差」这句话有依据，并且让接上 AI 不再是降级。

### 新增

- **`js/stats-kernel.js` 统计核**（75 项断言，全部对照 R 的参考值）：
  Wilson score 区间 / Fisher 精确检验 / 组内中心化偏相关 / Mann-Kendall 趋势检验。
  参考值可一行复现：`fisher.test(matrix(c(3,1,1,3),2,2))` = 0.4857，
  `binom.confint(6,20,"wilson")` = 0.1455–0.5190。
- **`server/services/providers.js` provider 抽象**：local / infinisynapse /
  openai-compatible 三个实现共用一个契约。选择逻辑集中在 config，
  配置不全时降级并在 `/healthz` 说明原因。
- **`server/services/brief.js` 统计简报**：喂给 AI 的输入从原始 CSV 换成
  已核验的统计事实。400 行 CSV 32KB → 简报 2KB，且行数翻倍后大小基本不变。
- **`server/services/retrieval.js` BM25 检索**：RAG 的检索侧真正接通，
  中文用字符 bigram 分词。新增 `/api/knowledge/search` 检索预览，
  让用户自己验证「问这个问题会检索到什么」。
- **`js/fleet-view.js` 机群视图**：分析结论 → 3D 空间里的具体机台。
  低模机柜 + 状态色，**不透明度由置信区间宽度决定**——
  「1 单 1 失败 = 100% 故障率」显示为几乎透明的幽灵，而不是最刺眼的红色。
- 报告新增 `evidence` 字段：每条结论附方法 / 样本量 / 统计量 / 置信区间 / p 值。
  界面上以折叠的「计算依据」呈现。
- 条形图绘制 95% 置信区间误差线；样本不足的条目整体压暗。
- 结果缓存（LRU + TTL）：同一「问题 + 数据集 + provider」不重复调用 AI。
- 前端知识库入口（仅 AI provider 下展示）+ 检索测试按钮。

### 变更

- **排名不再是比大小**：只有排第一**且**与其余组差异统计显著才敢说「最差」。
  对照组是「其余各组合并」而非总体——后者把被检验组自己也算进对照，会稀释差异。
- **不显著时如实说**并把可信度降为 low，同时仍给出定位入口——
  排第一的机台值得看一眼，只是措辞不让人误以为已定论。
- 层高分析同时给「未控制混杂」与「控制材料与模型后」两个口径。
  在真实机群数据上粗相关 r=-0.53、偏相关 r=-0.83——混杂因素在**掩盖**真实关系。
- 建议由统计量驱动：某类故障的占比**区间下界**超过 40% 才判定为主因。
- `/healthz` 报出 provider / label / capabilities，engine 字段与报告同源。
- InfiniSynapse 的 prompt 不再内联整份 CSV。

### 修复

- **接上真 AI 反而功能更少**（P0 体检里最反直觉的一条债）。根因是架构反了：
  旧做法把 CSV 丢给 LLM 让它自己算。新架构下 **LLM 只负责叙述，数字由本地统计核算**，
  合并时图表 / highlight / evidence 一律用本地的——云端模式从此不弱于本地。
- **BM25 的 IDF 在小语料下退化**：语料只有一两个片段时每个词的文档频率都等于总数，
  IDF 趋近 0，「用户刚上传的第一份文档」无论问什么都检索不到。
  最终得分改为 BM25 + 覆盖率×权重。
- 修掉自己引入的工具链问题：Python 编辑脚本在 Windows 上把 `
` 写成 CRLF，
  污染了 8 个文件的行尾。

全套 260 → 409 项断言。

---

## [0.11.0] — 2026-07-26

**P2「数据真实化」阶段。** 主题：让故障从物理过程中涌现，而不是概率抽样出来。

这一版解决的是本项目最根本的问题。此前的数据是这样造的：

```js
machineFailBase = { "FX-256-03": 0.2, ... };   // 直接写死某台机故障率
failed = rnd() < pFail;
```

于是「分析引擎发现 03 号机故障率高」毫无信息量——它只是把生成参数读了回来。
现在每台机器有一组**确定性的固有物理特征**，故障是这些特征与本单工艺参数
相互作用越过阈值的结果。**代码里已经没有任何 `pFail` 概率抽样。**

### 新增

- **`js/machine-profile.js`（新模块）**：机台固有物理特征与故障机理模型。
  特征完全由机台编号决定（同编号永远相同，像真实设备一样有个性）：
  热端积碳、送料齿轮咬合力、料架阻力、加热器有效功率、皮带磨损、环境温度、风扰；
  机型结构属性（是否封闭腔体、幅面）由机型决定，不随机。
- **五类故障全部可由物理涌现**（此前只有三类，且都靠手工注入）：
  - `堵料` — 热端积碳 × 温度不足 × 体积流量过大 → 挤出负载越限（新增机构负载监测器）
  - `断料` — 咬合力不足 × 料架阻力 × 料盘将空 → 送料打滑（同上）
  - `热失控` — 加热器有效功率不足，够不到高温材料目标 → 既有的热失控监测器发现；
    新增**加热失败保护**（参考 Marlin heating-failed），否则加热器够不到目标时预热会永久卡住
  - `翘边` — 床温低于材料下限 × 环境冷有风 × 材料收缩率 × 大平面 → 完成时判废
  - `悬垂塌陷` — 需支撑却未开启，或冷却/层高/速度不足 → 完成时判废

  后两类是**打印完成时的成品判废**——机械上跑完了但零件报废，真实产线正是这样记录的。

- **`tools/farm-sim.js`（新工具）**：虚拟机群。批量物理仿真产出生产数据集，
  输出 CSV + 遥测 JSON + 前端可内联加载的数据模块。随机只用于排产
  （派给哪台机、什么材料参数），成败完全由物理决定。同 seed 逐行可复现。
- **`tools/headless-sim.js`（新模块）**：无头仿真驱动。桩打印机 + 单单执行器，
  测试与虚拟机群共用，避免桩实现漂移。
- **`datasets/`（新目录）**：8 台机 × 400 单的机群数据集与配套遥测，
  含说明文档解释数据里有哪些**没有被硬编码**的涌现结构。
- **`tests/farm.test.js`（新套件，48 项断言）**：证明「故障是算出来的」——
  确定性 / 区分度 / 效应可调转 / 物理证据自洽 / 默认参数安全。
- `FXInsightData.normalizeFault()`：故障名归一化的单一真源，前端采集与虚拟机群共用。
- `FAULT_TAXONOMY` 每类故障标注了 `stage`（运行中报警 / 完成时判废）与 `mech`（物理机理）。
- 生产记录挂载 `_telemetry`：挤出负载峰值、翘边/悬垂风险指数、温度偏差、
  调平残差、本单工艺参数、机台物理特征——真实产线拿不到的数据资产。

### 破坏性变更

- **默认数据集换成物理仿真产出**。前端数据集槽位 `sample` → `farm`，
  后端内置数据源改用机群数据。旧的概率合成数据（含预埋故事线）保留在
  合成样例 CSV，仅作回归测试的确定性输入。
- 前端数据集槽位 `sim` 标签「仿真采集」→「本机采集」（与「机群仿真」区分）。
- `FXU.ThermalSim` 构造函数新增第四个参数 `phase`（默认 0）。

### 修复

- **热模型用了 `Math.random()` 做噪声相位**，导致同一台机器跑同样的活会得到
  不同结果——对一个数据生成工具来说这是可复现性缺陷。改为确定性相位。
  同样问题的探针噪声也一并改为由机台编号派生的确定性噪声。
- **堵料监测器在排障回温期误报**：喷嘴还冷着就继续挤出，暂态高阻力被判成堵料。
  改为与热失控监测器同一条规则（正在有效升温时不计入）。
- 床面误差场此前按**机型**派生，同机型的不同实例共用同一张床面。改为按机台编号派生。
- `js/sim.js` 中一处 `break` 之后的死赋值（由 ESLint 发现）。

### 变更

- 后端 `local-engine` 暴露 `farmRows()` / `farmCsv()`，`generateSample()` 降级为
  「仅回归测试用」。
- CI 新增门禁：内置数据集必须由 `tools/farm-sim.js` 产出且带来源标记。
- `tests/insight.test.js` 中「仿真只能产生三类故障」的断言随实现更新
  （现已覆盖五类，并新增阶段划分断言）。

---

## [0.10.0] — 2026-07-26

**P0「诚实化」阶段。** 主题：让代码、界面、文档里的每一句话都为真。

这一版本删除或修正了全部「宣称了但没实现」的内容。部分能力**表面上变弱了**——
那是因为它们此前并不真实存在。

### 破坏性变更

- **引擎标识重命名**（影响 API 消费方）：
  - `/healthz` 与 `POST /api/analyze` 的 `engine` 字段：`"mock"` → `"rules"`；
  - 报告的 `engine` 字段：`"local"` → `"local-rules"`，`"mock"` → `"server-rules"`；
  - 理由：「mock」暗示结果是编造的，实际是真实的确定性计算，只是没有 AI 参与。
- **示例数据文件更名**：`print_jobs_sample.csv` → `print_jobs_synthetic.csv`，
  文件名直接体现它是合成数据。
- `MOCK_DELAY_MS` **默认值 350 → 0**：规则引擎本就是毫秒级完成，
  拖慢进度条让它「看起来在思考」属于欺骗性 UI。
- `FXInsightEngine.analyze(question, rows)` 新增第三个参数 `opts`（向后兼容）。

### 新增

- **统计守卫**：`E.MIN_SAMPLE = 5`，分组样本量不足时不参与排名——
  修复了「跑过 1 单且失败的机台以 100% 故障率登顶」的缺陷。
  KPI 看板与分析器现在共用同一常量，不再各自为政。
- **可信度字段**：每份报告带 `confidence`（`high`/`medium`/`low`/`insufficient-data`）。
  证据不足时明确拒绝给结论，而不是硬挑一个。
- **数据来源契约**（`provenance`）：贯穿数据集 → 报告 → 分享页。
  合成数据在数据接入区、报告头都有醒目标记。
- **「听不懂」如实告知**：问题未命中任何分析维度时，明确说明并列出支持的维度，
  不再静默降级成「生产概览」并假装那是答案。
- **计价口径可溯可换**：`COST_PROFILE` 带 `source` 出处说明，随报告一起披露；
  新增 `FXInsightData.setCostProfile()` 供替换为自己的采购价。
- **故障词表单一真源**：`FAULT_TAXONOMY` 标注每类故障仿真器能否真实产生；
  新增 `FAULT_UNKNOWN`。
- `E.dateRange()`：按数据实际计算时间跨度。
- 合成数据说明：明确样例中包含什么，以及不能用它做什么。
- 工程复核：记录 P0–P5 的演进路线。

### 修复

- **仿真采集写死机台 ID**：此前无论用哪台机型打印，采集记录都写 `FX-256-01`。
  现在取自 `printer.MODEL_TAG`。
- **前端丢弃后端真实进度事件**：`FXApiClient.stream` 的 `onEvent` 曾是空函数，
  界面播的是 `setTimeout` 驱动的三步假动画。现在渲染后端推送的真实阶段与进度。
- **故障类型兜底猜测**：无法识别的仿真故障曾被兜底写成「热失控」，
  会往数据集里注入错误数据。现在如实记为「未知」。
- **KPI 写死文案**：「近三周」改为按数据实际时间跨度计算；
  移除 `.replace("FX-256-", "")`——其他编号体系此前会显示错乱。
- **材料对比写死模型名**：曾硬编码 `model_name === "传感器支架"`，
  用户数据里没有这个中文名时该分析段会静默消失。现在由数据选出问题最集中的模型。
- **限流可被整体绕过**：`lastHit` 达到 10000 条时会 `clear()`，
  一次性清空**所有人**的冷却窗口。改为 LRU 淘汰。
- **相关性分析暗示因果**：层高分析此前直接断言「层高越大速度越快」。
  现在披露未控制材料/模型混杂因素，并声明相关不等于因果。

### 变更

- **知识库接口不再返回不实提示**。`/api/knowledge` 此前在云端模式下回复
  「已登记，将在分析任务中注入」——**没有任何注入逻辑**，`KnowledgeStore.all()`
  全仓库无调用方。现在如实返回 `retrievalEnabled: false` 并说明该文档不会影响分析结果。
  接口保留是为了 RAG 真正落地时复用存储管线。
- **云端模式如实披露能力缺口**。接上 InfiniSynapse 后只有文字结论、
  没有图表与视口联动（规则引擎反而两者都有）。报告中现在明写这一点，
  而不是让用户以为是数据没算出来。
- **视口联动不再暗示机群**。3D 场景只装载一台打印机；此前的「在 3D 视口中定位 X」
  按钮忽略参数、闪的是唯一那台机器。现在只在结论指向当前机型时提供高亮，
  否则明确告知机群视图尚未实现。
- **界面不再把规则引擎称作 AI**。本地与后端默认引擎统一标注「规则引擎（无 AI）」。
- **README 重写**：新增「这个项目里，什么是真的」一节，逐条区分真实能力、
  需要说清楚的部分、以及目前没有的功能。
- **测试从同义反复改为性质断言**。此前 `tests/insight.test.js` 断言
  「结论命中示例故事线 FX-256-03」——那只是在验证生成器和分析器用了同一套常量。
  现在自己构造带已知效应的数据集检验识别能力，并额外验证
  **「把效应调转，结论必须跟着调转」**。断言数 35 → 64。
- `index.html` 的资源版本号统一为 `?v=10`（此前 v7/v8/v9 混用）。

### 文档

- README / README.en 全面重写，对齐实际能力。
- 新增公开架构说明（由内部设计资料脱敏拆分而来）。
- 修正文档漂移：three.js 版本（README r152 vs 内部文档 r159）、
  测试断言数（README 称 33 项，实际 44 项）。

---

## [0.9.0] — 2026-07-22

初始版本（比赛作品）。3D 打印仿真器 + 生产数据分析面板 + 薄后端。
详见 git 历史。
