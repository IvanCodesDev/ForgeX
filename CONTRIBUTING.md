# 贡献指南 / Contributing

（[English below](#english)）

感谢你考虑为 FORGE·X Insight 做贡献。本项目正处于 **0.x 重构期**，
路线图见 [`doc/优化文档.md`](./doc/优化文档.md)。

---

## 一条硬规则

> **任何 PR 若引入「宣称了但没实现」的文案、注释或文档，一律拒绝合入。**

这不是客套话。本项目的前身是一个比赛作品，代码里曾经有：

- 对调用方返回「已登记，将在分析任务中注入」——而实际上没有任何注入逻辑；
- 一个「在 3D 视口中定位 FX-256-03」的按钮——它忽略参数，闪的是唯一那台打印机；
- 三步进度动画由 `setTimeout` 播放，同时把后端推来的真实进度事件丢进空函数。

这些是本项目重构的直接原因。**可信度是开源项目唯一的启动资本**，
所以宁可功能少，不可宣称假。

具体到 review 时会检查：

- 新增的 UI 文案，能不能当场在界面上演示出来？
- 新增的 README/文档条目，对应的代码在哪一行？
- 「AI」这个词，是不是只用在真的调用了模型的路径上？
  （规则引擎必须自称规则引擎）
- 未实现的能力，是不是明确标注了 `[计划]` 并指向路线图？

---

## 开发环境

**运行本项目不需要 `npm install`**——这是刻意的设计（见 `doc/architecture.md` §2）。

```bash
git clone <repo> && cd forgex-insight

# 跑起来
node server/index.js          # 打开 http://127.0.0.1:8787
# 或直接双击 index.html

# 跑测试（同样不需要 install）
npm test
```

只有代码检查工具需要安装：

```bash
npm install                   # 只装 eslint + prettier（devDependencies）
npm run lint
npm run format:check
npm run check                 # lint + format + test 一条龙
```

---

## 提交前自检

```bash
npm run check
```

必须全绿。CI 会在 Node 18 / 20 / 22 上重跑一遍。

---

## 代码约定

### 必须遵守

| 约定                                   | 原因                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **纯逻辑模块不得引用 DOM 或 THREE**    | `slicer.js` / `exporter.js` / `insight-data.js` / `insight-engine.js` 被后端 require、被 node 测试驱动。破坏这一点会同时打断后端引擎和测试 |
| **`file://` 必须继续可用**             | 不要引入需要 fetch 才能加载的配置文件、不要用 ES module 语法改写现有经典脚本（新模块的 ESM 迁移有单独计划）                                |
| **运行时零 npm 依赖**                  | 工具链可以有依赖，运行时不行                                                                                                               |
| **金额用整数「分」**                   | 避免浮点误差。展示层才转元                                                                                                                 |
| **`index.html` 的 `?v=` 版本号统一改** | 改一个漏一个会导致缓存不一致                                                                                                               |

### 风格

- 与周围代码保持一致（缩进、命名、注释密度）；
- 注释解释**为什么**，不解释**做了什么**——代码本身应该能说清做了什么；
- 尤其欢迎记录「这里为什么不能用更显然的写法」这类注释，它们防止后人重蹈覆辙；
- 新代码的注释与标识符**优先用英文**（存量中文注释按模块渐进迁移，不搞大爆炸翻译）；
- 用户可见文案抽到 i18n，不硬编码在逻辑里。

---

## 测试要求

新增分析逻辑**必须有测试**，且必须是**性质断言**。

❌ 不接受的写法（同义反复）：

```js
// 生成器把 FX-256-03 的故障率写死成 0.2，然后断言分析器找到了 FX-256-03。
// 这只验证了两处用了同一个常量，没有验证任何正确性。
check("结论命中 FX-256-03", report.verdict.includes("FX-256-03"));
```

✅ 期望的写法（构造已知效应 → 检验能否识别 → 调转效应 → 结论必须跟着变）：

```js
const ds = makeRows("BAD", 20, 8).concat(makeRows("OK", 20, 1));
check("识别出注入的高故障机台", E.analyze(q, ds).highlight.id === "BAD");

const flipped = makeRows("BAD", 20, 1).concat(makeRows("OK", 20, 8));
check("效应调转后结论随之调转", E.analyze(q, flipped).highlight.id === "OK");
```

第二个断言是关键：它证明引擎**在算数据，而不是在读常量**。

同样必须覆盖的还有**拒绝给结论的场景**——样本不足时引擎应当明确说样本不足，
这个行为也要有断言，否则很容易在后续重构中悄悄退化。

---

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(insight): 层高分析支持按材料分组
fix(sim): 修正 Delta 机型的 Z 补偿插值边界
docs(readme): 对齐云端模式的能力描述
refactor(server): 引擎标识 mock → rules
test(insight): 补最小样本量守卫的性质断言
```

---

## 提 Issue

- **Bug**：请附复现步骤、浏览器/Node 版本，以及是 `file://` 直开还是带后端；
- **数据分析结论有问题**：请附数据集（脱敏后）或能复现的构造方法——
  「引擎给出了不合理的结论」是我们最重视的一类 issue；
- **新机型 / 新材料**：欢迎，但请附上参数出处。

---

<a name="english"></a>

# Contributing (English)

Thanks for considering a contribution. The project is in a **0.x refactor**;
the roadmap lives in `doc/优化文档.md` (Chinese).

## One hard rule

> **Any PR that introduces text, comments, or documentation claiming capability that
> isn't implemented will be rejected.**

This isn't boilerplate. The codebase used to contain a knowledge-base endpoint replying
"registered, will be injected into analysis tasks" with no injection logic anywhere;
a "locate machine X in the 3D viewport" button that ignored its argument; and a three-step
progress animation played by `setTimeout` while real backend progress events were
discarded into an empty callback. Fixing that is why this refactor exists.

Credibility is the only startup capital an open-source project has. When in doubt,
ship less rather than claim more.

## Development

**Running the project requires no `npm install`** — that's deliberate.

```bash
node server/index.js      # http://127.0.0.1:8787
npm test                  # also needs no install
```

Only the linters need installing:

```bash
npm install && npm run check    # lint + format + test
```

## Code conventions

- **Pure-logic modules must not touch DOM or THREE** — `slicer.js`, `exporter.js`,
  `insight-data.js`, `insight-engine.js` are `require`d by the backend and driven by
  node tests. Breaking this breaks both.
- **`file://` must keep working** — no fetch-loaded config, no ESM rewrites of existing
  classic scripts.
- **Zero runtime npm dependencies.** Tooling may have deps; runtime may not.
- Money is stored as integer _fen_ (1/100 CNY); convert only for display.
- Comments explain **why**, not **what**. English preferred for new code.

## Tests

New analysis logic **must** ship with tests, and they must assert **properties**, not
"the generator planted X so the analyzer found X". Construct a dataset with a known
injected effect, assert the engine finds it — then **invert the effect and require the
conclusion to invert too**. That second assertion is what proves the engine computes
rather than echoes constants.

Also assert the _refusal_ paths: when samples are insufficient the engine must say so.
Without a test, that behavior silently regresses.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/).
