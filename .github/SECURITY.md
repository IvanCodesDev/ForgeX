# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**通过公开 issue 报告安全问题。
Please do **not** report security issues through public issues.

请使用 GitHub 的 [Security Advisories](https://github.com/IvanCodesDev/ForgeX/security/advisories/new)
私密报告。我们会在 **72 小时内**确认收到，并在修复后于 advisory 中致谢（可匿名）。

---

## 支持的版本 / Supported versions

项目处于 `0.x` 重构期，只有 **最新的 `0.x` 版本**接受安全修复。

---

## 已知的安全边界（请在部署前阅读）

以下不是漏洞，是**当前版本已知且已声明的设计边界**。
在这些边界内的行为不接受作为漏洞报告，但欢迎讨论改进方案。

### ✅ 已具备的成本防护（P4 起）

此前这里写的是「服务端没有鉴权、没有配额、没有并发上限」。那条警告现在不再成立——
本节改为说明**已有的防护**与**仍需你自己做的事**。

| 防护                       | 默认值 | 环境变量                    |
| -------------------------- | ------ | --------------------------- |
| AI 并发上限                | 2      | `AI_CONCURRENCY`            |
| 排队上限（超出才拒绝）     | 8      | `AI_QUEUE_MAX`              |
| 单调用方每日 AI 额度       | 20     | `AI_DAILY_PER_CALLER`       |
| 全实例每日 AI 额度（兜底） | 200    | `AI_DAILY_GLOBAL`           |
| API Key 鉴权               | 关闭   | `API_KEYS` / `REQUIRE_AUTH` |

几条关键语义：

- **额度用尽 ≠ 服务不可用**。规则引擎不花钱，凭什么限流——额度耗尽时自动降级为
  规则引擎继续给出结论（统计口径、置信区间、显著性检验与 AI 模式完全一致，
  少的只是自然语言叙述），并在报告里说明为什么降级。
- **用量跨重启保留**（落盘在 `DATA_DIR/usage.json`）。否则重启就等于重置额度，
  闸门形同虚设。
- **按人计费**：带合法 API Key 的调用方按 key 计，其余按 IP 计。
- `/healthz` 会把当前的配额状态摆在明面上，访问者不必撞上限制才知道有限制。

**公网部署仍建议**：

1. 配置 `API_KEYS`，并按需 `REQUIRE_AUTH=1`；
2. 按你的钱包能力调低 `AI_DAILY_GLOBAL`；
3. 不确定的话就**不配 AI 密钥**——规则引擎零外部计费，结论依然带置信区间与显著性检验。

### ⚠️ 限流仍依赖可信代理

`TRUST_PROXY=1` 时限流读取 `X-Forwarded-For`。如果你的反向代理**没有覆写**这个头，
它可以被伪造。请确保代理层会重写该头（Nginx: `proxy_set_header X-Forwarded-For $remote_addr;`）。

### ℹ️ 存储与分享页

P4 起数据源、知识文档、分享页与用量计数都会落盘到 `DATA_DIR`（默认 `server/../data`）；
P8 增加 `calibrations.json`，其中包含候选 bundle、审核事件和当前发布版本。
容器部署时**务必挂卷**到该目录，否则重建容器仍会丢数据。
设 `DATA_DIR=` 为空可显式退回纯内存（`/healthz` 会如实报告 `persistence`）。

分享页支持撤销：创建时返回的 `revokeKey` 只出现一次，服务端只存哈希。
`POST /api/share/:token/revoke` 携带它即可立刻失效。

### ℹ️ 校准审批身份边界

校准候选提交、候选队列读取和 approve/reject 始终要求合法 API Key，不受
`REQUIRE_AUTH=0` 影响。批准要求与提交不同的 key；请为提交者和审核者分别分配凭据。
服务端只记录 key 的 SHA-256 摘要前缀，不保存或返回完整 key。

四眼规则只能证明两个不同凭据参与，不能证明是两个自然人，也不会自动验证
`real-anonymized` / `real-consented` 声明。审核者必须另行核查数据授权、匿名化和采集责任链。
公开 `GET /api/calibrations` 仅包含已批准模型参数和来源说明，不包含训练原始记录。

### ℹ️ 已实现的防护

| 防护                     | 实现                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 密钥隔离                 | `sk-` key 只从 `server/.env` 读入进程环境，不回写文件、不进日志、不进任何响应体                             |
| 静态托管 deny-by-default | allowlist 只放行 `index.html` / `README.md` / `css/` / `js/` 及有限的公开示例；`server/` 与 `.env` 永不可达 |
| 路径穿越                 | 归一化后仍含 `..`、反斜杠或控制符的路径一律拒绝；解析出的绝对路径必须在根目录内                             |
| 请求体限长               | 超限后排空剩余数据再回 413，不 destroy 连接                                                                 |
| CORS                     | 默认不放行任何跨域；需显式配置 `ALLOW_ORIGINS`                                                              |
| 上游错误脱敏             | 上游响应正文只进日志，对外只返回状态码                                                                      |
| 分享页                   | 服务端渲染、零脚本，内容经 HTML 转义                                                                        |

以上任何一项被绕过，都是**真实漏洞**，请按上文流程报告。

---

## 密钥泄露处置

若你不慎把 `sk-` key 提交进了 git：

1. **立刻到你的 AI 服务商控制台吊销该 key**——这是唯一真正有效的一步；
2. 生成新 key，只写入 `server/.env`（已被 `.gitignore` 排除）；
3. 清理历史（`git filter-repo` 或 BFG）；**注意**：如果已经 push 过，
   即使清理了历史，也必须假定该 key 已泄露——吊销是不可跳过的。

提交前自检：

```bash
git log -p | grep -i "sk-[a-zA-Z0-9]"
git ls-files | grep -E "\.env$"        # 应当没有输出
```
