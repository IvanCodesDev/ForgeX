# FORGE·X Insight — 架构设计

> 本文描述**当前实现**的架构。计划中但尚未实现的能力一律标注 `[计划]` 并指向
> [`优化文档.md`](./优化文档.md) 的对应阶段——本文档不描述不存在的东西。

---

## 1. 系统总览

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器（零构建，file:// 可直开）                                │
│    3D 仿真：切片 / 运动 / 温控 / 调平 / 故障 / 遥测               │
│    洞察面板：数据接入 / KPI / 提问 / 报告图表                     │
│    引擎路由：后端可用 → 走后端；否则走浏览器内规则引擎              │
└───────────────────────┬──────────────────────────────────────┘
                        │  仅调用自有后端（HTTP / SSE）
                        ▼
┌──────────────────────────────────────────────────────────────┐
│  自有薄后端（Node ≥18 原生 http，零 npm 依赖）                    │
│    唯一持有 sk- 密钥的进程                                       │
│    /api/analyze（+SSE）· /api/datasource · /api/knowledge       │
│    /api/share · /healthz · 静态托管（allowlist）                 │
└───────────────────────┬──────────────────────────────────────┘
                        │  Bearer sk-xxx（仅服务端）
                        ▼
┌──────────────────────────────────────────────────────────────┐
│  InfiniSynapse Server API（可选）                               │
│    SSE 事件流 + 多步分析任务 + workspace 产物                     │
└──────────────────────────────────────────────────────────────┘
```

**部署形态**：推荐同源部署（后端静态托管前端），零 CORS，一个 URL。

---

## 2. 核心工程原则

| 原则                   | 含义                           | 体现                                                                                                  |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **零运行时依赖**       | 运行本项目不需要 `npm install` | 前端 vendored three.js + 经典脚本；后端只用 Node 内置模块。lint/format 走 devDependencies，不影响运行 |
| **file:// 可直开**     | 双击 `index.html` 就能用       | 经典脚本 + UMD 版 three.js；所有资源相对路径；不依赖 fetch 加载配置                                   |
| **密钥零暴露**         | `sk-` key 只活在后端进程       | 只存 `server/.env`（gitignore）；前端只连自有后端；静态托管 deny-by-default                           |
| **单一真源**           | 分析逻辑只维护一份             | `server/services/local-engine.js` 直接 require 前端的 `js/insight-*.js`，后端与前端引擎永不漂移       |
| **可证伪**             | 结论要能被追问「样本多少」     | 最小样本量守卫、可信度字段、混杂因素披露                                                              |
| **来源可溯**           | 合成数据不得伪装成真实数据     | `provenance` 契约贯穿数据集 → 报告 → 分享页                                                           |
| **不宣称未实现的能力** | 代码/UI/文档三处一致           | 见 `CONTRIBUTING.md` 的硬规则                                                                         |

---

## 3. 前端模块

### 3.1 依赖顺序（`index.html` 中的加载序不可乱）

```
three.min.js
  └─ util.js          工具库（热惯性模型、噪声、事件总线、DOM 辅助）
       ├─ orbit.js     轨道控制器
       ├─ slicer.js    切片引擎（纯逻辑，node 可测）
       ├─ models.js    参数化模型 + 图片→高度场
       ├─ printer3d.js FXPrinterBase：程序化建模 + 打印动画
       │    └─ printers.js  三套额外运动学，继承 FXPrinterBase
       ├─ scene.js     渲染器 / 光照 / 地面
       ├─ machine-profile.js  确定性机台物理特征
       │    └─ profile-registry.js  机器 / 材料 Profile 白名单注册表
       ├─ sim.js       仿真状态机
       ├─ exporter.js  STL / OBJ / G-code（纯逻辑，node 可测）
       ├─ gcode-parser.js  真实 G-code → 切片同构路径（纯逻辑）
       ├─ machine-log.js   真机 JSON/CSV 日志归一与计划/实测对比（纯逻辑）
       ├─ time-calibration.js  配对任务稳健时间校准与误差评估（纯逻辑）
       ├─ insight-data.js    数据层（纯逻辑，node 可测）
       │    └─ insight-engine.js  规则分析引擎（纯逻辑，node 可测）
       ├─ api-client.js      后端客户端
       ├─ insight.js         洞察面板
       ├─ ui.js              流程胶囊 / 面板 / Dock / 监控
       └─ main.js            启动引导
