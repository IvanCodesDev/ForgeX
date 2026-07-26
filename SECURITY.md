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

### ⚠️ 服务端没有鉴权、没有配额、没有并发上限

如果你配置了 `INFINI_API_KEY` **并把服务暴露到公网**，任何人都可以持续触发真实云端
分析任务，**费用记在你的账上**。单次任务实测 160–230 秒。

当前唯一的防护是同 IP 5 秒冷却（`RATE_LIMIT_MS`），它挡不住分布式请求，
且在 `TRUST_PROXY=1` 时读取 `X-Forwarded-For`——如果你的反向代理没有覆写该头，
它可以被伪造。

**公网部署建议**（三选一）：

1. **不配置** `INFINI_API_KEY`，只跑规则引擎（无任何外部计费）；
2. 在反向代理层加访问控制（Basic Auth / IP allowlist / OAuth 网关）；
3. 等待路线图 P4 的鉴权与成本闸门。

### ⚠️ 全内存存储

数据源、任务、知识文档、分享页都在进程内存中，重启即失。
**分享页 token 不是持久凭证**，不要用于任何需要长期有效的场景。

### ℹ️ 已实现的防护

| 防护                     | 实现                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 密钥隔离                 | `sk-` key 只从 `server/.env` 读入进程环境，不回写文件、不进日志、不进任何响应体                             |
| 静态托管 deny-by-default | allowlist 只放行 `index.html` / `README.md` / `css/` / `js/` / `doc/samples/`；`server/` 与 `.env` 永不可达 |
| 路径穿越                 | 归一化后仍含 `..`、反斜杠或控制符的路径一律拒绝；解析出的绝对路径必须在根目录内                             |
| 请求体限长               | 超限后排空剩余数据再回 413，不 destroy 连接                                                                 |
| CORS                     | 默认不放行任何跨域；需显式配置 `ALLOW_ORIGINS`                                                              |
| 上游错误脱敏             | 上游响应正文只进日志，对外只返回状态码                                                                      |
| 分享页                   | 服务端渲染、零脚本，内容经 HTML 转义                                                                        |

以上任何一项被绕过，都是**真实漏洞**，请按上文流程报告。

---

## 密钥泄露处置

若你不慎把 `sk-` key 提交进了 git：

1. **立刻到 InfiniSynapse 控制台吊销该 key**——这是唯一真正有效的一步；
2. 生成新 key，只写入 `server/.env`（已被 `.gitignore` 排除）；
3. 清理历史（`git filter-repo` 或 BFG）；**注意**：如果已经 push 过，
   即使清理了历史，也必须假定该 key 已泄露——吊销是不可跳过的。

提交前自检：

```bash
git log -p | grep -i "sk-[a-zA-Z0-9]"
git ls-files | grep -E "\.env$"        # 应当没有输出
```
