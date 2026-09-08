/* Stage 8.6a/8.6b 真实双跑门禁：数据源 / 知识库 / 校准治理 / 分享四条资源腿，Node 权威 vs C# 权威。

   与假 sidecar 测试（tests/resource-authority.test.js、tests/shares-authority.test.js）不同，这里起的是
   真实的 ForgeX.Api Release 进程：
     - C#：临时 Storage:Root、内部信任密钥；**不配置任何 API Key**，证明可信通道不依赖 C# 侧密钥；
     - Node A：*_AUTHORITY=node（本进程存储）；Node B：*_AUTHORITY=csharp（经可信通道代理到 C#）。
   同一份语料按顺序逐条打到 A 与 B，比对状态码与响应 JSON（规范化：去掉时间戳 / 随机 id，
   把各实例的 key 摘要映射为角色占位符），`hits[].score` 与 `digest` 精确相等。
   分享公开页是 HTML：取全文、把字符实体规范化后整体比对（Node escapeHtml 出 `&#39;`，
   .NET HtmlEncoder 出 `&#x27;` 与非 ASCII 数字实体——语义同、字节不同）。
   分析任务切流（8.6c-1 结果 / 轮询，8.6c-2a 进度流，8.6c-2b 规则引擎腿的创建）：C# 只有 postgres provider，
   所以只有 postgres 腿的 Node B 走 ANALYSIS_TASKS_AUTHORITY=csharp——ds-analyze-* 的任务由 C# 创建并在 C# 进程内
   用 C# 规则引擎执行、逐事件落到同一张 forgex.node_analysis_tasks，A 侧仍是 Node 创建 + JS 规则引擎：
   报告 / 事件序列 / 快照逐字段比对就是「创建链迁 C#」的证据。file 腿 B 保持 node，task-* 用例在 file 腿是
   Node 对 Node，产物 `authority.analysisTasks` 如实记录。进度流用例读完整条 SSE，比对去掉墙钟后的事件序列。
   差异若命中 waivers 表（用例 + JSON 路径 + 说明）记为 waived，否则 fail → 非零退出。

   POSTGRES_URL 存在时再跑第二轮：C# *__Provider=postgres、Node A' PERSISTENCE_PROVIDER=postgres、
   Node B' csharp → C#(PG)；缺失则产物 skipped: ["postgres"]（本机无 PG 时如实记录，CI 用 service 覆盖）。
   产物：backend/artifacts/resource-authority-dualrun.json。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { createApp } = require("../server/index");

const root = path.resolve(__dirname, "..");
const apiDll = path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");
const artifactPath = path.join(root, "backend", "artifacts", "resource-authority-dualrun.json");
const INTERNAL_SECRET = "stage86a-resource-dualrun-internal-secret-" + crypto.randomBytes(8).toString("hex");
// 两个 Node 实例监听不同端口，publicUrl 必须由同一个 PUBLIC_BASE 拼出来才可比。
const PUBLIC_BASE = "https://forgex.example";
// 8.6c-1：分析任务只读切流按腿选权威——C# 无 file provider，file 腿的 Node B 只能留在 node。
const ANALYSIS_TASKS_AUTHORITY_BY_LEG = { file: "node", postgres: "csharp" };
// 8.6c-2b-ii：两侧同样的 AI 日额度（每调用方 2 次），语料里第三个 AI 任务必须两侧同步降级。
const AI_DAILY_PER_CALLER = 2;
const FAKE_AI_MODEL = "dual-run-fake-model";
const FAKE_AI_KEY = "sk-dual-run-fake-key-000000";

/* 假 OpenAI 兼容端点：/models 探活 200，/chat/completions 返回固定的结构化叙述与 usage——
   两侧 provider（Node openaiProvider vs C# OpenAiNarrativeClient）拿到同一份叙述，合并结果才可比。 */
function startFakeOpenAi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: FAKE_AI_MODEL }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const narrative = {
          title: "AI 叙述：失败率结论",
          verdict: "AI 叙述：按简报，失败率差异及其 95% 置信区间见下文；数字均来自本地统计核。",
          sections: [{ h: "AI 小节", lines: ["第一条要点（来自简报）", "第二条要点（来自简报）"] }],
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-dualrun",
            object: "chat.completion",
            model: FAKE_AI_MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "```json\n" + JSON.stringify(narrative) + "\n```" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 },
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected fake openai request" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, requests })
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyId = (key) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
const randomTenant = () => "tn_" + crypto.randomBytes(16).toString("hex");

