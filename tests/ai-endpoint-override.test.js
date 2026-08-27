/* 用户自带 OpenAI 兼容端点（请求级覆盖）集成测试。
 *
 * 用 node:http 起假 OpenAI 端点（记录 Authorization 与请求体），验证：
 *   [1] 字段校验：协议 / 内嵌凭据 / 片段 / 查询参数 / 长度上限 / 类型，
 *       错误信息不回显密钥；
 *   [2] 覆盖生效：合法 aiBaseUrl/aiApiKey/aiModel 使该次请求直连用户端点，
 *       Bearer 与 model 逐字节到达上游，报告 engine/narrativeBy 如实标注；
 *   [3] 优先级：请求级 > 环境变量（OPENAI_*）> 本地规则引擎回退；
 *   [4] 密钥安全：不落日志、不回显（202/SSE/result/错误信息）、不进持久化快照；
 *   [5] 结果缓存按「端点+模型」分桶：同覆盖命中缓存，换模型不串桶。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createApp } = require("../server/index");

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forgex-ai-override-"));
}

/** 假 OpenAI 兼容端点：记录请求，按 state.mode 返回正常叙述或回显密钥的 500。 */
function createFakeOpenAI(tag) {
  const observed = [];
  const state = { mode: "ok" };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      observed.push({ url: req.url, authorization: req.headers.authorization || "", body });
      if (state.mode === "error-echoing-key") {
        // 模拟上游把请求密钥回显进错误报文（OpenAI 真实行为的夸张版）
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Incorrect API key provided: " + (req.headers.authorization || "") } }));
        return;
      }
      const narrative = {
        title: "叙述@" + tag,
        verdict: "由 " + tag + " 端点生成的叙述结论",
        sections: [{ h: "AI 小节", lines: ["要点来自 " + tag] }],
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(narrative) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        })
      );
    });
  });
  return { server, observed, state };
}

