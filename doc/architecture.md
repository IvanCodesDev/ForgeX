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
       ├─ sim.js       仿真状态机
       ├─ exporter.js  STL / OBJ / G-code（纯逻辑，node 可测）
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

**故障词表不一致（已知问题）**：`FAULT_TAXONOMY` 有 5 类，但仿真器只能物理产生
断料/堵料/热失控 3 类（`SIM_FAULTS`）。无法归类的一律记为 `FAULT_UNKNOWN`，
**绝不猜成某个具体故障**。`[计划 P2.4]` 统一两侧词表。

---

## 5. 后端

### 5.1 为什么是原生 http 而非框架

接口面很薄（5 组 API + SSE + 静态托管），原生实现完全够用；零依赖让任何人
clone 后 `node server/index.js` 即起——无 install、无供应链风险，与前端「零构建直开」
理念一致。`services/*` 与框架无关，若后续需要框架生态，仅需替换 `index.js` 与 `routes/*`。

### 5.2 目录

```
server/
  index.js         启动、极简路由器、CORS、限流、健康检查、优雅停机
  config.js        读取 server/.env；引擎双模门禁在此判定
  routes/
    analyze.js     分析任务 + SSE 进度流 + 轮询兜底
    datasource.js  数据源上传（JSON 携带 CSV 文本）
    knowledge.js   知识文档登记（⚠ 只存不用，无检索）
    share.js       分享页生成 + 服务端渲染公开页
  services/
    infini.js      InfiniSynapse 客户端（全服务唯一持 key 处）
    local-engine.js 直接 require 前端纯逻辑模块（单一真源）
    analysis.js    任务编排：事件缓存重放 SSE / 引擎路由 / TTL
    datasource.js / knowledge.js / share.js   内存存储 + TTL
  lib/
    logger.js      结构化 JSON 行日志（reqId + taskId 贯穿）
    http.js        限长 body / SSE / 静态 allowlist（防路径穿越）
```

### 5.3 对外接口

| 方法/路径                     | 入参                                                                | 出参                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /api/analyze`           | `{question, datasourceId}`（question ≤500 字；缺省数据源 `sample`） | `202 {taskId, engine}`                                                                                |
| `GET /api/analyze/:id/stream` | —                                                                   | SSE `{seq, stage, message, progress}`，终事件 `{done:true}`。事件全量缓存，断线重连/晚接入可重放      |
| `GET /api/analyze/:id/result` | —                                                                   | `200 报告` / `202 running` / `502 失败`                                                               |
| `GET /api/analyze/:id`        | —                                                                   | 轮询兜底 `{status, progress, message}`                                                                |
| `POST /api/datasource`        | `{name, csv}`                                                       | `201 {datasourceId, rows, warnings?}`                                                                 |
| `POST /api/knowledge`         | `{name, text}`                                                      | `201 {knowledgeId, retrievalEnabled: false, note}` ⚠ 只存不用                                         |
| `POST /api/share/:taskId`     | —                                                                   | `201 {publicUrl}`（快照，进程内 24h）                                                                 |
| `GET /share/:token`           | —                                                                   | 公开分享页（服务端渲染，零脚本）                                                                      |
| `GET /healthz`                | —                                                                   | `{ok, engine: "rules"\|"infinisynapse", reason}`                                                      |
| `GET /`（静态）               | —                                                                   | allowlist：`index.html` / `README.md` / `css/` / `js/` / `doc/samples/`。`server/` 与 `.env` 永不可达 |

### 5.4 引擎双模门禁

```
mode = "infinisynapse"  需同时满足：
  ① INFINI_API_KEY 已配置
  ② INFINI_VERIFIED=1（端点核准通过）
  ③ 未设 INFINI_MOCK=1