function dotnetExecutable() {
  const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  return fs.existsSync(local) ? local : "dotnet";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-resource-dualrun-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/* ── 进程管理 ─────────────────────────────────────────────────────────────── */

async function waitForReady(baseUrl, child, output) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`ForgeX.Api exited ${child.exitCode}: ${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // 启动竞态：限期内重试。
    }
    await sleep(125);
  }
  throw new Error(`ForgeX.Api readiness timed out: ${output.join("")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function spawnApi(leg, storageRoot, postgresUrl, calibrationTenant) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const providerEnv = {};
  for (const section of ["Datasources", "Knowledge", "Calibrations", "Shares"]) {
    providerEnv[`${section}__Provider`] = leg;
    if (leg === "postgres") providerEnv[`${section}__PostgresUrl`] = postgresUrl;
  }
  // 分析任务历史只有 postgres provider（读 Node 落库的快照）；file 腿保持 disabled。
  if (leg === "postgres") {
    providerEnv.AnalysisTasks__Provider = "postgres";
    providerEnv.AnalysisTasks__PostgresUrl = postgresUrl;
    // 8.6c-2b-ii：与 Node A 同样的日额度，第三个 AI 任务两侧都必须降级为规则引擎。
    providerEnv.Analysis__AiDailyPerCaller = String(AI_DAILY_PER_CALLER);
  }
  const child = spawn(dotnetExecutable(), [apiDll], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      ASPNETCORE_ENVIRONMENT: "Production",
      Kestrel__Endpoints__Http__Url: baseUrl,
      Storage__Root: storageRoot,
      InternalAuth__SharedSecret: INTERNAL_SECRET,
      Calibrations__TenantId: calibrationTenant,
      ...providerEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  await waitForReady(baseUrl, child, output);
  return { child, baseUrl, output };
}

async function startNode(label, overrides) {
  const submitKey = `dual-run-${label}-submit`;
  const reviewKey = `dual-run-${label}-review`;
  const app = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    publicBase: PUBLIC_BASE,
    // reviewer 同时也是合法提交者：四眼原则用例需要「提交者不能审批自己」的场景。
    apiKeys: `${submitKey},${reviewKey}`,
    calibrationReviewKeys: reviewKey,
    ...overrides,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  return {
    label,
    app,
    baseUrl,
    keys: { submitter: submitKey, reviewer: reviewKey },
    roleByKeyId: { [keyId(submitKey)]: "@submitter", [keyId(reviewKey)]: "@reviewer" },
    state: {},
  };
}

/* ── 语料 ─────────────────────────────────────────────────────────────────── */

const CSV_BASIC = [
  "machine_id,model_name,material,status,duration_min,cost_fen,fail_reason",
  "M1,Bracket,PLA,success,42,1250,",
  "M2,Bracket,ABS,fail,55,1800,warping",
  "M1,Gear,PLA,success,30,900,",
  "M3,Gear,PETG,fail,61,2100,stringing",
  "M2,Housing,ABS,success,88,3300,",
].join("\n");
const CSV_SIM = [
  "machine,model,material,status,duration_min,cost_cny",
  "S1,Cube,PLA,ok,10,1.5",
  "S2,Cube,PLA,failed,12,1.8",
  "S1,Cube,ABS,success,15,2.0",
].join("\r\n");
const CSV_WARNINGS = [
  "machine_id,material,status,cost",
  "M1,PLA,success,abc",
  "M2,ABS,fail,300",
  "M3,PETG,unknown,10",
  "M4,PLA,success,20",
].join("\n");

function candidate(id, revision) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id,
    revision,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: { license: "CC-BY-4.0", note: "Anonymized production pairs submitted for independent calibration review." },
    models: [
      {
        id: id + "-pla",
        status: "candidate",
        scope: { machineId: "FX-P8-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.18, fixedOverheadSec: 80, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.16,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "c".repeat(64),
      },
    ],
  };
}

const REASON = "Holdout metrics and anonymization evidence reviewed.";

/** 每个用例是一个函数：拿到实例（含其 keys 与 state）返回请求描述；`after` 可把响应写回 state。 */
const CASES = [
  // ── 数据源 ──
  {
    name: "ds-upload-basic",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: CSV_BASIC, name: "jobs.csv" },
    after: (json, state) => {
      state.dsId = json && json.datasourceId;
    },
  },
  {
    // badge 按 UTF-16 单元截到 8 位：代理对（🙂 占 2 位）两侧都必须原样保留。
    name: "ds-upload-provenance-badge",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: CSV_SIM, name: 123, provenance: { synthetic: true, badge: "机群🙂仿真数据集合xyz" } },
  },
  {
    // \u0000 能进 JSON 文件，进不了 PostgreSQL jsonb：file 腿两侧 201，postgres 腿两侧 5xx（见 WAIVERS）。
    name: "ds-upload-provenance-badge-nul",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: {
      csv: CSV_SIM + "\r\nS3,Cube,PETG,ok,11,1.6",
      name: "nul.csv",
      provenance: { synthetic: true, badge: "机群\u0000仿真" },
    },
  },
  {
    name: "ds-upload-duplicate",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: CSV_BASIC, name: "renamed.csv" },
  },
  {
    name: "ds-upload-warnings",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: CSV_WARNINGS },
  },
  {
    name: "ds-upload-invalid-csv",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: "machine,material\n" },
  },
  { name: "ds-upload-empty-csv", role: "submitter", method: "POST", path: "/api/datasource", body: { csv: "   " } },
  {
    name: "ds-upload-name-truncated",
    role: "submitter",
    method: "POST",
    path: "/api/datasource",
    body: { csv: CSV_BASIC + "\nM9,Lid,PLA,success,5,100,", name: "名".repeat(100) },
  },
  {
    name: "ds-analyze-result",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: (state) => ({ datasourceId: state.dsId, question: "哪台机器的失败率最高？" }),
    after: (json, state) => {
      state.uploadTaskId = json && json.taskId;
    },
  },
  {
    name: "ds-analyze-sample",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: { datasourceId: "sample", question: "材料与失败率有什么关系" },
    after: (json, state) => {
      state.sampleTaskId = json && json.taskId;
    },
  },
  {
    name: "ds-analyze-missing",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    body: { datasourceId: "ds_" + "0".repeat(24), question: "x" },
  },
  {
    name: "ds-analyze-unsafe-id",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    body: { datasourceId: "../etc/passwd", question: "x" },
  },
  {
    name: "ds-analyze-foreign",
    role: "reviewer",
    method: "POST",
    path: "/api/analyze",
    body: (state) => ({ datasourceId: state.dsId, question: "x" }),
  },
  // ── 知识库 ──
  {
    name: "kb-create-cn",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge",
    body: { name: "工艺手册.md", text: "喷嘴温度过高会拉丝；回抽距离不足会渗料。首层附着差会导致翘边。" },
  },
  {
    name: "kb-create-en",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge",
    body: {
      name: "Materials EN.md",
      text: "PLA prints at 200C. ABS warps without an enclosure; bed adhesion needs a brim.",
    },
  },
  {
    name: "kb-create-mixed",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge",
    body: { text: "床温 60 度改善 bed adhesion；warping 翘边 多见于 ABS。" },
  },
  { name: "kb-create-empty", role: "submitter", method: "POST", path: "/api/knowledge", body: { text: "   " } },
  { name: "kb-create-missing-text", role: "submitter", method: "POST", path: "/api/knowledge", body: { name: "x.md" } },
  {
    name: "kb-create-too-large",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge",
    body: { text: "a".repeat(512 * 1024 + 1) },
  },
  {
    name: "kb-search-cn",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "喷嘴温度" },
  },
  {
    name: "kb-search-mixed",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "ABS warping 翘边", topK: "2" },
  },
  {
    name: "kb-search-en",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "bed adhesion brim" },
  },
  {
    name: "kb-search-miss",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "zzz quantum foobar" },
  },
  {
    name: "kb-search-empty",
    role: "submitter",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "   " },
  },
  {
    name: "kb-search-foreign-empty",
    role: "reviewer",
    method: "POST",
    path: "/api/knowledge/search",
    body: { question: "喷嘴温度" },
  },
  // ── 校准治理 ──
  { name: "cal-catalog-empty", role: null, method: "GET", path: "/api/calibrations" },
  {
    name: "cal-submit-anonymous",
    role: null,
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-bundle", 1) },
  },
  {
    name: "cal-submit-invalid",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: { ...candidate("dual-run-bundle", 1), version: 2, models: [] } },
  },
  {
    name: "cal-submit-not-candidate",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: (() => {
      const b = candidate("dual-run-bundle", 1);
      b.models[0].status = "active";
      return { bundle: b };
    })(),
  },
  {
    name: "cal-submit-missing-bundle",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { note: "no bundle" },
  },
  {
    name: "cal-submit-1",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-bundle", 1), note: "first candidate" },
  },
  {
    name: "cal-submit-duplicate",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-bundle", 1) },
  },
  { name: "cal-list-plain-key", role: "submitter", method: "GET", path: "/api/calibrations/submissions" },
  { name: "cal-list-anonymous", role: null, method: "GET", path: "/api/calibrations/submissions" },
  { name: "cal-list-pending", role: "reviewer", method: "GET", path: "/api/calibrations/submissions" },
  {
    name: "cal-review-bad-decision",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/1/review",
    body: { decision: "maybe", reason: REASON },
  },
  {
    name: "cal-review-short-reason",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/1/review",
    body: { decision: "approve", reason: "short" },
  },
  {
    name: "cal-review-404",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/nope/revisions/1/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-submit-2-by-reviewer",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-bundle", 2), note: 42 },
  },
  {
    name: "cal-review-self-approve",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/2/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-approve-1",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/1/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-approve-1-again",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/1/review",
    body: { decision: "reject", reason: REASON },
  },
  {
    name: "cal-reject-2",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/2/review",
    body: { decision: "reject", reason: "Reviewer submitted it; rejecting to keep four-eyes." },
  },
  {
    name: "cal-submit-3",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-bundle", 3) },
  },
  {
    name: "cal-approve-3",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-bundle/revisions/3/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-submit-mono-2",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-mono", 2) },
  },
  {
    name: "cal-approve-mono-2",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-mono/revisions/2/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-submit-mono-1-lower",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-mono", 1) },
  },
  {
    name: "cal-submit-mono-3",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-mono", 3) },
  },
  {
    name: "cal-submit-mono-4",
    role: "submitter",
    method: "POST",
    path: "/api/calibrations/submissions",
    body: { bundle: candidate("dual-run-mono", 4) },
  },
  {
    name: "cal-approve-mono-4",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-mono/revisions/4/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-approve-mono-3-stale",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-mono/revisions/3/review",
    body: { decision: "approve", reason: REASON },
  },
  {
    name: "cal-reject-mono-3",
    role: "reviewer",
    method: "POST",
    path: "/api/calibrations/dual-run-mono/revisions/3/review",
    body: { decision: "reject", reason: REASON },
  },
  { name: "cal-catalog-final", role: null, method: "GET", path: "/api/calibrations" },
  { name: "cal-list-final", role: "reviewer", method: "GET", path: "/api/calibrations/submissions" },
  {
    name: "healthz-calibrations",
    role: null,
    method: "GET",
    path: "/healthz",
    pick: (json) => json && json.calibrations,
  },
  // ── 分享（8.6b）：任务归属仍由 Node 判定，存储 / 撤销 / 公开页在 csharp 模式下经可信通道到 C# ──
  {
    name: "share-create-missing-task",
    role: "submitter",
    method: "POST",
    path: "/api/share/t_0000000000000000",
    body: {},
  },
  {
    name: "share-create-foreign-task",
    role: "reviewer",
    method: "POST",
    path: (state) => "/api/share/" + state.uploadTaskId,
    body: {},
  },
  {
    name: "share-create-anonymous",
    role: null,
    method: "POST",
    path: (state) => "/api/share/" + state.uploadTaskId,
    body: {},
  },
  {
    name: "share-create",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.uploadTaskId,
    body: {},
    after: (json, state) => {
      state.shareToken = json && json.token;
      state.shareRevokeKey = json && json.revokeKey;
    },
    pick: pickShareCreated,
  },
  { name: "share-page", role: null, method: "GET", path: (state) => "/share/" + state.shareToken, html: true },
  { name: "share-page-unknown-token", role: null, method: "GET", path: "/share/deadbeefdeadbeefde", html: true },
  {
    name: "share-revoke-wrong-key",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.shareToken + "/revoke",
    body: { revokeKey: "not-the-key" },
  },
  {
    name: "share-revoke-foreign",
    role: "reviewer",
    method: "POST",
    path: (state) => "/api/share/" + state.shareToken + "/revoke",
    body: (state) => ({ revokeKey: state.shareRevokeKey }),
  },
  {
    name: "share-page-still-live",
    role: null,
    method: "GET",
    path: (state) => "/share/" + state.shareToken,
    html: true,
  },
  {
    name: "share-revoke",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.shareToken + "/revoke",
    body: (state) => ({ revokeKey: state.shareRevokeKey }),
  },
  {
    name: "share-revoke-again",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.shareToken + "/revoke",
    body: (state) => ({ revokeKey: state.shareRevokeKey }),
  },
  {
    name: "share-page-after-revoke",
    role: null,
    method: "GET",
    path: (state) => "/share/" + state.shareToken,
    html: true,
  },
  {
    // 内置样例：合成 provenance 的 ⚠ 提示 + 图表行（百分比 / 数值格式化）都要在两侧渲染一致。
    name: "share-create-sample",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.sampleTaskId,
    body: {},
    after: (json, state) => {
      state.sampleShareToken = json && json.token;
      state.sampleShareRevokeKey = json && json.revokeKey;
    },
    pick: pickShareCreated,
  },
  {
    name: "share-page-sample",
    role: null,
    method: "GET",
    path: (state) => "/share/" + state.sampleShareToken,
    html: true,
  },
  {
    name: "share-revoke-sample",
    role: "submitter",
    method: "POST",
    path: (state) => "/api/share/" + state.sampleShareToken + "/revoke",
    body: (state) => ({ revokeKey: state.sampleShareRevokeKey }),
  },
  // ── 分析任务只读（8.6c-1）：postgres 腿 B 读 C# 快照，file 腿 B 仍读本地（C# 无 file provider）──
  { name: "task-poll", role: "submitter", method: "GET", path: (state) => "/api/analyze/" + state.uploadTaskId },
  {
    name: "task-result",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.uploadTaskId + "/result",
    settle: true,
  },
  { name: "task-poll-sample", role: "submitter", method: "GET", path: (state) => "/api/analyze/" + state.sampleTaskId },
  {
    name: "task-result-sample",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.sampleTaskId + "/result",
    settle: true,
  },
  { name: "task-poll-missing", role: "submitter", method: "GET", path: "/api/analyze/t_0000000000000000" },
  { name: "task-result-missing", role: "submitter", method: "GET", path: "/api/analyze/t_0000000000000000/result" },
  { name: "task-poll-foreign", role: "reviewer", method: "GET", path: (state) => "/api/analyze/" + state.uploadTaskId },
  {
    name: "task-result-foreign",
    role: "reviewer",
    method: "GET",
    path: (state) => "/api/analyze/" + state.uploadTaskId + "/result",
  },
  {
    name: "task-result-anonymous",
    role: null,
    method: "GET",
    path: (state) => "/api/analyze/" + state.uploadTaskId + "/result",
  },
  // ── 分析任务进度流（8.6c-2a）：B 在 postgres 腿消费 C# /events 重新组帧，比对整条事件序列 ──
  {
    name: "task-stream",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.uploadTaskId + "/stream",
    sse: true,
  },
  {
    name: "task-stream-sample",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.sampleTaskId + "/stream",
    sse: true,
  },
  {
    name: "task-stream-missing",
    role: "submitter",
    method: "GET",
    path: "/api/analyze/t_0000000000000000/stream",
    sse: true,
  },
  {
    name: "task-stream-foreign",
    role: "reviewer",
    method: "GET",
    path: (state) => "/api/analyze/" + state.uploadTaskId + "/stream",
    sse: true,
  },
  // ── AI 腿（8.6c-2b-ii）：自带 OpenAI 兼容端点 → 假 AI 服务；日额度 2 次/调用方，第三个降级；同问命中缓存 ──
  {
    name: "ai-override-incomplete",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    body: (state) => ({ datasourceId: "sample", question: "x", aiBaseUrl: state.aiBaseUrl }),
  },
  {
    name: "ai-analyze",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: (state) => aiBody(state, "哪台机器的失败率最高？"),
    after: (json, state) => {
      state.aiTaskId = json && json.taskId;
    },
  },
  {
    name: "ai-analyze-cached",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: (state) => aiBody(state, "哪台机器的失败率最高？"),
    after: (json, state) => {
      state.aiCachedTaskId = json && json.taskId;
    },
  },
  {
    name: "ai-analyze-second",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: (state) => aiBody(state, "材料与失败率有什么关系"),
  },
  {
    name: "ai-analyze-quota-degraded",
    role: "submitter",
    method: "POST",
    path: "/api/analyze",
    analyze: true,
    body: (state) => aiBody(state, "成本随时间怎么变化"),
    after: (json, state) => {
      state.aiDegradedTaskId = json && json.taskId;
    },
  },
  {
    name: "ai-stream",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.aiTaskId + "/stream",
    sse: true,
  },
  {
    name: "ai-stream-cached",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.aiCachedTaskId + "/stream",
    sse: true,
  },
  {
    name: "ai-stream-quota-degraded",
    role: "submitter",
    method: "GET",
    path: (state) => "/api/analyze/" + state.aiDegradedTaskId + "/stream",
    sse: true,
  },
  { name: "ai-poll", role: "submitter", method: "GET", path: (state) => "/api/analyze/" + state.aiTaskId },
];

