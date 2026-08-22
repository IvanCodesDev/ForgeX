<div align="center">
  
<img width="125" height="125" alt="exec-ab8574a0-a8eb-47a1-adb1-ff8c6883b54f" src="https://github.com/user-attachments/assets/e27d2fef-d894-4958-a884-8a996f8ee131" />


  <h1>FORGE·X Insight</h1>

  <p><strong>面向 FDM 3D 打印的预演、G-code 复盘与生产数据分析工具</strong></p>

  <p>
    <a href="https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml"><img src="https://github.com/IvanCodesDev/ForgeX/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/version-1.0.0-2563eb" alt="Version 1.0.0">
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.13-16a34a" alt="Node.js ≥22.13">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f97316" alt="Apache-2.0 License"></a>
  </p>

  <p><strong>简体中文</strong> · <a href="./.github/README.en.md">English</a></p>
</div>

FORGE·X Insight 把“打印前检查”和“打印后复盘”放进同一个工作台：你可以导入模型或真实 G-code，逐层查看路径、比较参数、估算时间与耗材，再用设备日志和生产任务数据验证结果。

它不会直接控制打印机，也不能代替首件试打；它更适合在正式打印前排除明显问题，并把每次真机结果沉淀为下一次决策的依据。

<img width="1440" height="900" alt="workbench-overview" src="https://github.com/user-attachments/assets/36a2ee5c-753d-4d6f-ad22-29da43959be5" />


## 它能帮你做什么

- **打印前预演**：调整层高、填充、速度、温度、回抽和支撑，观察路径与估算结果如何变化。
- **真实路径复盘**：解析 Cura、PrusaSlicer、OrcaSlicer、SuperSlicer 等常见 G-code，按层查看周界、填充、支撑、空驶和挤出路径。
- **计划与实测对账**：通过 SHA-256 绑定 G-code 与真机日志，对比预计/实际时长、耗材、层数和任务状态。
- **生产数据分析**：导入 CSV，查看机台故障率、材料失败率、成本趋势、批次共性以及统计证据。
- **可审计校准**：按机型、固件和材料管理时间校准模型，保留数据来源、样本门槛和漂移记录。

## 快速开始

### 方式一：零安装体验（推荐新手）

直接双击仓库根目录的 `index.html`。经典工作台可通过 `file://` 离线运行，不需要安装依赖，也不会连接打印机。

想快速走完一遍流程，可使用 [`demo/`](./demo/) 中已经准备好的合成演示素材。

### 方式二：启动完整本地服务