否则 mode = "rules"（规则引擎）
```

门禁的作用是**防止未经核准的假设端点进入生产**。
`[计划 P4.7]` 改为启动时自动探活 + 失败自动降级，去掉人工 `INFINI_VERIFIED` 开关。

### 5.5 已知运维缺口（公网部署前必读）

| 缺口                           | 影响                                             | 计划        |
| ------------------------------ | ------------------------------------------------ | ----------- |
| 全内存存储                     | 重启即全丢；分享页失效                           | P4.1 SQLite |
| **无鉴权、无配额、无并发上限** | 公网 + 已配密钥 = 任何人可持续烧维护者的云端额度 | P4.2 / P4.3 |
| 单一防护是同 IP 5s 冷却        | 挡不住分布式请求                                 | P4.3        |
| 分析历史仅前端内存，上限 5 条  | 刷新即失                                         | P4.1        |

---

## 6. InfiniSynapse 集成

### 6.1 两套 API 辨析（容易用错）

| API                                | 地址                                                            | 说明                                                     |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| ❌ GenStudio 纯 LLM（OpenAI 兼容） | `cloud.infini-ai.com/maas/...`                                  | 是「大模型 API」，不是数据智能体                         |
| ✅ InfiniSynapse Server API        | 业务 `app.infinisynapse.cn`、Console `api.infinisynapse.cn/api` | 数据智能体，任务日志在 `app.infinisynapse.cn/tasks` 可查 |

### 6.2 端点（2026-07-21 实测核准）

| 用途                             | 方法/路径                                                                                        | 说明                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 取用户信息                       | `GET {console}/user/profile`                                                                     | 200，`data.userId`                                                                          |
| 事件流（**必须先于建任务订阅**） | `GET {server}/api/ai/events?connId=<uuid>`                                                       | 标准 SSE；事件类型 `message.add/partial/update`、`state.ready`、`notification`、`heartbeat` |
| 创建分析任务                     | `POST {server}/api/ai/message`，body `{type:"newTask", connId, text, chatSettings:{mode:"act"}}` | 201；**taskId 不在响应体**，由 SSE 事件 `data.taskId` 带回                                  |
| 任务终结标志                     | SSE `message.say === "completion_result"` 且 `partial:false`                                     | `text` 即最终结论                                                                           |
| 取产物                           | `GET {server}/api/ai_task/getTaskWorkspace/<taskId>`                                             | `data:{cwd, files[]}`                                                                       |
| ~~任务轮询~~                     | ~~`GET {server}/api/ai_task/tasks`~~                                                             | ❌ 实测 408 超时，弃用；SSE 是唯一进度通道                                                  |

### 6.3 时序（顺序不可颠倒）

```
后端生成 connId → 订阅 SSE（先订阅！反过来会丢早期事件）
  → POST newTask
  → 云端多步执行：inline JSON 建表 → SQL 聚合 → 生成结论（实测 160–230s）
  → completion_result(partial:false) → 解析约定 JSON → 同构报告（失败降级纯文本）
  → getTaskWorkspace 拉产物清单
```

**实测教训**（已固化进 `services/infini.js` 的提示词）：不提示加载方式时，云端会先尝试
创建 `.csv` 文件（平台禁止，白耗 ~45s 才自行改道）；明示「转 inline JSON 用
`execute_infinity_sql` 加载」可直达。任务级超时应 ≥360s。

### 6.4 已知设计债

| 问题                   | 说明                                                | 计划                               |
| ---------------------- | --------------------------------------------------- | ---------------------------------- |
| 整份 CSV 内联进 prompt | token 成本随数据量线性增长，上万行直接超限          | P3.7 改传 schema + 统计摘要 + 采样 |
| 结构化产物靠口头约定   | 「请输出 JSON」写在提示词里，无 schema 校验、无重试 | P3.6                               |
| 单一厂商               | 分析能力硬绑 InfiniSynapse                          | P3.5 `AnalysisProvider` 抽象       |
| 无结果缓存             | 同一问题问两次 = 两次真实云端任务                   | P3.8                               |

---

## 7. 测试

| 套件                      | 覆盖                                                                                                             | 断言数 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| `tests/smoke.js`          | 切片引擎：几何工具 / 填充 / 等值线 / 三模型切片 / 变换                                                           | 32     |
| `tests/sim-calib.test.js` | 仿真核心：床面误差场 / 调平数据链自洽 / 全流程状态机 / 遥测与实测质量                                            | 44     |
| `tests/exporter.test.js`  | 导出：三角提取 / 二进制 STL 结构 / OBJ / G-code 语义与挤出量守恒                                                 | 24     |
| `tests/insight.test.js`   | 洞察：数据 / 解析 / 统计 / **统计守卫** / **来源标记** / **诚实性**                                              | 64     |
| `tests/server.test.js`    | 后端契约：healthz / 静态 allowlist 与路径穿越 / 数据源 / 分析端到端（SSE + 重放 + 轮询）/ 知识库 / 分享页 / 限流 | 46     |
| `tests/check-refs.js`     | HTML ↔ JS 的 DOM id 引用交叉校验                                                                                 | —      |
| `tests/deploy-check.js`   | 部署后线上冒烟（需公网 URL）                                                                                     | 10     |

`sim-calib` 用 **stub 打印机**在 node 里驱动完整状态机——这也是 `[计划 P2]`
虚拟机群的技术基础：仿真状态机本就能无头批量运行。

**测试原则**：断言引擎的**性质**，不断言「生成器埋了什么就挖出什么」。
详见 `tests/insight.test.js` 头注与 `CONTRIBUTING.md`。

`[计划 P1.7]` 补 DOM 层测试——`ui.js`（1000+ 行）与 `insight.js`（500+ 行）当前零覆盖。

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