```

「纯逻辑，node 可测」的模块**不得引用 DOM 或 THREE**——这是它们能被后端复用、能被
node 测试驱动的前提。破坏这一点会同时打断后端引擎和测试。

### 3.2 打印机抽象

`FXPrinterBase`（`printer3d.js`）定义契约，运动学差异全部收敛在三个钩子：

| 钩子              | 职责                                                  |
| ----------------- | ----------------------------------------------------- |
| `setHeadXY(x, y)` | 把模型坐标映射到该机型的实际机构运动                  |
| `_applyZ(z)`      | 虚拟 Z 契约：床降 / 龙门升 / Delta 三塔联动，各自实现 |
| `_tubePts(...)`   | 打印头到耗材管束的路径点                              |

`sim.js` / `ui.js` / `scene.js` 通过基类契约驱动，**不感知具体机型**。
新增机型只需继承 `FXPrinterBase` 并 `FXPrinters.register()`。

### 3.3 仿真状态机（`sim.js`）

```
idle → preheat → leveling → printing ⇄ paused → done
                                ↓
                              fault → (排障) → printing
```

关键设计——**校准是一条真实数据链**，不是动画：

1. 每台机型有**确定性的固有床面误差场**（由机型 ID 派生的确定性函数，同一机型每次一样）；
2. 9 点探针**实测**该误差场（日志里打印的值就是采样值）；
3. 拟合成 5×5 补偿网格；
4. 打印时按喷头位置**双线性插值**实时补偿 Z（首层全量，6mm 内渐隐）；
5. 未调平直接打印 → 由接触区实测不均匀度产生真实警告。

热失控同理：故障演练注入的是「加热器失效」这一**物理扰动**，温度按热惯性真实下跌，
由热失控监测器（偏差 >15°C、无回升、持续 3s）**凭实测偏差自行发现**。

### 3.4 真实任务验证与时间校准

P6 把一次性 G-code/日志对比扩展为可复现验证链：

```
fixture manifest
  ├─ G-code ──SHA-256──┐
  ├─ machine log ──────┴─► parse + pair ─► training / holdout
  └─ provenance / slicer / firmware / expected paths
                                      │
                                      ▼
                  actualSec = fixedOverhead + motionScale × plannedSec
```

`time-calibration.js` 使用 Theil–Sen 中位斜率，降低暂停、换料或异常日志对模型的破坏。
至少需要三个不同时长的配对任务；单任务只展示原始倍率，不能分别识别固定开销和运动倍率。
训练与 holdout 分开计算误差，报告始终保留作用域和 provenance。

仓库内置夹具为 `synthetic-conformance`：它们覆盖真实切片器/固件的语法形态，但内容是
手工构造的兼容性样例，只能证明解析、配对、拟合和复算链路稳定，不能证明生产预测精度。

---

## 4. 分析层

### 4.1 当前实现：规则引擎

```
question ──► matchIntent()  关键词命中计分，5 个维度
                 │
                 ├─ score > 0 ─► 对应分析器 ─► 聚合统计 ─► 报告
                 └─ score = 0 ─► 明确告知「没听懂」+ 列出支持的维度 + 总体概览