function aiBody(state, question) {
  return {
    datasourceId: "sample",
    question,
    aiBaseUrl: state.aiBaseUrl,
    aiApiKey: FAKE_AI_KEY,
    aiModel: FAKE_AI_MODEL,
  };
}

/* SSE 全文 → 无名 data: 帧序列（JSON 解析），注释行与命名帧分别计数；ts 是墙钟，去掉后比对。 */
function pickSseEvents(text) {
  const events = [];
  let comments = 0;
  let named = 0;
  for (const line of String(text).split("\n")) {
    if (line.startsWith(":")) comments += 1;
    else if (line.startsWith("event:")) named += 1;
    else if (line.startsWith("data:")) {
      try {
        const { ts: _ts, ...event } = JSON.parse(line.slice(5).trim());
        events.push(event);
      } catch {
        events.push({ nonJson: line.slice(5, 120) });
      }
    }
  }
  return { events, comments: comments > 0, named };
}

/* 分享创建响应：token / revokeKey 随机（18 hex），publicUrl 由统一的 PUBLIC_BASE + token 拼成。 */
function pickShareCreated(json) {
  if (!json || typeof json !== "object") return json;
  return {
    ...json,
    publicUrl:
      typeof json.publicUrl === "string" ? json.publicUrl.replace(/[a-f0-9]{18}$/, "<share-token>") : json.publicUrl,
  };
}

