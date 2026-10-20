/* Node server.test.js 的公共 HTTP 契约替身。真实启动 ForgeX.Api，不导入 server/ 或 classic。
   需 Release 构建、React 产物、已迁移测试 POSTGRES_URL；没有数据库时失败，不静默跳过。
   运行时零外部 AI 调用。§10–14/17/18 的内部契约由 C# ResourceGate 接管，见部署文档。
*/
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { startSingleProcess } = require("../tools/lib/single-process");

const root = path.resolve(__dirname, "..");
const artifact = path.join(root, "backend/artifacts/csharp-server-contract.json");
const keyA = "contract-owner-" + crypto.randomBytes(12).toString("hex");
const keyB = "contract-other-" + crypto.randomBytes(12).toString("hex");
const reviewKey = "contract-review-" + crypto.randomBytes(12).toString("hex");
const internalSecret = "contract-internal-" + crypto.randomBytes(20).toString("hex");
const csv =
  "machine_id,material,status,date,duration_min,cost_fen,job_id\nM1,PLA,success,2026-10-01,100,300,JOB-1\nM1,PLA,fail,2026-10-02,90,250,JOB-2\nM2,ABS,success,2026-10-03,120,400,JOB-3\n";
const checks = [];
let group;

// ASP.NET HtmlEncoder 会把中文写成数字实体；比较浏览器可见文字，不依赖 HTML 编码风格。
function visibleText(html) {
  return html.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) =>
    String.fromCodePoint(value[0].toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value))
  );
}

function section(id, title) {
  group = id;
  console.log(`\n[${id}] ${title}`);
}