```

**这不是 AI**。它是确定性的聚合统计 + 关键词路由，界面文案必须如实标注。

统计纪律（`js/insight-engine.js`）：

| 机制               | 说明                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `E.MIN_SAMPLE = 5` | 参与排名的最小样本量。KPI 看板与各分析器**必须共用**此常量，否则两处结论会打架 |
| `E.confidence()`   | 按样本量给出的粗粒度启发式。`[计划 P3]` 换成真实置信区间 + 显著性检验          |
| 混杂因素披露       | 相关性分析主动声明未控制材料/模型差异，不把相关当因果                          |
| 计价口径随报告披露 | `COST_PROFILE` 带 `source`，报告里连同出处一起给出                             |

### 4.2 报告契约

前端规则引擎、后端规则引擎、云端 provider **必须产出同构结构**：

```js
{
  schemaVersion: 1,
  title, verdict,
  confidence: "high" | "medium" | "low" | "insufficient-data",
  sections: [{ h, lines[] }],
  chart: { kind: "bar-rate"|"bar-value"|"line", title, items: [{label, value, hint, weak?}] } | null,
  highlight: { type: "machine", id } | null,
  intent, intentMatched, rowCount, elapsedMs,
  provenance: { source, synthetic, badge, note, generator, datasetKey, rowCount },
  engine: "local-rules" | "server-rules" | "infinisynapse",
  taskId?, upstreamTaskId?,
}
```

⚠ **已知缺口**：云端通道当前只返回文字，`chart` 与 `highlight` 恒为 `null`——
接上真 AI 反而功能更少。报告里会如实写出该缺口。
`[计划 P3.6]` 让 LLM 只负责 planner + narrator，图表与 highlight 由本地统计核生成。

### 4.3 数据来源契约（provenance）

```js
{
  source: "synthetic" | "simulator" | "user-upload",
  synthetic: boolean,     // true 时 UI 必须显示醒目标记
  badge: string,          // 界面上的短标记文字
  note: string,           // 一句话说明这份数据是什么
  generator: { name, version, seed } | null,
}
```

规则：**`synthetic: true` 的数据集，在数据接入区、报告头、分享页都必须显示标记。**
任何界面都不得让合成数据看起来像真实产线数据。

### 4.4 生产数据模型

| 字段              | 含义         | 备注                                                                                            |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `job_id`          | 任务 ID      |                                                                                                 |
| `date`            | 日期         | `YYYY-MM-DD`                                                                                    |
| `machine_id`      | 机台编号     | 仿真采集时取自 `printer.MODEL_TAG`                                                              |
| `model_name`      | 模型名       |                                                                                                 |
| `material`        | 材料         | PLA / PETG / ABS / TPU                                                                          |
| `layer_height_mm` | 层高         |                                                                                                 |
| `duration_min`    | 耗时（分钟） |                                                                                                 |
| `filament_g`      | 耗材克重     |                                                                                                 |
| `cost_fen`        | 成本         | **以「分」为最小单位的整数**，展示层转元，避免浮点误差。上传时也接受 `cost_cny`（元），自动换算 |
| `status`          | 结果         | `success` / `fail`                                                                              |
| `fail_reason`     | 故障类型     | 见 `FAULT_TAXONOMY`                                                                             |
| `energy_kwh`      | 能耗         |                                                                                                 |

CSV 表头支持中英文宽松匹配，见 `HEADER_ALIAS`。

**故障词表**：`FAULT_TAXONOMY` 是仿真侧与分析侧的单一真源，5 类故障现已**全部可由物理涌现**
（见 §3.4）。归一化统一走 `FXInsightData.normalizeFault()`；无法归类的一律记为
`FAULT_UNKNOWN`，**绝不猜成某个具体故障**。

### 3.4 故障机理（`js/machine-profile.js`）

**故障不是抽样出来的。** 每台机器有一组由机台编号确定性派生的固有物理特征，
仿真按这些特征演化，故障是物理量越过报警阈值的结果。

| 特征                   | 含义                | 影响路径               |
| ---------------------- | ------------------- | ---------------------- |
| `hotendFouling`        | 热端积碳/内壁粗糙度 | 挤出阻力基线 ↑         |
| `feederGrip`           | 送料齿轮咬合力      | 打滑风险基线 ↑         |
| `spoolDrag`            | 料架转动阻力        | 抽料需求 ↑             |
| `heaterHealth`         | 加热器有效功率      | 稳态温度上限 ↓         |
| `ambientC` / `draft`   | 环境温度 / 风扰     | 首层附着 ↓             |
| `enclosed` / `buildMm` | 腔体结构 / 幅面     | **由机型决定，不随机** |

标定原则（重要）：**磨损本身不制造故障，它只让机器易感**。
积碳严重的机器在合适的温度与流量下应当能跑完；只有再叠加「温度不足」或「流量过大」
才越线——而同样的工况在干净机器上仍然安全。这个差异正是数据分析要发现的东西。
有测试专门断言这一点（`tests/farm.test.js` §3 §4）。

五条涌现路径：

| 故障     | 阶段       | 机理                                                                             |
| -------- | ---------- | -------------------------------------------------------------------------------- |
| 堵料     | 运行中     | 积碳 × 温度不足 × 体积流量过大 → 挤出负载 > 1，持续 6s 机时                      |
| 断料     | 运行中     | 咬合力不足 × 料架阻力 × 料盘将空 → 打滑风险 > 1，持续 6s                         |
| 热失控   | 运行中     | 加热器功率不足 → 够不到目标 → 温度偏差 >15°C 持续 3s；预热阶段则触发加热失败保护 |
| 翘边     | 完成时判废 | 床温低于材料下限 × 环境冷有风 × 收缩率 × 大平面 × 首层不均                       |
| 悬垂塌陷 | 完成时判废 | 需支撑未开启（确定性失败），或冷却/层高/速度不足                                 |

前三类由监测器在打印过程中发现（任务中止）；后两类在打印完成时评估——
机械上跑完了但零件报废，真实产线正是这样记录的。

**监测器的共同设计**：只观测真实物理量，不注入故障；超阈值需**持续**足够久才报警
（瞬时尖峰不算，与真实固件一致）；正在有效回温时不计入（排障期不误报）。

### 3.5 虚拟机群（`tools/farm-sim.js`）

仿真状态机不依赖 DOM/THREE，`tools/headless-sim.js` 提供桩打印机后即可在 node 中
批量运行。虚拟机群据此产出生产数据集：

```bash
node tools/farm-sim.js --machines 8 --jobs 400 --seed 20260726   --out datasets/farm.csv --json datasets/farm-telemetry.json --emit-js js/farm-dataset.js
```

- **随机只用于排产**（派给哪台机、什么材料与参数）——真实产线本来就有的订单多样性；
- **成败与故障类型完全由物理决定**，同 seed 逐行可复现；
- `--emit-js` 产出前端可内联加载的数据模块：前端要保持 `file://` 直开，
  那个协议下 fetch 本地文件会被拦截，内联成经典脚本是唯一不牺牲该特性的方案。