/* HTML 全文比对前把字符实体规范化：数字实体（十进制 / 十六进制）与五个命名实体都还原成字符本身。
   单趟替换：`&amp;lt;` 只还原一层，不会被误当成 `<`。 */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function canonicalHtml(text) {
  return String(text).replace(/&(#x([0-9a-f]+)|#([0-9]+)|amp|lt|gt|quot|apos);/gi, (match, name, hex, dec) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    return NAMED_ENTITIES[name.toLowerCase()] || match;
  });
}

/* 已知且已批准的差异（设计 §13）。path 为规范化后响应对象内的路径前缀。 */
const WAIVERS = [
  {
    caseName: "ds-analyze-foreign",
    paths: ["status", "body.error"],
    reason:
      "Node file 态 requireOwner 对他人数据源返回 403「无权访问该资源」；C# 侧按租户隔离对他人资源统一 404（与 Stage 8.1 shares 撤销同一取舍：不暴露「存在但不属于你」），" +
      "Node csharp 门面据此返回 404「数据源不存在或已过期，请重新上传」。批准：用户 2026-09-06（设计 §7.3 / §13）。",
  },
  {
    caseName: "ds-upload-provenance-badge-nul",
    paths: ["status", "body.error"],
    reason:
      "PostgreSQL jsonb 不接受 \\u0000（unsupported Unicode escape sequence）：postgres 腿 Node 权威写库失败返回 500「服务器内部错误」，" +
      "C# 权威写库失败后 Node csharp 门面返回 502「数据源服务暂不可用，请稍后再试」；file 腿两侧都 201。控制字符是否在入口统一清洗留待 Node 权威侧决定（8.6b 待办），此处只如实记录差异。",
  },
  {
    caseName: "share-revoke-foreign",
    paths: ["status", "body.error"],
    reason:
      "他人持正确 revokeKey 撤销：Node node 态先 shares.get 再 requireOwner，返回 403「无权访问该资源」；csharp 态归属校验由 C# 租户 / owner 隔离承担，" +
      "他人 token 一律 404「分享不存在或已过期」（Stage 8.1 routes/share.js 注明的取舍：不暴露「存在但不属于你」，与 ds-analyze-foreign 同源）。",
  },
  ...[
    "task-poll-foreign",
    "task-result-foreign",
    "task-result-anonymous",
    "task-stream-foreign",
    // 8.6c-2b：分享前的「任务存在 / 归属 / 已完成」判定在 csharp 态也改问 C# 快照，同一取舍。
    "share-create-foreign-task",
    "share-create-anonymous",
  ].map((caseName) => ({
    caseName,
    // 进度流用例的 JSON 错误体包在 body.json 下（与 HTML 用例同一形状）。
    paths: ["status", "body.error", "body.json.error"],
    reason:
      "他人 / 匿名读取分析任务：Node node 态 requireOwner 返回 403「无权访问该资源」；ANALYSIS_TASKS_AUTHORITY=csharp 时归属由 C# 按租户 + owner 隔离，" +
      "他人任务一律 404「任务不存在或已过期」（与 ds-analyze-foreign / share-revoke-foreign 同源）。仅 postgres 腿分歧——file 腿 C# 无 provider，两侧皆 Node，403/403 一致。",
  })),
];