需要 [Node.js 22.13+](https://nodejs.org/)：

```bash
npm ci
npm run frontend:build
npm start
```

启动后可访问：

- [http://127.0.0.1:8787](http://127.0.0.1:8787)：经典工作台；
- [http://127.0.0.1:8787/react/](http://127.0.0.1:8787/react/)：React + TypeScript 工作台。

### 方式三：前端开发模式

分别打开两个终端：

```bash
# 终端 1：启动 API 服务
npm start

# 终端 2：启动 Vite 开发服务器
npm run frontend:dev
```

然后访问 [http://127.0.0.1:5173](http://127.0.0.1:5173)。Vite 会将 API 请求代理到 `127.0.0.1:8787`。

## 第一次使用：5 分钟走完核心流程

1. 打开顶部的 **模型**，导入 `demo/replay/03-demo-turbine.gcode`。
2. 进入 **切片**，拖动层滑块，检查 2D 路径与打印机平台上的 3D 路径是否符合预期。
3. 回到 **模型**，追加 `demo/replay/04-demo-machine-log.json`，查看计划值与真机记录的差异。
4. 打开 **洞察**，上传 `demo/insight/06-demo-production.csv`。
5. 选择示例问题或输入“哪台机故障率最高，主要故障是什么”，查看结论、置信区间和计算依据。

> `demo/` 中的数据均为可复现的合成素材，只用于体验功能，不代表真实设备或真实产线表现。

## 界面预览

### 逐层检查 G-code

导入 G-code 后，可以选择任意层，同时查看二维路径统计和三维平台上的实际位置。

<img width="1440" height="900" alt="gcode-layer-replay" src="https://github.com/user-attachments/assets/bf066a27-992f-4ef8-9ca0-fa828e4c6de1" />


### 用真机记录校验预测

日志只有在声明的 G-code SHA-256 与当前文件匹配时才会进入对账，避免把不同任务的数据误配到一起。系统会保留切片器声明值、本地重算值和真机实测值，不用单一数字覆盖其他证据。

### 分析生产任务数据

上传 CSV 后，可从机台、材料、时间、成本和故障类型等角度分析任务；报告会同时展示样本量、统计显著性、置信区间和来源标记。

<img width="1440" height="900" alt="production-insight" src="https://github.com/user-attachments/assets/e3522857-29cf-48a6-80b2-65b88ab1a381" />


## 支持的输入与输出

| 类型           | 支持内容                                                    |
| -------------- | ----------------------------------------------------------- |
| 模型来源       | 图片浮雕/剪影、内置参数化模型                               |
| 路径输入       | 常见 Marlin 风格 G-code，兼容主流切片器的常用注释与挤出模式 |
| 设备记录       | FORGE·X JSON、常见 CSV 日志                                 |
| 生产数据       | 带来源标记的 CSV 任务数据                                   |
| Profile / 校准 | 声明式 JSON 机器、材料 Profile 与校准包                     |
| 导出           | STL、OBJ、G-code、分析 JSON/CSV 与分享快照                  |

示例、字段说明和校验规则位于 [`contracts/`](./contracts/)；可直接导入的演示文件位于 [`demo/`](./demo/)。

## 工作原理

```text
浏览器工作台
├─ 模型与参数 → 切片预演 → 2D / 3D 路径回放
├─ G-code + 真机日志 → SHA-256 配对 → 计划/实测对账
└─ 生产 CSV → 确定性统计核 → 图表、证据与报告
          │
          ▼
Node.js 服务（身份、存储、分享、代理）
          │ 可选权威计算
          ▼
.NET 10 服务（流式 G-code、异步任务、分析与校准）
```

默认文件存储适合本地体验；部署环境可切换到 PostgreSQL。AI 不是基础功能的前置条件：聚合、统计检验、图表和规则报告均可由确定性计算完成；配置 AI provider 后，它只根据已经核算的结果组织叙述，不重算或覆盖证据。

## 项目结构

```text
frontend/     React + TypeScript 工作台，以及经典界面资源
server/       Node.js HTTP 服务、身份、存储和代理
backend/      .NET 10 计算核心与 API
contracts/    数据 schema、示例、Profile、日志和校准契约
demo/         新手演示素材与录制脚本
deploy/       Docker、SLO、告警和运维说明
doc/          开发与优化文档
tests/        单元、契约和端到端测试
tools/        生成、校验和维护脚本
```

## 开发与验证

日常开发最常用的命令：

```bash
npm run frontend:typecheck  # TypeScript 类型检查
npm run frontend:test       # 前端单元测试
npm test                    # Node、契约与核心逻辑测试
npm run test:e2e:chromium   # Chromium 端到端测试
npm run check               # 完整静态检查与测试门禁
npm run docs:screenshots    # 重新生成本 README 的界面截图
```

涉及 .NET 权威计算、PostgreSQL、容器或发布流程时，请使用 `package.json` 中的对应专项命令；环境配置、健康检查和回滚流程见 [`deploy/README.md`](./deploy/README.md)。

## 部署

最短的 Docker Compose 启动流程：

```bash
copy deploy\.env.example deploy\.env
docker compose -f deploy/docker-compose.yml up -d
```

正式部署前必须为内部服务配置至少 32 字节的随机密钥，并按文档完成健康检查、备份和回滚验证。详见 [`deploy/README.md`](./deploy/README.md)。

## 使用边界

- 内置数据和演示数据均有明确的合成来源标记，不能作为真实打印精度证明。
- 浏览器估算、切片器声明值和真机实测值可能采用不同口径，界面会并列呈现差异。
- 导出的制造文件进入实体设备前，仍需使用目标切片器、固件配置和设备安全流程复核。
- 项目不直接连接或控制实体打印机，也不对未经真机验证的参数作生产安全承诺。

## 常见问题

<details>
<summary><strong>直接打开 index.html 后，哪些功能不可用？</strong></summary>

本地切片预演、G-code 解析、路径回放和本地规则分析可以使用；登录、服务端持久化、分享、知识检索和可选 AI 叙述需要启动 Node.js 服务。

</details>

<details>
<summary><strong>为什么同时保留经典工作台和 React 工作台？</strong></summary>

经典工作台是稳定、可离线直开的完整基线；React 工作台承载正在迁移的新界面和权威计算接入。两者共用核心契约，并通过端到端测试校验关键行为。

</details>

<details>
<summary><strong>它能替代 Cura、OrcaSlicer 或 PrusaSlicer 吗？</strong></summary>

不能。FORGE·X 更偏向预演、比较、复盘和证据分析；正式制造文件仍应在目标切片器和真实设备流程中验证。

</details>

## 继续阅读

- [演示素材与推荐顺序](./demo/README.md)
- [贡献指南](./.github/CONTRIBUTING.md)
- [部署与运维](./deploy/README.md)
- [版本记录](./CHANGELOG.md)
- [安全政策](./.github/SECURITY.md)

## License

Apache License 2.0，详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。