数据集说明见 [`datasets/README.md`](../datasets/README.md)。

### 3.6 P5 扩展契约

#### 真实 G-code 复盘

`gcode-parser.js` 把真实切片器输出归一成与 `FXSlicer.slice()` 相同的
`layers → paths → pts` 结构。每条路径额外保留 `filamentMm`，因此回放时耗材记账使用
文件里的真实 E 增量，而不是再次按路径宽高估算。

```text
G-code commands
  ├─ motion / E / comments → normalized layers and paths
  ├─ slicer claims         → claimed vs computed reconciliation
  └─ machine log JSON/CSV  → planned vs actual comparison
                               ↓
                     2D preview / 3D replay / simulation
```

坐标原点由 machine profile 决定：常规笛卡尔机型默认床角原点，Delta 使用中心原点。
圆弧当前只按端点直线近似；固件宏、压力提前、输入整形与真实加速度不在模拟范围内。

#### Profile bundle

`profile-registry.js` 只消费声明式数据。machine profile 必须选择 `corexy`、`i3`、
`delta` 或 `gantry` 基座；material profile 声明温度、密度、速度、体积流量、风扇、
收缩和参考价格；价格会带来源进入成本分析口径。schema 与运行时共同执行：

- 字段白名单与数值范围；
- 内置 ID 防覆盖；
- 参数来源必填；
- 未知运动学拒绝；
- 不执行字符串代码，不加载远程脚本。

社区机型使用对应基座 3D 外观，构建空间与物理参数进入仿真；这不是目标设备的精确 CAD。
完整契约见 [`profiles/README.md`](../profiles/README.md)。

#### 数据集 manifest

每个可分发数据集使用 `*.manifest.json` 声明 provenance、license、privacy、生成命令、
文件 SHA-256、表头与行数。`tools/validate-ecosystem.js` 在 `npm test` 中核验仓库状态。
manifest 证明文件和声明一致，但不能单独证明内容的现实来源。

---

## 5. 后端

### 5.1 为什么是原生 http 而非框架

接口面适中（业务 API + SSE + 静态托管 + 健康与指标端点），原生实现完全够用；零依赖让任何人
clone 后 `node server/index.js` 即起——无 install、无供应链风险，与前端「零构建直开」
理念一致。`services/*` 与框架无关，若后续需要框架生态，仅需替换 `index.js` 与 `routes/*`。

### 5.2 目录

```
server/
  index.js         启动、路由、CORS、限流、健康检查、指标、优雅停机
  config.js        读取 server/.env；provider 选择与降级策略
  routes/
    analyze.js     分析任务 + SSE 进度流 + 轮询兜底
    datasource.js  数据源上传（JSON 携带 CSV 文本）
    knowledge.js   知识文档登记 + 检索预览
    share.js       分享页生成 / 撤销 + 服务端渲染公开页
  services/
    providers.js   local / InfiniSynapse / OpenAI-compatible provider 抽象
    infini.js      InfiniSynapse 客户端
    local-engine.js 直接 require 前端纯逻辑模块（单一真源）
    brief.js       将本地统计事实压缩为定长分析简报
    retrieval.js   中文 bigram + BM25 知识检索
    analysis.js    任务编排：SSE / provider / 缓存 / 配额 / 降级
    datasource.js / knowledge.js / share.js   文件存储 + TTL
  lib/
    store.js       原子文件存储 / TTL / 容量淘汰 / 损坏容错
    auth.js        API Key 认证与调用方标识
    quota.js       AI 并发、队列与每日额度
    logger.js      结构化 JSON 行日志（reqId + taskId 贯穿）
    http.js        限长 body / SSE / 静态 allowlist（防路径穿越）
```