/* ── 规范化与比对 ─────────────────────────────────────────────────────────── */

const DROP_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "expiresAt",
  "at",
  "approvedAt",
  "finishedAt",
  "now",
  "taskId",
  "upstreamTaskId",
  "generatedAt",
  "elapsedMs",
]);
const ID_PATTERNS = [
  [/^ds_[a-f0-9]{24}$/, "<datasource-id>"],
  [/^kb_[a-f0-9]{16}$/, "<knowledge-id>"],
  [/^t_[a-f0-9]{16}$/, "<task-id>"],
  // 分享 token 与 revokeKey：两侧都是 randomBytes(9) 的 18 位小写 hex。
  [/^[a-f0-9]{18}$/, "<share-secret>"],
];

function normalize(value, instance) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, instance));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = normalize(value[key], instance);
    }
    return out;
  }
  if (typeof value === "string") {
    if (instance.roleByKeyId[value]) return instance.roleByKeyId[value];
    for (const [pattern, placeholder] of ID_PATTERNS) if (pattern.test(value)) return placeholder;
  }
  return value;
}

const FLOAT_TOLERANCE = 1e-9;

function diffPaths(a, b, prefix, out) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: prefix + ".length", a: a.length, b: b.length });
      return out;
    }
    a.forEach((item, index) => diffPaths(item, b[index], `${prefix}[${index}]`, out));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
    // 8.6c-2b：JS 与 .NET 的 exp/pow 在最后一两位有效数字上可以不同（p 值 5.53093901640190e-6 vs …812），
    // 这是两套统计核的浮点实现差异，不是创建链语义差异；按相对误差 1e-9 判等，超出仍算差异。
    if (a !== b && Math.abs(a - b) > FLOAT_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))) {
      out.push({ path: prefix, a, b });
    }
    return out;
  }
  if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: prefix, a, b });
  return out;
}

