# FORGE·X Insight

### 让每一次打印，都成为可观察、可复现、可分析的数字实验

[![CI](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml/badge.svg)](https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.18.0-2563eb)
![Node](https://img.shields.io/badge/Node.js-%E2%89%A518-16a34a)
![Runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f172a)
[![License](https://img.shields.io/badge/license-Apache--2.0-f97316)](./LICENSE)

**简体中文** · [English](./README.en.md)

**FORGE·X Insight** 是一个开源、本地优先的 FDM 3D 打印数字实验与生产分析平台。它把模型处理、切片、G-code 可视化、设备仿真、真机日志、时间校准和统计分析连接成一条可追溯工作流。

直接打开网页即可离线运行；启动零运行时依赖的 Node.js 服务后，还可获得持久化、分享、知识检索、API Key 鉴权、校准审核发布和可选 AI 叙述。核心仿真、统计计算与证据生成不依赖云服务。

## 它解决什么问题

| 常见痛点                         | FORGE·X 的处理方式                                                |
| -------------------------------- | ----------------------------------------------------------------- |
| 仿真只是动画，结果无法复盘       | 路径、遥测、事件、质量报告和生产记录来自同一条运行时数据链        |
| G-code、切片器估时与真机日志割裂 | 逐层 2D/3D 回放，配对日志对比，并用 holdout 验证时间校准模型      |
| 分析只给结论，无法判断是否可信   | 保留来源、样本量、置信区间、显著性、图表和可执行建议              |
| 校准模型发布后缺少治理           | API Key 双人复核、禁止自批、原子发布、版本审计和后续漂移停用      |
| 云端 AI 成为运行前提             | 本地规则与统计核默认可用，AI 仅负责可选叙述，不改写计算得到的证据 |

## 核心能力

### 从模型到洞察的一体化流程

`模型/真实 G-code → 路径预览 → 设备校准 → 过程回放 → 质量评估 → 生产洞察`

- **模型准备**：内置参数化模型、摆放与缩放、图片浮雕和剪影建模。
- **路径切片**：周界、顶底实心层、扫描线填充、支撑与裙边；任意层路径可在 2D/3D 中同步预览。
- **真实任务复盘**：导入 Cura、PrusaSlicer、OrcaSlicer 与 SuperSlicer 常见方言，保留真实 E 增量逐层回放，并与切片器声明和真机任务日志并列对比。
- **时间校准**：版本化候选包经 API Key 双人审核后发布，按机型、固件和材料精确匹配；只有真实来源且通过至少五个 holdout 的 `active` 模型会自动生效，后续任务持续检查误差和漂移。
- **设备仿真**：CoreXY、i3、Delta 与大幅面龙门四套运动学，覆盖预热、调平、打印、暂停、恢复和完成状态。
- **过程监控**：喷嘴/热床温度、耗材、负载、进度和事件时间线实时更新。
- **质量评估**：基于本次任务的温度偏差、调平残差、速度变化与故障记录生成质量报告。
- **生产洞察**：围绕机台、材料、层高、成本和失败批次生成可解释的分析结果。

## 为什么是 FORGE·X

### 物理过程驱动

切片路径、热惯性、床面误差、调平补偿和挤出量均由运行时计算。热失控演练会改变加热器状态并由监测链路识别，其余故障演练用于验证报警与恢复流程，适合教学、方案验证和工艺讨论。

### 仿真与数据同源

单机任务可以直接沉淀为生产记录；虚拟机群工具能够以固定 seed 批量生成可复现的数据集。分析层读取的是同一条数据链，而不是另一套孤立的展示数据。

### 开放配置，有边界

机器与材料 Profile 使用声明式 JSON：社区可以扩展构建空间、温度、密度、流量、收缩、参考价格与物理特征，但不能注入代码、覆盖内置 ID 或声明尚未实现的运动学。数据集 manifest 同步记录来源、许可证、隐私状态、复现命令与文件哈希。

### 校准结果可运营

G-code 与真机日志通过 SHA-256 绑定；校准包继续记录训练集指纹、来源、作用域、版本、holdout 指标和启用阈值。服务端保留提交、审核、拒绝与发布审计事件，禁止提交者自批。后续配对任务会形成 `stable`、`warning` 或 `drift` 状态，漂移模型停止自动匹配。仓库内置示例明确标为合成演示，不作为生产精度证明。

### 统计结果可解释

分析报告保留样本量、置信区间、显著性与数据来源。内置统计核覆盖 Wilson 区间、Fisher 精确检验、偏相关和 Mann–Kendall 趋势检验，并对样本不足与混杂因素给出明确提示。

### 本地优先，AI 可选

默认规则引擎可在无密钥、无外部请求的环境中完成统计分析。接入 InfiniSynapse 或 OpenAI 兼容服务后，AI 负责组织叙述，报告中的数字、图表和证据仍由本地统计链路生成。

## 快速开始

### 直接体验

直接打开 `index.html`，无需安装依赖、无需联网。

### 启动完整服务

```bash
node server/index.js
# 或
npm start
```

访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

服务模式额外提供：

- 数据源、知识文档、分享页和用量信息持久化；
- 分析任务进度与结果缓存；
- API Key 鉴权、AI 并发与每日额度保护；
- `/healthz` 健康检查和 `/metrics` Prometheus 指标；
- 校准候选提交、双人审核、原子发布与浏览器只读同步。

> Node.js 仅需 18 或更高版本。应用运行时没有 npm 依赖；ESLint、Prettier 与 Playwright 仅用于开发和测试。

## 数据分析

### 数据入口

| 来源             | 用途                         |
| ---------------- | ---------------------------- |
| 内置虚拟机群数据 | 开箱即用地体验完整分析链路   |
| CSV 上传         | 分析自有生产任务记录         |
| 仿真任务采集     | 将当前打印过程沉淀为生产记录 |

内置数据与仿真采集数据会携带来源标记，上传数据保持独立的 provenance，报告和分享页沿用同一来源信息。

### 分析维度

1. 机台故障率排行与归因
2. 材料失败率对比
3. 层高与打印时长关系
4. 成本趋势与构成
5. 失败批次归因

每份报告由结论、证据、图表、可信度和可执行建议组成；当问题不属于已有分析维度或证据不足时，界面会提供可继续探索的方向。

## 仿真与导出

| 能力           | 实现                                                                  |
| -------------- | --------------------------------------------------------------------- |
| 切片           | 周界偏置、奇偶规则扫描线填充、实心层、支撑、裙边                      |
| G-code 复盘    | 常见 Cura/Prusa 注释、绝对/相对 E、床角/中心原点、2D/3D 逐层回放      |
| 真机日志与校准 | 标准 JSON 或常见 CSV；版本化 bundle、精确作用域、holdout 准入与漂移   |
| 温控与调平     | 热惯性模型；3×3 探测、5×5 补偿网格、打印时双线性插值                  |
| Profile 扩展   | 机器/材料 JSON bundle、schema、白名单、范围校验、参考价格与本地持久化 |
| 网格/路径导出  | 二进制 STL、ASCII OBJ、Marlin 风格 G-code                             |

导出的制造文件应在进入实体设备工作流前，使用目标切片器、固件配置和设备安全流程再次校验。

## 技术架构

```text
Browser
├─ 3D scene / printer kinematics / print animation
├─ slicer / G-code replay / machine-log comparison / time calibration
├─ profile + calibration registries / reviewed releases / simulator
├─ statistics kernel / insight engine / fleet view
└─ API client
        │
        ▼
Node.js service
├─ datasource / analysis / knowledge / share / calibration review
├─ file store / cache / auth / quota / metrics
└─ providers
   ├─ local rules
   ├─ InfiniSynapse
   └─ OpenAI-compatible endpoint
```

- **前端**：Three.js r152 + 原生 JavaScript，零构建即可运行。
- **后端**：Node.js 原生 `http`，零运行时依赖。
- **存储**：默认写入 `data/`；容器部署通过卷保留数据。
- **安全**：静态资源 allowlist、路径穿越防护、可选 API Key、AI 成本闸门。

## 验证

```bash
npm test             # 622 项核心/服务断言 + 17 项生态、61 项夹具、22 项校准、25 项发布检查
npm run test:e2e     # 26 个浏览器场景：Chromium 全量 + Firefox/WebKit 关键链路
npm run validate:fixtures
npm run validate:calibrations
npm run release:check
npm run lint
npm run format:check
```

测试覆盖切片、G-code、真机日志、时间校准、Profile、调平、仿真状态机、导出、统计核、洞察引擎、虚拟机群、数据集完整性、后端契约以及三浏览器关键界面流程。

P6 方言夹具与真实数据贡献流程见 [`validation/README.md`](./validation/README.md)；
P7/P8 校准包格式、准入、审核发布和漂移生命周期见 [`calibration/README.md`](./calibration/README.md)。
内置报告和 bundle 都是 `synthetic-conformance`，不会自动用于用户任务。

部署后可执行：

```bash
node tests/deploy-check.js https://your-domain.example
```

## 部署

### Docker Compose

```bash
docker compose up -d
```

默认不配置外部 AI 服务，直接使用本地分析引擎。`docker-compose.yml` 已配置持久化卷。

### Node

```bash
copy server\.env.example server\.env
node server/index.js
```

常用环境变量：

| 变量                                      | 说明                                         |
| ----------------------------------------- | -------------------------------------------- |
| `ANALYSIS_PROVIDER`                       | `auto`、`local`、`infinisynapse` 或 `openai` |
| `DATA_DIR`                                | 持久化目录；未设置时默认为项目下的 `data/`   |
| `API_KEYS` / `REQUIRE_AUTH`               | API Key、全局鉴权及双 key 校准审批           |
| `AI_CONCURRENCY` / `AI_QUEUE_MAX`         | AI 并发与排队上限                            |
| `AI_DAILY_PER_CALLER` / `AI_DAILY_GLOBAL` | 调用方与实例级每日额度                       |
| `PUBLIC_BASE`                             | 分享链接的公网地址前缀                       |

完整配置见 [`server/.env.example`](./server/.env.example)，安全建议见 [`SECURITY.md`](./SECURITY.md)。

## 项目结构

```text
css/                  interface design system
js/                   simulation, slicing, analytics and UI
server/               HTTP service, providers and platform controls
datasets/             reproducible virtual-farm datasets
profiles/             machine/material profile schema and examples
logs/                 machine-log schema and examples
validation/           paired G-code/log fixtures and calibration reports
calibration/          versioned calibration bundle schema and demonstration
tools/                headless simulation and dataset generation
tests/                unit, contract and end-to-end tests
```

## 项目定位

FORGE·X Insight 面向数字仿真、工艺探索、教学演示和生产数据分析。它可以输出制造文件，但不直接连接或控制实体打印机。

版本变化见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 参与贡献

请先阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。提交功能时需同步测试与用户文档，并确保界面描述可以由当前实现直接验证。

## License

Apache License 2.0，详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。