### 5.3 对外接口

| 方法/路径                       | 入参                                                                | 出参                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /api/analyze`             | `{question, datasourceId}`（question ≤500 字；缺省数据源 `sample`） | `202 {taskId, engine}`                                                                                |
| `GET /api/analyze/:id/stream`   | —                                                                   | SSE `{seq, stage, message, progress}`，终事件 `{done:true}`。事件全量缓存，断线重连/晚接入可重放      |
| `GET /api/analyze/:id/result`   | —                                                                   | `200 报告` / `202 running` / `502 失败`                                                               |
| `GET /api/analyze/:id`          | —                                                                   | 轮询兜底 `{status, progress, message}`                                                                |
| `POST /api/datasource`          | `{name, csv}`                                                       | `201 {datasourceId, rows, warnings?}`                                                                 |
| `POST /api/knowledge`           | `{name, text}`                                                      | `201 {knowledgeId, retrievalEnabled, note}`                                                           |
| `POST /api/knowledge/search`    | `{question}`                                                        | 检索预览命中及 provider 能力说明                                                                      |
| `POST /api/share/:taskId`       | —                                                                   | `201 {publicUrl, revokeKey, expiresAt}`                                                               |
| `POST /api/share/:token/revoke` | `{revokeKey}`                                                       | 撤销公开分享页                                                                                        |
| `GET /share/:token`             | —                                                                   | 公开分享页（服务端渲染，零脚本）                                                                      |
| `GET /healthz`                  | —                                                                   | provider、能力、配额与持久化状态                                                                      |
| `GET /metrics`                  | —                                                                   | Prometheus 文本指标                                                                                   |
| `GET /`（静态）                 | —                                                                   | allowlist：`index.html` / `README.md` / `css/` / `js/` / `doc/samples/`。`server/` 与 `.env` 永不可达 |

### 5.4 Provider 选择与自动降级

```
ANALYSIS_PROVIDER=auto（默认）
  → InfiniSynapse 已配置且核准：infinisynapse
  → 否则 OpenAI-compatible endpoint 已配置：openai
  → 否则：local rules

也可显式指定 local / infinisynapse / openai。
配置不完整、启动探活失败、额度耗尽或云端叙述失败时，保留本地统计产物并说明降级原因。
```

本地统计核始终负责数字、图表、证据和视口高亮；AI provider 只组织叙述，不覆盖已核验事实。

### 5.5 生产控制

| 控制     | 当前实现                                                          |
| -------- | ----------------------------------------------------------------- |
| 持久化   | 默认写入 `data/`；可通过 `DATA_DIR` 指定目录或显式退回纯内存      |
| 鉴权     | `API_KEYS` + `REQUIRE_AUTH`，支持 Bearer 与 `X-API-Key`           |
| 成本     | AI 并发、队列、调用方日额度、全局日额度；规则引擎不受 AI 额度限制 |
| 缓存     | 相同问题 + 数据集 + provider 命中结果缓存，减少重复计费           |
| 可观测性 | JSON 行日志、`/healthz`、`/metrics`                               |
| 分享     | 持久化快照、过期时间、撤销密钥                                    |

---

## 6. AI Provider 集成

### 6.1 Provider 边界

| Provider        | 用途                                      | 配置                                                  |
| --------------- | ----------------------------------------- | ----------------------------------------------------- |
| `local`         | 确定性统计与规则叙述；默认、无外部计费    | `ANALYSIS_PROVIDER=local`                             |
| `infinisynapse` | InfiniSynapse 任务式分析叙述              | `INFINI_API_KEY` + `INFINI_VERIFIED=1`                |
| `openai`        | OpenAI / Azure / Ollama / vLLM 等兼容端点 | `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL` |

所有 provider 返回同构报告。云端只接收本地生成的统计简报与相关知识片段，不接管数值计算。

### 6.2 InfiniSynapse 时序

```text
生成 connId → 先订阅上游 SSE → 创建任务
  → 推送本地统计简报与检索片段
  → 接收进度与 completion_result
  → 提取叙述 → 与本地图表 / 证据 / highlight 合并
  → 失败时保留本地完整报告并标注原因