function check(name, condition, detail) {
  checks.push({ group, name, pass: !!condition });
  assert.ok(condition, `${name}${detail === undefined ? "" : ": " + String(detail).slice(0, 300)}`);
  console.log("  PASS " + name);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function call(api, pathname, body, options = {}) {
  const response = await fetch(api.baseUrl + pathname, {
    method: options.method || (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", "X-API-Key": keyA, ...options.headers },
    ...(body === undefined ? {} : { body: options.raw ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* 静态文件、SSE 与指标不是 JSON。 */
  }
  return { status: response.status, headers: response.headers, text, json };
}

function rawGet(api, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(api.baseUrl + pathname, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.setTimeout(10000, () => request.destroy(new Error("raw request timeout")));
  });
}

async function analyze(api, body) {
  const created = await call(api, "/api/analyze", body);
  assert.equal(created.status, 202, created.text);
  const id = created.json.taskId;
  const events = await call(api, `/api/analyze/${id}/stream`);
  assert.equal(events.status, 200, events.text);
  const result = await call(api, `/api/analyze/${id}/result`);
  assert.equal(result.status, 200, result.text);
  return { created, events, result, id };
}

function cleanup(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("forgex-csharp-contract-"));
  fs.rmSync(directory, { recursive: true, force: true });
}

async function main() {
  if (!process.env.POSTGRES_URL) throw new Error("POSTGRES_URL is required; use an isolated migrated test database.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-csharp-contract-"));
  const instances = [];
  const fixtureServers = [];
  const spawn = async (name, extraEnv = {}) => {
    const api = await startSingleProcess({
      port: await freePort(),
      storageRoot: path.join(directory, name),
      postgresUrl: process.env.POSTGRES_URL,
      apiKeys: `${keyA},${keyB}`,
      extraEnv: { InternalAuth__SharedSecret: internalSecret, ...extraEnv },
    });
    instances.push(api);
    return api;
  };
  let error;
  try {
    let api = await spawn("main");
    section(1, "健康检查与能力如实标记");
    const health = await call(api, "/healthz");
    check(
      "healthz 200 与持久化 provider",
      health.status === 200 && health.json.ok && health.json.persistence === "postgres"
    );
    check("规则引擎不冒充 AI", health.json.engine === "server-rules" && !health.json.capabilities.ai);
    check("模式原因与引擎文案", !!health.json.reason && /规则/.test(health.json.label));
    check("规则引擎不显示无用配额", health.json.quota === null);

    section(2, "静态 allowlist、HEAD 与路径边界");
    for (const pathname of [
      "/",
      "/legacy",
      "/frontend/classic/js/util.js",
      "/contracts/profiles/example-bundle.json",
      "/contracts/calibration/example-bundle.json",
    ]) {
      check("公开静态 " + pathname, (await call(api, pathname)).status === 200);
    }
    for (const pathname of [
      "/server/config.js",
      "/server/.env",
      "/doc/architecture.md",
      "/dist/react/index.html",
      "/react/index.html",
      "/react/assets/",
      "/react//assets/style.css",
    ]) {
      check("私有或非规范路径 " + pathname, (await call(api, pathname)).status === 404);
    }
    check("编码穿越拒绝", (await rawGet(api, "/react/assets/%2e%2e%2F%2e%2e%2Fserver%2Fconfig.js")) === 404);
    const html = await call(api, "/react/");
    const asset = html.text.match(/\/react\/assets\/[^"\s]+\.js/)[0];
    const js = await call(api, asset);
    check("构建资产 immutable 缓存", js.status === 200 && /immutable/.test(js.headers.get("cache-control")));
    const head = await call(api, asset, undefined, { method: "HEAD" });
    check("HEAD 不返回正文", head.status === 200 && head.text === "");

    section(3, "数据源、JSON 校验与来源声明");
    const uploaded = await call(api, "/api/datasource", { name: "contract.csv", csv });
    check("CSV 上传行数", uploaded.status === 201 && uploaded.json.rows === 3);
    const datasourceId = uploaded.json.datasourceId;
    check("空 CSV 拒绝", (await call(api, "/api/datasource", { csv: " " })).status === 400);
    const missingColumn = await call(api, "/api/datasource", { csv: "a,b\n1,2\n" });
    check("缺 status 列说明原因", missingColumn.status === 400 && /status/.test(missingColumn.json.error));
    const malformed = await call(api, "/api/datasource", "{{{", { raw: true });
    check("非法 JSON 为公共错误形状", malformed.status === 400 && typeof malformed.json.error === "string");
    const oversized = await call(api, "/api/datasource", { csv: "x".repeat(5 * 1024 * 1024) });
    check("超限请求为公共 413", oversized.status === 413 && typeof oversized.json.error === "string");
    const synthetic = await call(api, "/api/datasource", {
      csv,
      provenance: { source: "sim-farm", synthetic: true, badge: "机群仿真" },
    });
    check("合成来源保留", synthetic.status === 201 && synthetic.json.provenance.synthetic);
    const claimedReal = await call(api, "/api/datasource", {
      csv,
      provenance: { source: "real-production", synthetic: false },
    });
    check("客户端不能提升真实性", claimedReal.json.provenance.source === "user-upload");

    section(4, "分析创建、公共 SSE、重放和轮询");
    const sample = await analyze(api, { question: "哪台机故障率最高，主要故障是什么", datasourceId: "sample" });
    check(
      "创建返回任务 ID 与认证状态",
      /^t_[a-f0-9]{16}$/.test(sample.id) && sample.created.json.authenticated === true
    );
    check("SSE MIME", /text\/event-stream/.test(sample.events.headers.get("content-type")));
    check("SSE 无命名 event 帧", !/^event:/m.test(sample.events.text));
    const events = sample.events.text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)));
    check("三阶段加终态", events.length >= 4 && events.at(-1).done === true);
    check(
      "事件序号递增",
      events.every((event, index) => index === 0 || event.seq > events[index - 1].seq)
    );
    const replay = await call(api, `/api/analyze/${sample.id}/stream`);
    check("完成任务可重放", replay.text === sample.events.text);
    const poll = await call(api, `/api/analyze/${sample.id}`);
    check("轮询兜底完成状态", poll.status === 200 && poll.json.status === "done");
    check(
      "报告结构与意图",
      sample.result.json.intent === "machine_fault" &&
        !!sample.result.json.chart &&
        Array.isArray(sample.result.json.sections)
    );
    check("统计证据与置信度", sample.result.json.evidence.length > 0 && !!sample.result.json.confidence);
    check("内置样例仍标为合成", sample.result.json.provenance.synthetic === true);

    section(5, "上传数据端到端分析");
    const uploadedAnalysis = await analyze(api, { question: "哪台机故障率最高", datasourceId });
    check("报告只分析上传三行", uploadedAnalysis.result.json.rowCount === 3);
    const syntheticAnalysis = await analyze(api, {
      question: "哪台机故障率最高",
      datasourceId: synthetic.json.datasourceId,
    });
    check("合成标记穿过分析链", syntheticAnalysis.result.json.provenance.synthetic === true);

    section(6, "分析参数错误及敏感端点校验");
    for (const body of [
      {},
      { question: " " },
      { question: "x".repeat(501) },
      { question: "x", aiBaseUrl: 42 },
      { question: "x", aiBaseUrl: "ftp://ai.example", aiModel: "m" },
    ]) {
      const result = await call(api, "/api/analyze", body);
      check(
        "非法分析参数 " + JSON.stringify(body).slice(0, 70),
        result.status === 400 && typeof result.json.error === "string"
      );
    }
    check(
      "缺失数据源",
      (await call(api, "/api/analyze", { question: "x", datasourceId: "ds_missing" })).status === 404
    );
    check("缺失任务", (await call(api, "/api/analyze/t_missing/result")).status === 404);
    check("无效公共路由", (await call(api, "/api/unknown")).status === 404);

    section(7, "知识库上传");
    const document = await call(api, "/api/knowledge", {
      name: "术语",
      text: "翘边：首层与热床附着失效。\n\nABS 推荐 255 度。",
    });
    check("知识文档登记", document.status === 201 && !!document.json.knowledgeId && document.json.chunks > 0);
    check("空文档拒绝", (await call(api, "/api/knowledge", { text: " " })).status === 400);

    section(8, "分享页与未知资源");
    const shared = await call(api, `/api/share/${sample.id}`, {});
    check("分享返回公开地址", shared.status === 201 && /\/share\/[a-f0-9]+$/.test(shared.json.publicUrl));
    const share = shared.json;
    check(
      "分享含报告标题",
      visibleText((await call(api, `/share/${share.token}`)).text).includes(sample.result.json.title)
    );
    check("未知分享 404", (await call(api, "/share/deadbeefdeadbeef")).status === 404);
    check("未知任务不可分享", (await call(api, "/api/share/t_missing", {})).status === 404);

    section(9, "限流只限制创建分析");
    const limited = await spawn("rate", { PublicFacade__RateLimitMs: "60000" });
    check("首次创建放行", (await call(limited, "/api/analyze", { question: "成本趋势" })).status === 202);
    const throttled = await call(limited, "/api/analyze", { question: "成本趋势" });
    check("冷却期说明等待时间", throttled.status === 429 && /请求过于频繁，请 \d+ 秒后重试/.test(throttled.json.error));
    check("上传不受创建冷却影响", (await call(limited, "/api/datasource", { csv })).status === 201);
    await limited.stop();

    section(15, "知识检索能力标记");
    check("规则模式不声称注入知识", document.json.retrievalEnabled === false && /规则引擎/.test(document.json.note));
    const found = await call(api, "/api/knowledge/search", { question: "翘边" });
    check("检索命中与正分数", found.status === 200 && found.json.hits.length > 0 && found.json.hits[0].score > 0);
    const unrelated = await call(api, "/api/knowledge/search", { question: "zzz quantum foobar" });
    check("无关检索不给假命中", unrelated.json.hits.length === 0 && !!unrelated.json.note);

    section(16, "真实进程重启后数据可读");
    const restartPort = new URL(api.baseUrl).port;
    await api.stop();
    api = await startSingleProcess({
      port: Number(restartPort),
      storageRoot: path.join(directory, "main"),
      postgresUrl: process.env.POSTGRES_URL,
      apiKeys: `${keyA},${keyB}`,
      extraEnv: { InternalAuth__SharedSecret: internalSecret },
    });
    instances.push(api);
    check("报告跨重启保留", (await call(api, `/api/analyze/${sample.id}/result`)).text === sample.result.text);
    check("知识跨重启保留", (await call(api, "/api/knowledge/search", { question: "翘边" })).json.hits.length > 0);
    check("分享跨重启保留", (await call(api, `/share/${share.token}`)).status === 200);
    check(
      "上传数据跨重启保留",
      (await analyze(api, { question: "材料失败率", datasourceId })).result.json.rowCount === 3
    );

    section(19, "API key 身份隔离与强制鉴权");
    const other = { headers: { "X-API-Key": keyB } };
    check("他人任务隐藏为 404", (await call(api, `/api/analyze/${sample.id}/result`, undefined, other)).status === 404);
    check(
      "他人数据源不可分析",
      (await call(api, "/api/analyze", { question: "x", datasourceId }, other)).status === 404
    );
    check(
      "他人知识不可检索",
      (await call(api, "/api/knowledge/search", { question: "翘边" }, other)).json.hits.length === 0
    );
    const strict = await spawn("auth", {
      DirectAuth__RequireAuth: "true",
      DirectAuth__CalibrationReviewKeys: reviewKey,
    });
    check(
      "匿名强制鉴权 401",
      (await call(strict, "/api/datasource", { csv }, { headers: { "X-API-Key": "" } })).status === 401
    );
    check(
      "错误 key 401",
      (await call(strict, "/api/datasource", { csv }, { headers: { "X-API-Key": "wrong" } })).status === 401
    );
    check("正确 key 可上传", (await call(strict, "/api/datasource", { csv })).status === 201);
    check(
      "Bearer key 可用",
      (
        await call(
          strict,
          "/api/datasource",
          { csv },
          { headers: { "X-API-Key": "", Authorization: "Bearer " + keyA } }
        )
      ).status === 201
    );
    for (const pathname of [
      "/api/v1/gcode/analyze",
      "/api/v1/analytics/reports",
      "/api/v1/calibration/train",
      "/api/v1/analytics/datasets/normalize",
      "/api/v1/analytics/briefs",
      "/api/v1/calibration/validate",
      "/API/V1/GCODE/ANALYZE",
      "/API/V1/ANALYTICS/REPORTS",
      "/API/V1/CALIBRATION/TRAIN",
    ]) {
      const body =
        pathname.toLowerCase() === "/api/v1/gcode/analyze"
          ? "G90\nM82\nG92 E0\nG1 Z0.2 F600\nG1 X20 Y10 E1 F1200\n"
          : {};
      const requestOptions =
        typeof body === "string" ? { raw: true, headers: { "Content-Type": "application/x-gcode" } } : {};
      for (const headers of [{ "X-API-Key": "" }, { "X-API-Key": "wrong" }]) {
        const denied = await call(strict, pathname, body, {
          ...requestOptions,
          headers: { ...requestOptions.headers, ...headers },
        });
        check(pathname + " 拒绝匿名或错误 key", denied.status === 401, denied.text);
      }
      const accepted = await call(strict, pathname, body, requestOptions);
      check(pathname + " 正确 key 进入计算或参数校验", [200, 400].includes(accepted.status), accepted.text);
      const forged = await call(strict, pathname, body, {
        ...requestOptions,
        headers: { ...requestOptions.headers, "X-ForgeX-Internal-Token": "forged" },
      });
      check(pathname + " 伪造内部令牌不回退 key", forged.status === 401, forged.text);
    }
    for (const pathname of ["/api/v1/analytics/datasets/meta", "/api/v1/analytics/datasets/farm"]) {
      check(
        pathname + " 匿名受保护",
        (await call(strict, pathname, undefined, { headers: { "X-API-Key": "" } })).status === 401
      );
      check(pathname + " 正确 key 可访问", (await call(strict, pathname)).status === 200);
    }
    check(
      "公开校准目录保留匿名访问",
      (await call(strict, "/api/v1/calibrations", undefined, { headers: { "X-API-Key": "" } })).status === 200
    );
    for (const pathname of [
      "/API/DATASOURCE",
      "/API/KNOWLEDGE",
      "/API/ANALYZE",
      "/API/SHARE/missing",
      "/API/V1/DATASOURCES",
      "/API/V1/KNOWLEDGE",
      "/API/V1/ANALYSIS-TASKS",
      "/API/V1/SHARES",
      "/API/V1/GCODE/ANALYSES",
    ]) {
      const anonymous = await call(strict, pathname, {}, { headers: { "X-API-Key": "" } });
      check(pathname + " 大写路径执行强制鉴权", anonymous.status === 401, anonymous.text);
    }
    const uppercaseUpload = await call(strict, "/API/DATASOURCE", { csv });
    check("大写公共路径正确 key 可上传", uppercaseUpload.status === 201, uppercaseUpload.text);
    const uppercaseMissingJob = await call(strict, "/API/V1/JOBS/missing");
    check("大写作业路径正确 key 返回资源错误", uppercaseMissingJob.status === 404, uppercaseMissingJob.text);
    const uppercaseResult = await call(strict, `/API/ANALYZE/${sample.id}/result`);
    check(
      "大写路由保持资源 ID 与所属用户",
      uppercaseResult.status === 200 && uppercaseResult.text === sample.result.text
    );
    check(
      "大写路由不放宽资源隔离",
      (await call(strict, `/API/ANALYZE/${sample.id}/result`, undefined, other)).status === 404
    );
    check(
      "大写公开校准目录保持匿名访问",
      (await call(strict, "/API/CALIBRATIONS", undefined, { headers: { "X-API-Key": "" } })).status === 200
    );
    for (const pathname of ["/API/CALIBRATIONS/SUBMISSIONS", "/API/V1/CALIBRATIONS/SUBMISSIONS"]) {
      const submissions = await call(strict, pathname, undefined, { headers: { "X-API-Key": reviewKey } });
      check(pathname + " 独立审核 key 保持权限", submissions.status === 200, submissions.text);
    }
    const uppercaseShare = await call(strict, "/SHARE/missing", undefined, { headers: { "X-API-Key": "" } });
    check(
      "大写公开分享错误仍为公共方言",
      uppercaseShare.status === 404 && typeof uppercaseShare.json?.error === "string"
    );
    await strict.stop();

    section(20, "规则模式不消耗 AI 配额");
    check("规则任务不调用 AI", sample.created.json.willUseAi === false);
    check("规则任务无配额对象", sample.created.json.quota === null);
    // 只用本机假 OpenAI；验证公共 aiBaseUrl/aiApiKey/aiModel 字段确实走到 C# provider。
    const aiRequests = [];
    const fakeAi = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        aiRequests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "本机假模型叙述",
                    verdict: "仅供契约验证",
                    chart: { items: [{ v: 999999 }] },
                    evidence: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })
        );
      });
    });
    fixtureServers.push(fakeAi);
    await new Promise((resolve, reject) => {
      fakeAi.once("error", reject);
      fakeAi.listen(0, "127.0.0.1", resolve);
    });
    const ai = await spawn("ai", { Analysis__AiDailyPerCaller: "2", Analysis__AiDailyGlobal: "10" });
    const fixtureKey = "fixture-key-" + crypto.randomBytes(12).toString("hex");
    const aiBody = (question) => ({
      question,
      datasourceId: "sample",
      aiBaseUrl: `http://127.0.0.1:${fakeAi.address().port}/v1`,
      aiApiKey: fixtureKey,
      aiModel: "contract-model",
    });
    const firstAi = await analyze(ai, aiBody("哪台机故障率最高，主要故障是什么"));
    check(
      "公共请求可自带 AI 端点",
      firstAi.created.json.willUseAi && firstAi.result.json.engine === "openai-compatible"
    );
    check(
      "端点凭据只转发本机假服务",
      aiRequests.length === 1 && aiRequests[0].authorization === "Bearer " + fixtureKey
    );
    check("提示词使用统计简报", aiRequests[0].body.messages[1].content.includes("# 统计简报（已核验，勿重算）"));
    check(
      "上游不能覆盖权威图表",
      JSON.stringify(firstAi.result.json.chart) === JSON.stringify(sample.result.json.chart)
    );
    check("上游不能清空证据", firstAi.result.json.evidence.length > 0);
    check("报告包含真实 token 用量", firstAi.result.json.tokenUsage.total_tokens === 15);
    const cached = await analyze(ai, aiBody("哪台机故障率最高，主要故障是什么"));
    check("同问缓存不二次调用模型", cached.result.json.cached === true && aiRequests.length === 1);
    check("缓存不重复扣额", cached.created.json.quota.remaining === 1);
    await analyze(ai, aiBody("材料失败率"));
    const degraded = await analyze(ai, aiBody("成本趋势"));
    check(
      "额度用尽正常返回规则报告",
      !degraded.created.json.willUseAi && degraded.result.json.engine === "server-rules"
    );
    check(
      "额度耗尽原因可见",
      /额度已用尽/.test(degraded.created.json.quota.reason) && degraded.result.json.degradedFrom === "openai-compatible"
    );
    check("降级不再访问模型", aiRequests.length === 2);
    const stored = await call(ai, `/api/v1/analysis-tasks/${firstAi.id}`);
    check("快照不包含 AI 密钥", stored.status === 200 && !stored.text.includes(fixtureKey));
    await ai.stop();

    section(21, "Prometheus 指标契约");
    const metrics = await call(api, "/metrics");
    check("Prometheus MIME", metrics.status === 200 && /text\/plain/.test(metrics.headers.get("content-type")));
    for (const name of [
      "forgex_tasks_total",
      "forgex_ai_daily_limit",
      "forgex_datasources",
      "forgex_http_requests_total",
    ]) {
      check("指标 " + name, metrics.text.includes(name));
    }
    check(
      "HELP 与 TYPE 声明",
      /# HELP forgex_tasks_total/.test(metrics.text) && /# TYPE forgex_tasks_total counter/.test(metrics.text)
    );

    section(22, "分享披露、撤销密钥与重启保持");
    const page = visibleText((await call(api, `/share/${share.token}`)).text);
    check("公开页披露可信度", /可信度/.test(page));
    check("公开页披露合成来源", /非真实产线数据/.test(page));
    check("规则引擎如实标注", /规则引擎/.test(page) && !/云端 AI/.test(page));
    check("撤销密钥和有效期", !!share.revokeKey && share.expiresAt > Date.now());
    check(
      "错误撤销密钥拒绝",
      (await call(api, `/api/share/${share.token}/revoke`, { revokeKey: "wrong" })).status === 403
    );
    check("撤销失败仍可访问", (await call(api, `/share/${share.token}`)).status === 200);
    check(
      "正确密钥可撤销",
      (await call(api, `/api/share/${share.token}/revoke`, { revokeKey: share.revokeKey })).status === 200
    );
    check("撤销后立即失效", (await call(api, `/share/${share.token}`)).status === 404);

    section(23, "G-code 直接权威端点替代 Node 代理");
    const response = await fetch(api.baseUrl + "/api/v1/gcode/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode", "X-API-Key": keyA },
      body: "G90\nM82\nG92 E0\nG1 Z0.2 F600\nG1 X10 Y10 F3000\nG1 X20 Y10 E1 F1200\nG1 X20 Y20 E2\n",
      signal: AbortSignal.timeout(20000),
    });
    const gcode = await response.json();
    check("直接分析返回权威结果", response.status === 200 && gcode.engine?.version);
    check("直接调用有追踪标记", !!response.headers.get("traceparent") || !!response.headers.get("x-correlation-id"));
    const spoofed = await fetch(api.baseUrl + "/api/v1/gcode/analyses", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-gcode",
        "X-API-Key": keyA,
        "X-ForgeX-Internal-Token": "forged-token",
        "X-ForgeX-Tenant-Id": "tn_" + "f".repeat(32),
        "X-ForgeX-Owner-Id": "ow_" + "f".repeat(32),
      },
      body: "G28\n",
      signal: AbortSignal.timeout(10000),
    });
    check("作业伪造内部身份被拒绝", spoofed.status === 401, spoofed.status + " " + (await spoofed.text()));

    section(24, "路由错误不被公共门面吞掉");
    for (const pathname of ["/api/v1/gcode/analyze", "/api/v1/analytics/reports", "/api/v1/calibration/train"]) {
      const unsupported = await call(api, pathname, "not supported", {
        raw: true,
        headers: { "Content-Type": "text/plain" },
      });
      check(pathname + " 内容类型错误保留 415", unsupported.status === 415, unsupported.text);
      check(
        pathname + " 内容类型错误保留问题契约",
        /application\/problem\+json/.test(unsupported.headers.get("content-type")) &&
          unsupported.json?.code === "unsupported_media_type"
      );
      const method = await call(api, pathname);
      check(
        pathname + " 方法错误保留 405 与 Allow",
        method.status === 405 && method.headers.get("allow") === "POST",
        method.text
      );
      check(pathname + " 方法错误保留问题契约", method.json?.code === "method_not_allowed");
    }
    for (const method of ["GET", "POST", "DELETE", "HEAD"]) {
      for (const pathname of ["/api/route-missing", "/API/ROUTE-MISSING", "/api/datasource"]) {
        // 数据源的 POST 是有效路由，只测其余不支持的方法。
        if (method === "POST" && pathname === "/api/datasource") continue;
        const missing = await call(api, pathname, undefined, { method });
        check(
          method + " " + pathname + " 保留公共 404",
          missing.status === 404 && (method === "HEAD" ? missing.text === "" : missing.json?.error === "接口不存在"),
          missing.text
        );
        check(method + " " + pathname + " 不遗留 Allow", !missing.headers.has("allow"));
      }
      const internal = await call(api, "/API/V1/ROUTE-MISSING", undefined, { method });
      check(
        method + " 内部未知路径保持问题契约",
        internal.status === 404 &&
          /application\/problem\+json/.test(internal.headers.get("content-type")) &&
          (method === "HEAD" ? internal.text === "" : internal.json?.code === "route_not_found"),
        internal.text
      );
    }
  } catch (exception) {
    error = exception;
  } finally {
    for (const api of instances.reverse()) await api.stop();
    for (const server of fixtureServers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    cleanup(directory);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(
      artifact,
      JSON.stringify(
        {
          schemaVersion: 1,
          result: error ? "fail" : "pass",
          generatedAtUtc: new Date().toISOString(),
          process: "ForgeX.Api",
          checks,
          error: error?.message,
        },
        null,
        2
      ) + "\n"
    );
  }
  if (error) throw error;
  console.log(`C# public server contract PASS ${checks.length}/${checks.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
