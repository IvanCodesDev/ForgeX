# FORGE·X Insight

### 打印前验证参数与路径，打印后用真机数据校准和复盘

[![CI](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml/badge.svg)](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.19.0-2563eb)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A522.13-16a34a)
![Node service dependencies](https://img.shields.io/badge/Node_service_runtime_dependencies-0-0f172a)
[![License](https://img.shields.io/badge/license-Apache--2.0-f97316)](./LICENSE)

**简体中文** · [English](./.github/README.en.md)

真实 3D 打印最费时间的部分，往往不是点击“开始”，而是反复试错：参数是否合适、支撑是否足够、预计要打印多久、为什么同一个文件换一台机器就失败，以及失败后该改哪一项。

**FORGE·X Insight** 用于 FDM 3D 打印的打印前预演和打印后分析。它可以在不消耗材料、不占用设备的情况下比较工艺方案、查看实际切片路径、估算时间与耗材；打印完成后，还能导入真实 G-code 和设备日志，把预测与真机结果放在一起复盘。

它不直接控制打印机，也不能代替首件试打。它的作用是先排除明显不合理的方案，减少盲目调参，再让每一次真机打印都能反过来改进下一次预测。

<img width="2560" height="1343" alt="FORGE·X Insight 主界面" src="https://github.com/user-attachments/assets/d4f1eab7-3bec-4d84-8e6c-ce32008688ec" />

## 解决的具体问题

| 真实打印中的问题                                         | 直接后果                                     | FORGE·X 能做什么                                               |
| -------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| 参数主要靠经验试，改了层高、填充或速度却不知道会影响什么 | 反复试打，浪费耗材和机时                     | 重新计算层数、路径、挤出量、耗材和时间，用同一模型直接比较方案 |
| 打印前只能看到切片器给出的汇总数字                       | 难以发现局部路径、支撑和运动过程中的问题     | 逐层查看周界、填充、支撑、空驶和挤出路径，并在 2D/3D 中回放    |
| 切片器估时与真机完成时间经常不一致                       | 排产、交付时间和成本估算不稳定               | 将 G-code 与对应真机日志配对，按机型、固件和材料校准时间模型   |
| 打印失败后只知道“这次失败了”                             | 同类故障重复出现，经验无法复用               | 保留温度、调平、速度、故障和任务记录，对比计划值与实测值       |
| 多台设备积累了 CSV 和日志，但很难回答具体问题            | 不知道哪台机器、哪种材料或哪类批次更值得排查 | 分析机台故障率、材料失败率、成本趋势、层高关系和失败批次共性   |
| 分析报告只给一个结论                                     | 容易把小样本、偶然波动当成规律               | 同时展示样本量、数据来源、置信区间、显著性、图表和证据         |

## 在真实打印流程中怎么使用

### 1. 打印前：低成本预演

导入模型、图片或已有 G-code，设置机器、材料和工艺参数，然后检查：

- 实际会生成多少层、多少周界、多少填充和支撑；
- 喷头在哪些区域挤出、空驶或回抽；
- 调整层高、填充率、打印速度、回抽和支撑后，路径是否真的发生变化；
- 预计打印时间、耗材长度、耗材重量和基础成本；
- 当前方案是否存在悬垂、支撑不足、热失控演练或送料负载等风险信号。

这个阶段适合比较方案和排除明显问题，不需要占用真实打印机。

### 2. 打印后：预测与实测对账

导入本次任务使用的真实 G-code 和打印机日志，系统会并列展示：

- 切片器声明值；
- FORGE·X 根据路径重新计算的值；
- 真机实际完成时间、耗材、层数、状态和温度记录。

三组数字不一致时，系统保留原值和差异，不把任何一方直接当成“绝对正确”。持续积累配对任务后，可以建立更贴合具体设备的时间校准模型。

### 3. 多次打印后：找出重复问题

上传生产任务 CSV，或直接使用仿真任务沉淀的记录，可以回答：

1. 哪台机器的故障率更高，主要是什么故障；
2. 不同材料的失败率是否存在明显差异；
3. 层高与打印时长是否相关；
4. 成本由耗材、能耗和机时中的哪一项主导；
5. 失败任务是否集中在某台机器、某种材料或某段时间。

## 模拟和真实打印的区别

| FORGE·X 模拟                                   | 真实打印                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| 根据模型、G-code、机器 Profile 和工艺参数计算  | 由真实设备、固件、材料和环境执行                               |
| 可以快速重复，不消耗耗材，不占用机器           | 会消耗材料、机时和设备寿命                                     |
| 适合比较参数、检查路径、估算时间和预演故障流程 | 才能验证真实尺寸、表面质量、层间结合和设备稳定性               |
| 只能覆盖已经建模或有数据支撑的因素             | 还会受到耗材受潮、喷嘴磨损、皮带松紧、气流、振动和操作误差影响 |

因此，FORGE·X 的定位不是“替代真机”，而是：

> **模拟负责低成本预演和排雷，真机负责最终验证；真机结果再用于校准下一次模拟。**

## 核心能力

### 模型、切片与路径

- 内置参数化模型、摆放缩放、图片浮雕和剪影建模；
- 周界、顶底实心层、扫描线填充、支撑和裙边；
- 二进制 STL、ASCII OBJ 和 Marlin 风格 G-code 导出；
- Cura、PrusaSlicer、OrcaSlicer 和 SuperSlicer 常见 G-code 方言解析；
- 绝对/相对 E、床角/中心原点和逐层 2D/3D 回放。

### 设备过程仿真

- CoreXY、i3、Delta 和大幅面龙门运动学；
- 预热、调平、打印、暂停、恢复、完成和故障状态；
- 喷嘴/热床温度、耗材、负载、进度和事件时间线；
- 床面误差、3×3 探测、5×5 补偿网格和打印时插值；
- 温度偏差、送料负载、悬垂和翘边等机制的演练与记录。

### 真机日志与校准

- 标准 JSON 和常见 CSV 设备日志；
- G-code 与日志通过 SHA-256 绑定，避免配错任务；
- 按机型、固件和材料区分时间校准模型；
- 只有通过来源、样本量和 holdout 门槛的模型才能自动生效；
- 持续记录后续误差，漂移时停止自动匹配。

### 生产数据分析

- Wilson 置信区间与最小样本量保护；
- Fisher 精确检验；
- 控制机器、材料等混杂因素的偏相关；
- Mann–Kendall 趋势检验；
- 报告保留来源、证据、图表和不确定性。

## 快速开始

### 只体验现有前端仿真

直接打开 `index.html`。无需安装依赖，也无需联网。

### 启动 React 开发工作台

需要 Node.js 22.13 或更高版本。首次检出仓库后安装锁定的开发与前端工作区依赖：

```bash
npm ci
```

分别启动 Node 服务和 Vite：

```bash
# 终端 1：同源 API、身份、数据与 G-code 代理
npm start

# 终端 2：React + TypeScript 开发服务器
npm run frontend:dev
```

开发页面由 Vite 输出在 [http://127.0.0.1:5173](http://127.0.0.1:5173)，API 请求代理到 `127.0.0.1:8787`。

### 构建并启动完整服务

```bash
npm run frontend:build
npm start
```

访问 [http://127.0.0.1:8787](http://127.0.0.1:8787) 使用原 JavaScript 工作台，或访问 [http://127.0.0.1:8787/react/](http://127.0.0.1:8787/react/) 使用 React 工作台。

完整服务额外提供数据持久化、真机日志与数据源接口、分析任务、分享页、知识检索、校准审核、健康检查和可选 AI 叙述。

> Node 服务端本身仍不依赖第三方运行时包；React 构建、类型检查、单元测试和端到端测试使用根工作区锁定的 npm 依赖。

## AI 如何参与

没有 AI 时，确定性统计核仍可完成聚合、置信区间、显著性检验和图表生成。

接入 InfiniSynapse 后，AI 只负责根据已经核算的统计简报组织叙述，不重新计算数字，也不覆盖本地证据。线上版本采用 **B｜InfiniSynapse Partner SSO**：用户在 InfiniSynapse 官方页面登录，分析调用与用量归属用户自己的账号；`clientSecret`、一次性授权码和用户 Partner API Key 只保存在服务端。

## 数据真实性与安全边界

- 仓库内置数据、演示日志和演示校准包均明确标记为合成数据，不作为真实打印精度证明；
- 上传数据保持独立来源标记，报告和分享页沿用该标记；
- Profile 和校准包使用声明式 JSON，不能注入代码或覆盖内置 ID；
- 服务端静态资源采用 allowlist，拒绝访问 `.env` 和内部代码；
- AI 密钥只从服务端环境变量读取，不进入浏览器或仓库；
- 导出的制造文件进入实体设备前，仍需使用目标切片器、固件配置和设备安全流程复核。

## 技术架构

```text
Browser
├─ /             现有 JavaScript 工作台（迁移期稳定基线）
└─ /react/       React + TypeScript 新工作台
   ├─ 共享 Header：导航、运行模式与 SSO/API/匿名/离线身份状态
   ├─ #/simulator：浏览器即时仿真、参数比较、事件时间线与非权威来源标记
   ├─ #/gcode：机器/材料 Profile、Worker 解析、Three.js 路径与 SHA-256 日志对账
   ├─ #/analytics：本地数据分析、规则报告、图表、证据表与导出
   ├─ #/governance：公开校准目录、浏览器只读治理边界与已有分享查询
   └─ G-code 分析支持 browser / shadow / dotnet 三种模式
             │ 同源 raw-body 流式代理
             ▼
Node.js service :8787
├─ datasource / analysis / knowledge / share
├─ calibration / SSO / auth / quota / metrics
└─ /api/v1/gcode/analyze ───────────────┐
                                        ▼
                              C# .NET 10 sidecar :8788
                              ├─ StreamingGCodeAnalyzer
                              ├─ 持久异步作业、有限重试、死信、恢复、SSE 与幂等键
                              ├─ 文件仓库健康探针与可校验备份/恢复
                              ├─ PostgreSQL v1 迁移契约（运行时驱动待接入）
                              ├─ 确定性摘要、单位与稳定错误码
                              └─ GoldenDiff + JobGate + PersistenceGate 门禁
```

- **前端**：旧页面继续可用；React 已落地共享身份头、Profile 选择、G-code/日志对账、数据分析与校准治理等垂直切片，G-code 在 Worker 中解析；
- **业务后端**：Node.js 原生 `http`，零运行时依赖，并只对白名单路由提供 C# 同源代理；
- **G-code 计算边界**：.NET 10 sidecar 保留同步接口，并新增 `POST /api/v1/gcode/analyses`、作业快照、SSE 事件与幂等取消接口；同步与异步结果都返回机型/材料 Profile 标识、生效参数、确定性 SHA-256 Profile 指纹、最多 20,000 层的完整逐层计划，以及最多 100,000 段的 C# 有界二进制工具路径。引擎 1.4.0 还把材料价格、喷嘴温区、床温下限、最大速度和最大体积流量纳入 Profile v2 指纹，输出直接耗材成本与 low/medium/high 打印前风险；当前成本不包含尚无审计输入的能耗和机时。React Worker 在显示采样前生成同结构逐层摘要，`shadow / dotnet` 会逐字段核验；`dotnet` 校验并按层解码 C# 工具路径给 Three.js，同时采用 C# 成本与风险，`browser / shadow` 保留原 Worker 几何和主摘要作为回滚。Three.js 只负责显示，不参与权威计算；异步作业继续支持断线续传与轮询兜底。Stage 6 把尝试次数、预算、下次执行时间和死信时间持久化；瞬态故障有限退避，预算耗尽进入稳定 `failed / dead-letter` 终态，进程重启会把未完成的 `running` 作业重新排队。原子 owner/tenant 活动作业配额返回稳定 429，当前/前一内部密钥支持有界轮换窗口。Node 会把已核验身份匿名化为稳定 `tenant/owner`，再通过独立内部密钥交给 C#，任务查询、SSE 与取消均按该边界过滤；
- **契约边界**：`backend/src/ForgeX.Api/openapi/v1.json` 是 API 单一来源，构建前生成 TypeScript DTO、操作路径和路径参数函数；CI 通过源文件 SHA 与生成器复跑阻止前后端契约漂移；
- **存储**：默认 `Persistence:Provider=file` 写入 `data/`，容器部署可挂载持久化卷；文件作业仓库提供逐条 SHA-256 的版本化备份、全量预检恢复和就绪探针。`backend/database/postgresql/` 已冻结 PostgreSQL v1 迁移、租户/归属键、事件表、幂等唯一约束与 RLS 策略，但本阶段未启用 PostgreSQL 运行时驱动，误配为 `postgresql` 会在启动时明确终止。
- **可观测性**：C# 输出单行 JSON 请求日志，包含稳定路由模板、状态码、耗时与 trace ID；`/metrics` 提供有界标签的 Prometheus 文本指标，并公开队列、持久化状态、作业耗时及 retry、recovery、dead-letter、quota 计数，不把具体作业 ID 放入标签。部署目录提供 SLO、六类告警和逐项运行手册。
- **分析迁移**：Stage 4-F 已把 CSV 归一、统计核、KPI 和六类确定性规则报告迁入零 NuGet 的 `ForgeX.Analytics`。`POST /api/v1/analytics/reports` 只接受归一化且带来源证据的最多 5000 行 JSON，并由 Node 同源白名单代理。线上默认 `dotnet`：React 先保留浏览器即时结果，C# 回包通过逐字段一致性门禁后才成为报告与导出的权威来源；差异、超时或错误会显式降级到 JS。`shadow` 继续只比对不切换，`browser` 在一个发布周期内保留为零请求回退，离线模式始终使用浏览器结果。

### React Stage 2 当前范围

| 切片             | 已落地行为                                                                                    | 回滚/边界                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 共享壳与身份     | Header 显示运行模式、当前身份和 AI 能力范围；离线模式不发起身份请求                           | 身份优先级为 SSO、允许分发的浏览器 API 凭据、匿名；旧工作台仍保留         |
| 浏览器即时仿真   | 在 `#/simulator` 编辑核心工艺参数，通过 Worker 运行即时预览并展示阶段进度、摘要和事件时间线   | 明确标记为“浏览器即时预览（非权威）”；独立开关关闭时只回退该路由          |
| Profile + G-code | 选择内置机器/材料 Profile，可导入受限 JSON；Worker 解析 G-code 并显示逐层 3D 路径             | Profile、G-code 和日志分别由独立开关回退；旧 DOM 流程未在此路由中重复绑定 |
| 真机日志对账     | 仅当声明的 G-code SHA-256 通过强摘要校验时生成对比；不匹配时保留证据但不输出差异指标          | 更换 G-code 会清除旧日志绑定                                              |
| 数据分析         | 导入本地 CSV，显式标记真实/合成来源，生成 KPI、规则报告、SVG 图表、可访问表格与 JSON/CSV 导出 | 线上报告默认经 C# 一致性门禁；JS 作为即时结果和一版发布周期回退           |
| 校准治理         | 读取公开校准目录、展示审核边界并查询已有分享                                                  | 浏览器固定只读；审核仅由配置 `CALIBRATION_REVIEW_KEYS` 的受信后台执行     |

`#/simulator` 迁入的是可复现的浏览器即时预览子集；模型导入、完整高级参数和其他旧页面仍以 `/` 作为可回滚基线。该页面不把浏览器估算表述为 C# 权威分析或真机实测。

### React 功能开关

以 [`frontend/.env.example`](./frontend/.env.example) 为模板配置 Vite。下列 React 切片开关在未设置时默认启用，显式设为 `0` 可单独回退：

| 环境变量                              | 作用                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `VITE_REACT_SIMULATOR_ENABLED`        | 启用 `#/simulator` 即时仿真；`0` 时只显示该功能已回退              |
| `VITE_REACT_GCODE_ENABLED`            | 启用 `#/gcode` React 垂直切片；`0` 时显示迁移占位/旧入口           |
| `VITE_REACT_PROFILE_SELECTOR_ENABLED` | 启用机器/材料 Profile 选择和受限 JSON 导入；`0` 时回到基础参数输入 |
| `VITE_REACT_MACHINE_LOG_ENABLED`      | 启用真机日志 SHA-256 对账；`0` 只回退日志面板                      |
| `VITE_REACT_ANALYTICS_ENABLED`        | 启用 `#/analytics` 本地分析路由；`0` 时显示该功能已回退            |
| `VITE_REACT_GOVERNANCE_ENABLED`       | 启用 `#/governance` 校准治理路由；`0` 时显示该功能已回退           |

`VITE_GCODE_AUTHORITY` 不是页面开关，而是 G-code 分析模式：`browser` 为默认浏览器结果，`shadow` 与 C# 双跑但不切换主结果，`dotnet` 才使用 C# 返回作为该路由结果。Profile 选择会把稳定机型/材料 ID 与生效的平台尺寸、原点和材料密度同时提交；C# 返回确定性 Profile 指纹，前端在切换结果前核验 ID、参数和指纹结构。`dotnet` 默认通过异步作业运行：创建请求携带稳定幂等键，SSE 使用事件序号续传，连接失败后轮询同一作业，页面取消会同步取消服务端作业。`VITE_GCODE_JOB_API=0` 可把 React 独立回退到既有同步 `/api/v1/gcode/analyze`；服务端 `GCODE_ASYNC_JOBS_ENABLED=0` 可关闭异步路由。`VITE_API_BASE=offline` 可强制离线演示；`VITE_NODE_API_KEY` 与 `VITE_NODE_BEARER` 会进入浏览器产物，只能放置允许分发的客户端凭据，校准审核密钥只允许配置在服务端 `CALIBRATION_REVIEW_KEYS`。

Analytics 另有独立的 `VITE_ANALYTICS_AUTHORITY=dotnet|shadow|browser`：未配置时默认 `dotnet`，只有字段级门禁完全一致的 C# 报告会进入页面与导出；`shadow` 只显示差异；`browser` 完全本地计算且零分析 API 请求，是一个发布周期内的即时回滚开关。`VITE_API_BASE=offline` 在任何模式下都强制浏览器结果。服务端可用 `ANALYTICS_AUTHORITY_ENABLED=0` 独立关闭该路由，5 MiB 请求上限和 5000 行上限不可由部署配置放大。

## 验证

```bash
npm run check                 # ESLint + Prettier + React 类型/单测 + Node 契约/发布测试
npm run frontend:build        # 生成由 Node 在 /react/ 提供的生产包
npm run frontend:build:offline # 生成可由 file:// 打开的 React 单文件包
npm run dotnet:golden         # 构建 .NET 10 G-code 核心并执行 JS/C# 字段级黄金差异
npm run dotnet:jobs           # 验证存储、仓库、幂等、重试持久化、退避分类与有界队列
npm run dotnet:resilience     # 实启 API，验证重启恢复、有限重试、死信事件与指标
npm run dotnet:capacity       # 验证 owner/tenant 配额与 16 并发容量基线
npm run dotnet:recovery-drill # 生成、校验、篡改检测、恢复并验证 RPO/RTO 证据
npm run security:audit        # 审计密钥、锁文件、registry、安装脚本、NuGet 与镜像策略
npm run ops:check             # 校验 SLO、Prometheus 告警、轮换与回滚运行手册
npm run rollback:rehearse     # 隔离渲染当前/前版镜像对并验证命名卷保持不变
npm run dotnet:gcode-benchmark # 生成 16 MiB 流式解析、内存、结果体积与取消延迟证据
npm run gcode:layer-golden:update # 仅在审阅有意的逐层契约变更后更新金样本
npm run postgres:migrations:check # 验证 PostgreSQL 迁移顺序、SHA、RLS 与非破坏性 DDL
npm run dotnet:persistence    # 创建、校验、篡改检测并恢复文件作业仓库备份
npm run dotnet:analytics      # 双跑 JS/C# CSV、统计核、排名和 400 行 KPI，生成字段级差异
npm run containers:check      # 静态验证镜像固定版本、非 root、只读文件系统和卷边界
npm run test:e2e              # Chromium 全量 + Firefox/WebKit 关键流程
npm run demo:check            # 演示素材与真实导入链校验
```

只快速回归当前 React Stage 2 主流程时，可运行：

```bash
npm run frontend:typecheck
npm run frontend:test
npm run test:e2e:chromium -- tests/e2e/react-stage2.spec.js
npm run test:e2e:chromium -- tests/e2e/react-stage3-simulator.spec.js
```

测试覆盖切片、导出、G-code、真机日志、时间校准、Profile、调平、仿真状态机、统计核、生产洞察、Partner SSO、服务端接口，以及 React 身份 Header、即时仿真零 API 请求与参数响应、Delta + PETG G-code/日志对账、分析来源、校准治理边界和移动端溢出检查。

Stage 4 分析 Golden 位于 [`tests/golden/stage4-analytics-golden.json`](./tests/golden/stage4-analytics-golden.json)。默认验证命令只读；只有人工审阅差异后才能运行 `npm run analytics:golden:update` 更新基线。C# 差异报告写入 `backend/artifacts/analytics-golden-diff.json`，CI 将其作为独立 artifact 保存。

Stage 5-B 逐层计划 Golden 位于 [`tests/golden/stage5-layer-plan-golden.json`](./tests/golden/stage5-layer-plan-golden.json)。默认 `npm test` 只读复算浏览器结果，`npm run dotnet:golden` 再以同一金样本核验 C# 的每层字段、20,000 层上限和聚合不变量；只有审阅有意变更后才运行更新命令。

Stage 5-C 在同一 `dotnet:golden` 门禁增加 packed toolpath 的层切片、记录编码和硬预算探针；`dotnet:gcode-benchmark` 另用 16 MiB / 729,442 段夹具验证 100,000 段预算、结果体积、内存、首读进度和取消延迟。浏览器端会在权威切换前验证整个 payload，并只解码当前选中层。

Stage 5-D 补齐材料、直接耗材成本与打印前风险权威契约：Golden 门禁验证成本公式、温度/速度/流量阈值及风险代码，作业门禁验证 Stage 5-C 持久化结果会以稳定 `gcode_result_contract_outdated` 降级而不会伪装成新契约。

## 部署

### Docker Compose

```bash
copy deploy\.env.example deploy\.env
# 为 GCODE_AUTHORITY_INTERNAL_SECRET 生成至少 32 字节的随机值，再写入 deploy/.env
docker compose -f deploy/docker-compose.yml up -d
```

Compose 同时构建 Node 网关与 .NET 10 权威 sidecar。两者使用固定版本的 Alpine 多阶段镜像、不同的非 root UID、独立命名卷、只读根文件系统、`tmpfs /tmp`、空 capabilities 与 `no-new-privileges`；C# 的 8788 端口只暴露给 Compose 内部网络。完整启动、健康、指标、日志、升级前备份和回滚步骤见 [`deploy/README.md`](./deploy/README.md)。CI 会真实构建两张镜像，并执行 UID、写入边界、`/react/`、`/metrics` 和 sidecar 重启演练。

### Node

```bash
copy server\.env.example server\.env
node server/index.js
```

如需启用 `shadow` 或 `dotnet` 权威模式，先在另一进程启动 loopback sidecar：

```bash
npm run dotnet:api
```

常用配置见 [`server/.env.example`](./server/.env.example) 与 [`frontend/.env.example`](./frontend/.env.example)。Node 会先执行统一的 Partner SSO/API Key 身份守卫，再把 G-code 同步分析、开启的异步作业以及可选 Analytics shadow 白名单路由流式代理到 `GCODE_AUTHORITY_URL`；浏览器 Cookie、API Key 与 Authorization 均不会转发给 C# sidecar。Analytics shadow 另受 `ANALYTICS_AUTHORITY_ENABLED`、`ANALYTICS_AUTHORITY_TIMEOUT_MS` 和不超过 5 MiB 的 `ANALYTICS_AUTHORITY_MAX_BYTES` 约束。生产环境应同时配置同一个至少 32 字节的 `GCODE_AUTHORITY_INTERNAL_SECRET` 与 C# `InternalAuth__SharedSecret`：Node 仅转发匿名化的 `tn_/ow_` 标识，C# 不接受浏览器自报租户。轮换时短暂配置 `InternalAuth__PreviousSharedSecret`，网关切换完成后立即清空。`GCODE_ASYNC_JOBS_ENABLED=0` 可独立关闭异步路由而保留同步分析。C# 作业韧性与准入可通过 `GCodeJobs__QueueCapacity`、`GCodeJobs__Retry__*`、`GCodeJobs__Admission__MaxActivePerOwner` 与 `GCodeJobs__Admission__MaxActivePerTenant` 调整，越界值会在启动时终止。React 默认使用同源 HttpOnly Cookie；只有在凭据允许随浏览器产物分发时，才使用 `VITE_NODE_API_KEY` 或 `VITE_NODE_BEARER`。部署完成后可访问 Node `/healthz` 与 `/metrics`，并在内部网络访问 C# `/health/ready` 与 `/metrics` 检查仓库、队列、Worker、请求耗时和 CallerContext 状态。SLO、告警、容量与处置步骤见 [`deploy/SLO.md`](./deploy/SLO.md)、[`deploy/capacity-plan.md`](./deploy/capacity-plan.md) 和 [`deploy/RUNBOOK.md`](./deploy/RUNBOOK.md)。

## 项目结构

```text
css/          界面样式
js/           切片、仿真、分析和前端交互
frontend/     React + TypeScript 新工作台
backend/      .NET 10 权威计算核心、API 与 GoldenDiff
server/       HTTP 服务、登录、存储和 AI provider
contracts/    对外数据契约：schema、示例与夹具
  datasets/     可复现的虚拟机群数据
  profiles/     机器与材料 Profile
  logs/         真机日志格式与示例
  validation/   G-code/日志配对夹具与校准报告
  calibration/  校准包格式、审核和漂移生命周期
demo/         录屏演示素材
deploy/       Docker 部署文件
tools/        数据生成和校验工具
tests/        单元、契约和端到端测试
```

## 项目边界

FORGE·X Insight 面向打印前预演、工艺比较、教学演示、真机任务复盘和生产数据分析。它可以导出制造文件，但不直接连接或控制实体打印机，也不对未经真机验证的参数作生产安全承诺。

版本变化见 [`CHANGELOG.md`](./CHANGELOG.md)，贡献说明见 [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md)。

## License

Apache License 2.0，详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。