```

OpenAI-compatible provider 使用 `/chat/completions` 风格端点，复用同一份统计简报、知识检索与报告合并逻辑。

---

## 7. 测试

| 套件                             | 覆盖                                                                  | 断言数  |
| -------------------------------- | --------------------------------------------------------------------- | ------- |
| `tests/smoke.js`                 | 切片引擎：几何工具 / 填充 / 等值线 / 三模型切片 / 变换                | 32      |
| `tests/sim-calib.test.js`        | 仿真核心：床面误差场 / 调平数据链自洽 / 全流程状态机 / 遥测与实测质量 | 44      |
| `tests/exporter.test.js`         | 导出：三角提取 / 二进制 STL 结构 / OBJ / G-code 语义与挤出量守恒      | 24      |
| `tests/gcode.test.js`            | G-code：往返守恒 / 方言 / E 模式 / 原点 / 错误与对账                  | 51      |
| `tests/machine-log.test.js`      | 真机日志：JSON/CSV 归一 / 任务责任链 / 计划实测比较 / 边界            | 14      |
| `tests/time-calibration.test.js` | 时间校准：稳健拟合 / 异常点 / 配对观测 / 防御性边界                   | 17      |
| `tests/profiles.test.js`         | Profile：schema 对齐 / 白名单 / 防覆盖 / 价格与物理特征接线           | 20      |
| `tests/stats.test.js`            | Wilson / Fisher / 偏相关 / Mann–Kendall / 证据表述                    | 75      |
| `tests/insight.test.js`          | 洞察：数据 / 解析 / 统计守卫 / 来源标记 / 统计严谨性                  | 88      |
| `tests/farm.test.js`             | 虚拟机群：确定性 / 故障机理 / 效应调转 / 遥测贯通                     | 48      |
| `tests/server.test.js`           | 后端契约：provider / SSE / 持久化 / 检索 / 分享 / 鉴权 / 配额 / 指标  | 159     |
| `tests/check-refs.js`            | HTML ↔ JS 的 DOM id 引用交叉校验                                      | —       |
| `tools/validate-ecosystem.js`    | Profile、日志、数据集 schema / 哈希 / 表头 / 行数                     | 17 检查 |
| `tools/validate-fixtures.js`     | G-code/日志配对、来源、SHA-256、训练/holdout 与校准报告               | 61 检查 |
| `tools/release-audit.js`         | 版本、缓存键、文档、provenance 与三浏览器 CI 一致性                   | 13 检查 |
| `tests/deploy-check.js`          | 部署后线上冒烟（需公网 URL）                                          | 10      |
| `tests/e2e/*.spec.js`            | Chromium 全量；Firefox/WebKit 启动与真实任务复盘关键链路              | 24 场景 |

`sim-calib` 用 **stub 打印机**在 Node.js 中驱动完整状态机；`farm.test.js` 在此基础上验证虚拟机群与故障机理。

**测试原则**：断言引擎的**性质**，不断言「生成器埋了什么就挖出什么」。
详见 `tests/insight.test.js` 头注与 `CONTRIBUTING.md`。

核心逻辑与服务契约共 572 项断言，另有 17 项生态、61 项夹具和 13 项发布一致性检查；
DOM 层共有 24 个 Playwright 浏览器场景。

---

## 8. 设计决策记录

| 决策             | 选择                                 | 理由                                                                                             |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| three.js 版本    | **r152**（不升级）                   | 最后一个官方完整支持 WebGL1 自动回退的版本。老集显 / 虚拟机 / 远程桌面能开，是工业场景的真实需求 |
| 前端模块化       | 经典脚本 + `window` 全局（**待改**） | 换来 `file://` 直开。代价是贡献者门槛高，`[计划 P1]` 新模块用 ESM 渐进迁移                       |
| 后端框架         | 原生 `http`                          | 见 §5.1                                                                                          |
| 金额存储         | 整数「分」                           | 避免浮点误差                                                                                     |
| 分析逻辑归属     | 前端纯逻辑模块，后端 require         | 单一真源，前后端引擎永不漂移                                                                     |
| 引擎命名         | `rules` 而非 `mock`                  | 「mock」暗示结果是编的，实际是真实计算，只是没有 AI 参与                                         |
| 规则引擎人造延时 | 默认 0                               | 拖慢进度条让它「看起来在思考」属于欺骗性 UI                                                      |