function trimForReport(value) {
  const text = JSON.stringify(value);
  return text === undefined ? null : text.length > 200 ? text.slice(0, 200) + "…" : text;
}

/* ── 执行 ─────────────────────────────────────────────────────────────────── */

async function jfetch(baseUrl, pathname, init) {
  const response = await fetch(baseUrl + pathname, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { nonJson: text.slice(0, 200) };
  }
  return { status: response.status, contentType: response.headers.get("content-type") || "", text, json };
}

async function runCase(instance, testCase) {
  const headers = { "Content-Type": "application/json" };
  if (testCase.role) headers.Authorization = "Bearer " + instance.keys[testCase.role];
  const body = typeof testCase.body === "function" ? testCase.body(instance.state) : testCase.body;
  const pathname = typeof testCase.path === "function" ? testCase.path(instance.state) : testCase.path;
  const init = { method: testCase.method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  let response = await jfetch(instance.baseUrl, pathname, init);
  if (testCase.settle) {
    // 只读切流：Node 内存已 done、快照落库可能滞后一个 DB 往返，csharp 侧会先回 202——等到非 202 再比对。
    const deadline = Date.now() + 15_000;
    while (response.status === 202 && Date.now() < deadline) {
      await sleep(50);
      response = await jfetch(instance.baseUrl, pathname, init);
    }
  }
  if (testCase.after) testCase.after(response.json, instance.state);
  let picked = response.json;
  if (testCase.html) {
    // 公开页：成功时是 HTML 全文（实体规范化后整体比对），失败时是 Node 的 JSON 错误体。
    picked = /json/i.test(response.contentType)
      ? { contentType: response.contentType, json: response.json }
      : { contentType: response.contentType, html: canonicalHtml(response.text) };
  } else if (testCase.sse) {
    // 进度流：终态任务的流会自行结束；成功时比对整条事件序列，失败时是 Node 的 JSON 错误体。
    picked = /json/i.test(response.contentType)
      ? { contentType: response.contentType, json: response.json }
      : { contentType: response.contentType, ...pickSseEvents(response.text) };
  } else if (testCase.analyze && response.status === 202 && response.json && response.json.taskId) {
    // 规则引擎异步任务：等到终态后比对报告本体（缓存/耗时等易变字段由 normalize 去掉）。
    const deadline = Date.now() + 15_000;
    let result = null;
    while (Date.now() < deadline) {
      result = await jfetch(instance.baseUrl, `/api/analyze/${response.json.taskId}/result`, { headers });
      if (result.status !== 202) break;
      await sleep(50);
    }
    picked = {
      accepted: {
        engine: response.json.engine,
        authenticated: response.json.authenticated,
        willUseAi: response.json.willUseAi,
        // 8.6c-2b-ii：闸门预检结果也要一致（ok / remaining / reason 文案）。
        quota: response.json.quota === undefined ? null : response.json.quota,
      },
      result: result && { status: result.status, body: result.json },
    };
  } else if (testCase.pick) {
    picked = testCase.pick(response.json);
  }
  return { status: response.status, body: normalize(picked, instance), raw: picked };
}

async function runLeg(leg, options) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-resource-dualrun-"));
  const results = [];
  let api = null;
  let nodeA = null;
  let nodeB = null;
  let fakeAi = null;
  try {
    const calibrationTenantCsharp = randomTenant();
    fakeAi = await startFakeOpenAi();
    api = await spawnApi(leg, path.join(runtimeRoot, "csharp"), options.postgresUrl, calibrationTenantCsharp);
    nodeA = await startNode("a", {
      dataDir: path.join(runtimeRoot, "node-a"),
      datasourcesAuthority: "node",
      knowledgeAuthority: "node",
      calibrationGovernanceAuthority: "node",
      sharesAuthority: "node",
      analysisTasksAuthority: "node",
      dailyPerCaller: AI_DAILY_PER_CALLER,
      ...(leg === "postgres"
        ? { persistenceProvider: "postgres", postgresUrl: options.postgresUrl, postgresTenantId: randomTenant() }
        : {}),
    });
    nodeB = await startNode("b", {
      dataDir: path.join(runtimeRoot, "node-b"),
      datasourcesAuthority: "csharp",
      knowledgeAuthority: "csharp",
      calibrationGovernanceAuthority: "csharp",
      sharesAuthority: "csharp",
      // 只读切流要求 B 自己也把任务落到 C# 读的那张表：postgres 腿 B 开 PG 持久化并切 csharp，file 腿只能留 node。
      analysisTasksAuthority: ANALYSIS_TASKS_AUTHORITY_BY_LEG[leg],
      dailyPerCaller: AI_DAILY_PER_CALLER,
      ...(leg === "postgres"
        ? { persistenceProvider: "postgres", postgresUrl: options.postgresUrl, postgresTenantId: randomTenant() }
        : {}),
      gcodeAuthorityUrl: api.baseUrl,
      gcodeAuthorityInternalSecret: INTERNAL_SECRET,
    });
    nodeA.state.aiBaseUrl = fakeAi.origin + "/v1";
    nodeB.state.aiBaseUrl = fakeAi.origin + "/v1";

    for (const testCase of CASES) {
      const a = await runCase(nodeA, testCase);
      const b = await runCase(nodeB, testCase);
      const diffs = diffPaths({ status: a.status, body: a.body }, { status: b.status, body: b.body }, "", []);
      const waivers = WAIVERS.filter((waiver) => waiver.caseName === testCase.name);
      const unwaived = diffs.filter(
        (diff) =>
          !waivers.some((waiver) =>
            waiver.paths.some(
              (prefix) =>
                diff.path === prefix || diff.path.startsWith(prefix + ".") || diff.path.startsWith(prefix + "[")
            )
          )
      );
      const result = diffs.length === 0 ? "pass" : unwaived.length === 0 ? "waived" : "fail";
      results.push({
        leg,
        name: testCase.name,
        result,
        status: { node: a.status, csharp: b.status },
        diffs: diffs.map((diff) => ({
          path: diff.path,
          node: trimForReport(diff.a),
          csharp: trimForReport(diff.b),
          waived: !unwaived.includes(diff),
        })),
        // 截断的响应样本留在产物里，方便审阅「到底比了什么」；完整正文只在失败时才需要人工复跑。
        nodeBody: trimForReport(a.raw),
        ...(result === "pass" ? {} : { csharpBody: trimForReport(b.raw) }),
      });
      const tag = result === "pass" ? "PASS  " : result === "waived" ? "WAIVED" : "FAIL  ";
      process.stdout.write(
        `  ${tag} [${leg}] ${testCase.name} (${a.status}/${b.status})${result === "fail" ? " " + JSON.stringify(unwaived.slice(0, 3)) : ""}\n`
      );
    }
    return { results, apiOutput: api.output };
  } finally {
    if (nodeA) await nodeA.app.close().catch(() => {});
    if (nodeB) await nodeB.app.close().catch(() => {});
    if (api) await stop(api.child);
    if (fakeAi) await new Promise((resolve) => fakeAi.server.close(resolve));
    safeCleanup(runtimeRoot);
  }
}