async function analyzeAndWait(base, payload) {
  const created = await fetch(base + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const createdBody = await created.json().catch(() => null);
  if (created.status !== 202) return { created, createdBody, result: null, resultBody: null };
  const taskId = createdBody.taskId;
  for (let i = 0; i < 200; i++) {
    const result = await fetch(base + "/api/analyze/" + taskId + "/result");
    if (result.status !== 202) {
      const text = await result.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { created, createdBody, result, resultBody: json, resultText: text, taskId };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("任务超时未终态");
}

async function main() {
  const USER_KEY = "sk-user-secret-override-000111222333";
  const ENV_KEY = "sk-env-secret-444555666";

  const userEndpoint = createFakeOpenAI("user");
  const envEndpoint = createFakeOpenAI("env");
  const userOrigin = `http://127.0.0.1:${await listen(userEndpoint.server)}/v1`;
  const envOrigin = `http://127.0.0.1:${await listen(envEndpoint.server)}/v1`;

  /* ── [1] 字段校验 ─────────────────────────────────────────────── */
  console.log("[1] aiBaseUrl / aiApiKey / aiModel 校验");
  const plainDir = tmpDir();
  const plainApp = createApp({ logLevel: "error", rateLimitMs: 0, dataDir: plainDir });
  const plainBase = `http://127.0.0.1:${await listen(plainApp.server)}`;
  try {
    const cases = [
      [{ aiBaseUrl: "ftp://x.example/v1", aiModel: "m" }, /只允许 http/, "非 http(s) 协议被拒绝"],
      [{ aiBaseUrl: "https://user:pass@x.example/v1", aiModel: "m" }, /禁止内嵌凭据/, "内嵌凭据被拒绝"],
      [{ aiBaseUrl: "https://x.example/v1#frag", aiModel: "m" }, /禁止携带片段/, "片段被拒绝"],
      [{ aiBaseUrl: "https://x.example/v1?tenant=1", aiModel: "m" }, /禁止携带查询参数/, "查询参数被拒绝"],
      [{ aiBaseUrl: "not-a-url", aiModel: "m" }, /合法的 http\(s\) URL/, "非法 URL 被拒绝"],
      [{ aiBaseUrl: userOrigin }, /同时提供 aiBaseUrl 与 aiModel/, "缺 aiModel 被拒绝"],
      [{ aiModel: "m" }, /同时提供 aiBaseUrl 与 aiModel/, "缺 aiBaseUrl 被拒绝"],
      [{ aiBaseUrl: userOrigin, aiModel: "m".repeat(129) }, /aiModel 超过 128/, "aiModel 超长被拒绝"],
      [{ aiBaseUrl: "https://" + "x".repeat(1024) + ".example/v1", aiModel: "m" }, /aiBaseUrl 超过 1024/, "aiBaseUrl 超长被拒绝"],
      [{ aiBaseUrl: userOrigin, aiModel: "m", aiApiKey: 123 }, /aiApiKey 必须是字符串/, "aiApiKey 非字符串被拒绝"],
    ];
    for (const [override, pattern, name] of cases) {
      const res = await fetch(plainBase + "/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ question: "校验", datasourceId: "sample" }, override)),
      });
      const body = await res.json();
      check(name, res.status === 400 && pattern.test(body.error || ""), res.status + " " + JSON.stringify(body));
    }

    const longKey = "sk-" + "a".repeat(513);
    const longKeyRes = await fetch(plainBase + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "校验", datasourceId: "sample", aiBaseUrl: userOrigin, aiModel: "m", aiApiKey: longKey }),
    });
    const longKeyText = await longKeyRes.text();
    check("aiApiKey 超长被拒绝", longKeyRes.status === 400 && /aiApiKey 超过 512/.test(longKeyText), longKeyText);
    check("超长密钥错误信息不回显密钥", !longKeyText.includes(longKey.slice(0, 32)), longKeyText.slice(0, 120));

    // 全部留空 = 未提供覆盖：走默认本地规则引擎（AI 不是前置条件）
    const blank = await analyzeAndWait(plainBase, {
      question: "哪台机故障率最高",
      datasourceId: "sample",
      aiBaseUrl: "",
      aiApiKey: "",
      aiModel: "",
    });
    check(
      "三字段全空视为未提供 → 本地规则引擎",
      blank.created.status === 202 && blank.createdBody.engine === "server-rules" && blank.createdBody.willUseAi === false,
      JSON.stringify(blank.createdBody)
    );

    /* ── [2] 覆盖生效（无环境变量配置的服务器） ─────────────────── */
    console.log("[2] 请求级覆盖直连用户端点");
    const override = await analyzeAndWait(plainBase, {
      question: "哪台机故障率最高",
      datasourceId: "sample",
      aiBaseUrl: userOrigin,
      aiApiKey: USER_KEY,
      aiModel: "user-model-x",
    });
    check("覆盖请求 202 且 willUseAi=true", override.created.status === 202 && override.createdBody.willUseAi === true, JSON.stringify(override.createdBody));
    check("任务 engine 标注 openai-compatible", override.createdBody.engine === "openai-compatible", override.createdBody.engine);
    check("报告完成且叙述来自用户端点", override.result.status === 200 && /user 端点/.test(override.resultBody.verdict || ""), JSON.stringify(override.resultBody && override.resultBody.verdict));
    check("报告 narrativeBy/model 标注用户模型", override.resultBody.narrativeBy === "user-model-x" && override.resultBody.model === "user-model-x", override.resultBody.narrativeBy);
    check("数字仍由本地统计核负责", override.resultBody.statsBy === "local-stats-kernel", override.resultBody.statsBy);
    const upstream = userEndpoint.observed.at(-1);
    check("上游收到用户密钥 Bearer", upstream && upstream.authorization === "Bearer " + USER_KEY, upstream && upstream.authorization.slice(0, 16));
    check("上游收到用户模型与 /v1/chat/completions 路径", upstream && upstream.url === "/v1/chat/completions" && upstream.body && upstream.body.model === "user-model-x", upstream && upstream.url);
    check("202 响应不含密钥", !JSON.stringify(override.createdBody).includes(USER_KEY));
    check("结果响应不含密钥", !override.resultText.includes(USER_KEY));

    // SSE 事件流不含密钥
    const events = await fetch(plainBase + "/api/analyze/" + override.taskId + "/stream").then((r) => r.text());
    check("SSE 事件流不含密钥", !events.includes(USER_KEY));

    // 持久化快照（PostgresAnalysisStore._snapshot 是唯一落库形状）不含密钥
    const { PostgresAnalysisStore } = require("../server/services/postgres-analysis");
    const snapshotStore = new PostgresAnalysisStore({ taskTtlMs: 1000, postgresPool: {} }, null, {});
    const liveTask = plainApp.ctx.tasks.get(override.taskId);
    const snapshot = snapshotStore._snapshot(liveTask);
    check("持久化快照不含密钥", !JSON.stringify(snapshot).includes(USER_KEY));
    check("持久化快照不含 providerImpl 闭包", !("providerImpl" in snapshot) && !("aiOverride" in snapshot));

    /* ── [5] 缓存按端点+模型分桶 ─────────────────────────────────── */
    console.log("[5] 结果缓存分桶");
    const hitsBefore = userEndpoint.observed.length;
    const repeat = await analyzeAndWait(plainBase, {
      question: "哪台机故障率最高",
      datasourceId: "sample",
      aiBaseUrl: userOrigin,
      aiApiKey: USER_KEY,
      aiModel: "user-model-x",
    });
    check("同覆盖重复提问命中缓存", repeat.resultBody.cached === true && userEndpoint.observed.length === hitsBefore, String(userEndpoint.observed.length - hitsBefore));
    const otherModel = await analyzeAndWait(plainBase, {
      question: "哪台机故障率最高",
      datasourceId: "sample",
      aiBaseUrl: userOrigin,
      aiApiKey: USER_KEY,
      aiModel: "user-model-y",
    });
    check(
      "换模型不串缓存桶",
      otherModel.resultBody.cached !== true && otherModel.resultBody.narrativeBy === "user-model-y" && userEndpoint.observed.length === hitsBefore + 1,
      JSON.stringify({ cached: otherModel.resultBody.cached, narrativeBy: otherModel.resultBody.narrativeBy })
    );

    /* ── [4] 密钥安全：上游回显密钥的错误路径 ────────────────────── */
    console.log("[4] 上游错误回显密钥时的掩蔽");
    const loggedLines = [];
    const originalError = plainApp.log.error;
    plainApp.log.error = (message, fields) => {
      loggedLines.push(message + " " + JSON.stringify(fields || {}));
    };
    userEndpoint.state.mode = "error-echoing-key";
    const failing = await analyzeAndWait(plainBase, {
      question: "上游报错回显密钥",
      datasourceId: "sample",
      aiBaseUrl: userOrigin,
      aiApiKey: USER_KEY,
      aiModel: "user-model-x",
    });
    plainApp.log.error = originalError;
    userEndpoint.state.mode = "ok";
    check("上游 500 → 任务失败 502", failing.result.status === 502, failing.result.status);
    check("失败错误信息不含密钥", !failing.resultText.includes(USER_KEY), failing.resultText.slice(0, 120));
    check("错误日志已掩蔽密钥", loggedLines.length > 0 && loggedLines.every((line) => !line.includes(USER_KEY)), loggedLines[0] && loggedLines[0].slice(0, 160));
  } finally {
    await plainApp.close();
    fs.rmSync(plainDir, { recursive: true, force: true });
  }

  /* ── [3] 优先级：请求级 > 环境变量 > 本地回退 ─────────────────── */
  console.log("[3] 优先级链");
  const envDir = tmpDir();
  const envApp = createApp({
    logLevel: "error",
    rateLimitMs: 0,
    dataDir: envDir,
    openaiKey: ENV_KEY,
    openaiBaseUrl: envOrigin,
    openaiModel: "env-model",
    providerPref: "openai",
  });
  const envBase = `http://127.0.0.1:${await listen(envApp.server)}`;
  try {
    const viaEnv = await analyzeAndWait(envBase, { question: "环境变量端点", datasourceId: "sample" });
    const envSeen = envEndpoint.observed.at(-1);
    check("无覆盖时走环境变量端点", /env 端点/.test(viaEnv.resultBody.verdict || "") && envSeen && envSeen.authorization === "Bearer " + ENV_KEY, JSON.stringify(viaEnv.resultBody.verdict));

    const envHits = envEndpoint.observed.length;
    const viaOverride = await analyzeAndWait(envBase, {
      question: "请求级覆盖优先",
      datasourceId: "sample",
      aiBaseUrl: userOrigin,
      aiApiKey: USER_KEY,
      aiModel: "user-model-x",
    });
    const overrideSeen = userEndpoint.observed.at(-1);
    check(
      "有覆盖时环境变量端点零流量、用户端点收到请求",
      envEndpoint.observed.length === envHits && overrideSeen && overrideSeen.authorization === "Bearer " + USER_KEY,
      JSON.stringify({ envHits: envEndpoint.observed.length - envHits })
    );
    check("覆盖叙述来自用户端点", /user 端点/.test(viaOverride.resultBody.verdict || ""), viaOverride.resultBody.verdict);
  } finally {
    await envApp.close();
    fs.rmSync(envDir, { recursive: true, force: true });
  }

  await close(userEndpoint.server);
  await close(envEndpoint.server);

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