async function main() {
  if (!fs.existsSync(apiDll)) {
    throw new Error(`Release API build missing: ${apiDll} — run \`npm run dotnet:build\` first`);
  }
  const postgresUrl = process.env.POSTGRES_URL || "";
  const legs = ["file"];
  const skipped = [];
  if (postgresUrl) legs.push("postgres");
  else skipped.push("postgres");

  const cases = [];
  for (const leg of legs) {
    process.stdout.write(`[resource dual-run: ${leg} leg]\n`);
    const { results } = await runLeg(leg, { postgresUrl });
    cases.push(...results);
  }

  const pass = cases.filter((item) => item.result === "pass").length;
  const waived = cases.filter((item) => item.result === "waived").length;
  const fail = cases.filter((item) => item.result === "fail").length;
  const report = {
    schemaVersion: "1.1",
    generatedAtUtc: new Date().toISOString(),
    legs,
    skipped,
    // 1.1：分析任务只读切流按腿记录 Node B 的权威——file 腿的 task-* 用例是 Node 对 Node。
    authority: {
      analysisTasks: Object.fromEntries(legs.map((leg) => [leg, ANALYSIS_TASKS_AUTHORITY_BY_LEG[leg]])),
    },
    cases: cases.length,
    pass,
    waived,
    fail,
    waivers: WAIVERS,
    results: cases,
  };
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + "\n");
  const summary = `Resource authority dual-run ${fail === 0 ? "PASS" : "FAIL"}: ${pass} pass / ${waived} waived / ${fail} fail over ${legs.join("+")} (skipped: ${skipped.join(",") || "none"})`;
  console.log(summary);
  console.log(`report=${path.relative(root, artifactPath)}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
