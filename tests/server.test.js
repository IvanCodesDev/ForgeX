/* FORGE·X 后端契约测试（node tests/server.test.js）
   覆盖：healthz / 数据源上传 / 分析任务 + SSE 进度 + 结果 / 轮询兜底 /
        知识库 / 分享页 / 静态托管 allowlist 与路径穿越 / 输入校验 / 限流。
   进程内起服务（端口 0 随机），规则引擎（forceMock），不依赖外部网络。 */
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { createApp } = require("../server/index");
const { getConfig, GCODE_AUTHORITY_HARD_MAX_BYTES } = require("../server/config");

/* 测试必须与真实数据完全隔离：每个实例一个临时目录，跑完删掉。
   否则测试会往仓库的 data/ 里写文件，还会读到上一次跑的残留。 */
const TMP_DIRS = [];
function tmpDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-test-"));
  TMP_DIRS.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }
  }
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

function listen(app) {
  return new Promise((resolve) => {
    app.server.listen(0, "127.0.0.1", () => resolve(app.server.address().port));
  });
}

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rawRequest(url, headers, chunks) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(target, { method: "POST", headers: headers || {} }, (res) => {
      const body = [];
      res.on("data", (chunk) => body.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(body).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    for (const chunk of chunks || []) req.write(chunk);
    req.end();
  });
}

async function jfetch(base, path, opts) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, json, text, headers: res.headers };
}

function post(base, path, body) {
  return jfetch(base, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 收集 SSE 事件直到 done 或超时 */
function collectSse(base, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(base + path, (res) => {
      if (res.statusCode !== 200) { reject(new Error("SSE HTTP " + res.statusCode)); return; }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              events.push(ev);
              if (ev.done) { req.destroy(); resolve({ events, contentType: res.headers["content-type"] }); return; }
            } catch (e) { /* 心跳注释行 */ }
          }
        }
      });
      res.on("end", () => resolve({ events, contentType: res.headers["content-type"] }));
    });
    req.on("error", (e) => reject(e));
    setTimeout(() => { req.destroy(); reject(new Error("SSE 超时")); }, timeoutMs);
  });
}

const CSV_OK = [
  "任务编号,日期,机台,模型,材料,层高,耗时,耗材克重,成本元,状态,故障类型,能耗",
  "J1,2026-07-01,FX-256-01,行星齿轮,PLA,0.2,95,34.2,3.51,success,,0.38",
  "J2,2026-07-02,FX-256-03,传感器支架,ABS,0.2,40,12.0,1.20,失败,堵料,0.22",
  "J3,2026-07-03,FX-256-03,传感器支架,ABS,0.2,44,13.0,1.25,失败,堵料,0.24",
].join("\n");

async function main() {
  // forceMock：契约测试必须确定性、零外部网络——即使开发机 .env 已配真实 key 也绝不外呼
  const app = createApp({ rateLimitMs: 0, mockDelayMs: 5, logLevel: "error", forceMock: true, dataDir: tmpDataDir() });
  const port = await listen(app);
  const base = "http://127.0.0.1:" + port;

  console.log("\n[1] 健康检查与引擎模式");
  {
    const r = await jfetch(base, "/healthz");
    check("healthz 200 且 ok:true", r.status === 200 && r.json && r.json.ok === true, r.text);
    check("门禁生效：未配密钥时为规则引擎", r.json.engine === "server-rules", r.json && r.json.engine);
    check("healthz 报出 provider 与能力", r.json.provider === "local" && r.json.capabilities.ai === false,
      JSON.stringify({ p: r.json.provider, c: r.json.capabilities }));
    check("healthz 的 engine 与报告的 engine 同源", typeof r.json.label === "string" && r.json.label.length > 0, r.json.label);
    check("附带模式原因说明", typeof r.json.reason === "string" && r.json.reason.length > 0);
  }

  console.log("\n[2] 静态托管 allowlist 与路径穿越");
  {
    const home = await jfetch(base, "/");
    check("GET / 返回前端页面", home.status === 200 && home.text.includes("FORGE·X"), String(home.status));
    const js = await jfetch(base, "/frontend/classic/js/util.js");
    check("GET /frontend/classic/js/util.js 可达", js.status === 200 && js.text.includes("FXU"));
    const profile = await jfetch(base, "/contracts/profiles/example-bundle.json");
    check("公开 Profile 示例可达", profile.status === 200 && profile.text.includes("forgex-profile-bundle"));
    const calibrationExample = await jfetch(base, "/contracts/calibration/example-bundle.json");
    check(
      "公开校准包示例可达且标记为 demonstration",
      calibrationExample.status === 200 && calibrationExample.text.includes("demonstration-only")
    );
    const validation = await jfetch(base, "/contracts/validation/time-calibration-report.json");
    check(
      "公开校准报告可达且保留 provenance",
      validation.status === 200 && validation.text.includes("synthetic-conformance")
    );
    const cfgFile = await jfetch(base, "/server/config.js");
    check("server/ 目录不可达", cfgFile.status === 404, String(cfgFile.status));
    const env = await jfetch(base, "/server/.env");
    check(".env 不可达", env.status === 404, String(env.status));
    const trav = await jfetch(base, "/frontend/classic/js/..%2F..%2F..%2Fserver%2Fconfig.js");
    check("编码路径穿越被拒", trav.status === 404, String(trav.status));
    const docs = await jfetch(base, "/doc/architecture.md");
    check("已移除的 doc 目录不可达", docs.status === 404, String(docs.status));
  }

  console.log("\n[2b] React 构建产物严格映射");
  {
    // 不依赖工作区里是否恰好存在 dist：临时构造一份最小 Vite 产物，
    // 从而保证 clean checkout 与开发机重复运行的结果完全一致。
    const staticRoot = tmpDataDir();
    const reactDist = path.join(staticRoot, "dist", "react");
    const assetsDir = path.join(reactDist, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(reactDist, "index.html"), "<!doctype html><title>React fixture</title>");
    fs.writeFileSync(path.join(assetsDir, "app-abc123.js"), "globalThis.__REACT_FIXTURE__=true;");

    const reactApp = createApp({
      staticRoot,
      dataDir: tmpDataDir(),
      rateLimitMs: 0,
      logLevel: "error",
      forceMock: true,
    });
    const reactBase = "http://127.0.0.1:" + (await listen(reactApp));

    const noSlash = await jfetch(reactBase, "/react");
    check("GET /react 映射到 React index", noSlash.status === 200 && /React fixture/.test(noSlash.text), noSlash.text);
    const slash = await jfetch(reactBase, "/react/");
    check("GET /react/ 映射到 React index", slash.status === 200 && /React fixture/.test(slash.text), slash.text);
    const asset = await jfetch(reactBase, "/react/assets/app-abc123.js");
    check("仅 /react/assets/* 映射构建资产", asset.status === 200 && /REACT_FIXTURE/.test(asset.text), asset.text);
    check(
      "React 哈希资产使用 immutable 缓存",
      /immutable/.test(asset.headers.get("cache-control") || ""),
      asset.headers.get("cache-control")
    );
    const head = await jfetch(reactBase, "/react/assets/app-abc123.js", { method: "HEAD" });
    check("React 资产支持 HEAD 且不返回正文", head.status === 200 && head.text === "", JSON.stringify(head));

    const directDist = await jfetch(reactBase, "/dist/react/index.html");
    check("磁盘 dist 路径不可直接访问", directDist.status === 404, String(directDist.status));
    const rootAsset = await jfetch(reactBase, "/assets/app-abc123.js");
    check("React 资产不泄露到根 /assets", rootAsset.status === 404, String(rootAsset.status));
    const extraEntry = await jfetch(reactBase, "/react/index.html");
    check("React 非约定入口默认拒绝", extraEntry.status === 404, String(extraEntry.status));
    const emptyAsset = await jfetch(reactBase, "/react/assets/");
    check("React assets 目录不可列出", emptyAsset.status === 404, String(emptyAsset.status));
    const encodedTraversal = await jfetch(
      reactBase,
      "/react/assets/%2e%2e%2Fassets%2Fapp-abc123.js"
    );
    check("React assets 编码点路径被拒绝", encodedTraversal.status === 404, String(encodedTraversal.status));
    const nonCanonical = await jfetch(reactBase, "/react//assets/app-abc123.js");
    check("React 非规范双斜杠路径被拒绝", nonCanonical.status === 404, String(nonCanonical.status));

    fs.rmSync(reactDist, { recursive: true, force: true });
    const missing = await jfetch(reactBase, "/react");
    check("React 构建产物缺失时明确返回 404", missing.status === 404, String(missing.status));
    await reactApp.close();
  }

  console.log("\n[3] 数据源上传与校验");
  let dsId;
  {
    const ok = await post(base, "/api/datasource", { name: "test.csv", csv: CSV_OK });
    dsId = ok.json && ok.json.datasourceId;
    check("合法 CSV → 201 + datasourceId", ok.status === 201 && !!dsId, ok.text);
    check("返回解析行数 3", ok.json && ok.json.rows === 3, ok.json && String(ok.json.rows));
    const empty = await post(base, "/api/datasource", { name: "x.csv", csv: "  " });
    check("空 csv → 400", empty.status === 400, String(empty.status));
    const bad = await post(base, "/api/datasource", { name: "x.csv", csv: "a,b\n1,2" });
    check("缺 status 列 → 400 且给出原因", bad.status === 400 && bad.json.error.includes("status"), bad.text);
    const badJson = await jfetch(base, "/api/datasource", { method: "POST", body: "{{{", headers: { "Content-Type": "application/json" } });
    check("非法 JSON → 400", badJson.status === 400, String(badJson.status));

    /* 来源标记必须能穿过后端。
       曾经的缺陷：前端把「机群仿真」数据上传来分析，后端一律标成 user-upload，
       于是**合成数据经过后端一趟就变成了「真实数据」**，报告里的合成标记消失。
       这是 provenance 契约要防的头号问题，由 E2E 测试抓到。 */
    const synth = await post(base, "/api/datasource", {
      name: "s.csv", csv: CSV_OK, provenance: { source: "sim-farm", synthetic: true, badge: "机群仿真" },
    });
    check("合成来源穿过后端不丢失", synth.json.provenance && synth.json.provenance.synthetic === true,
      JSON.stringify(synth.json.provenance));
    const sr = await post(base, "/api/analyze", { question: "哪台机故障率最高", datasourceId: synth.json.datasourceId });
    await collectSse(base, "/api/analyze/" + sr.json.taskId + "/stream", 8000);
    const srep = await jfetch(base, "/api/analyze/" + sr.json.taskId + "/result");
    check("报告继承合成标记", srep.json.provenance && srep.json.provenance.synthetic === true,
      JSON.stringify(srep.json.provenance));

    // 反方向不采信：客户端不能把数据声明成「更真实」
    const lie = await post(base, "/api/datasource", {
      name: "l.csv", csv: CSV_OK, provenance: { source: "real-production", synthetic: false, badge: "真实产线" },
    });
    check("客户端不能把数据标成更真实（只能更谨慎）",
      lie.json.provenance.source === "user-upload", JSON.stringify(lie.json.provenance));
    const weird = await post(base, "/api/datasource", {
      name: "w.csv", csv: CSV_OK, provenance: { source: "某种未知来源", synthetic: true },
    });
    check("未知来源但自称合成 → 保守标出",
      weird.json.provenance.synthetic === true, JSON.stringify(weird.json.provenance));
  }

  console.log("\n[4] 分析任务：创建 → SSE 进度 → 结果（内置示例数据）");
  let taskId;
  {
    const r = await post(base, "/api/analyze", { question: "哪台机故障率最高，主要故障是什么", datasourceId: "sample" });
    taskId = r.json && r.json.taskId;
    check("建任务 → 202 + taskId", r.status === 202 && !!taskId, r.text);
    check("返回引擎标识 server-rules", r.json.engine === "server-rules", r.json && r.json.engine);

    const sse = await collectSse(base, "/api/analyze/" + taskId + "/stream", 5000);
    check("SSE Content-Type 正确", String(sse.contentType).startsWith("text/event-stream"), sse.contentType);
    check("SSE 事件 ≥ 4（3 步 + done）", sse.events.length >= 4, String(sse.events.length));
    check("SSE 末事件为 done", sse.events[sse.events.length - 1].done === true);
    const seqs = sse.events.map((e) => e.seq);
    check("事件 seq 单调递增", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs.join(","));

    const res = await jfetch(base, "/api/analyze/" + taskId + "/result");
    check("结果 → 200 报告", res.status === 200 && !!res.json, String(res.status));
    const rp = res.json;
    check("意图命中 machine_fault（UTF-8 中文）", rp.intent === "machine_fault", rp.intent);
    check("报告结构完整（title/verdict/sections/chart）",
      !!rp.title && !!rp.verdict && Array.isArray(rp.sections) && rp.chart && Array.isArray(rp.chart.items));
    // 断言性质而非「命中生成器埋的故事线」：结论指向的机台必须真实存在于数据集中
    check("结论指向数据集中真实存在的机台",
      !!rp.highlight && rp.json !== null && typeof rp.highlight.id === "string" && rp.highlight.id.length > 0,
      JSON.stringify(rp.highlight));
    check("报告带来源标记（内置数据集须标为合成）",
      !!rp.provenance && rp.provenance.synthetic === true, JSON.stringify(rp.provenance));
    check("报告带可信度字段", typeof rp.confidence === "string" && rp.confidence.length > 0, rp.confidence);
    check("视口联动 highlight 存在", rp.highlight && rp.highlight.type === "machine");
    check("engine 如实标注 server-rules（不冒充 AI / InfiniSynapse）", rp.engine === "server-rules", rp.engine);

    // SSE 重放：任务完成后再接入，也能拿到全部历史事件
    const replay = await collectSse(base, "/api/analyze/" + taskId + "/stream", 3000);
    check("终态任务 SSE 重放全部事件", replay.events.length === sse.events.length,
      replay.events.length + " vs " + sse.events.length);

    const poll = await jfetch(base, "/api/analyze/" + taskId);
    check("轮询兜底：status=done + progress=1", poll.json && poll.json.status === "done" && poll.json.progress === 1, poll.text);
  }

  console.log("\n[5] 上传数据源上的分析（端到端）");
  {
    const r = await post(base, "/api/analyze", { question: "失败批次有没有共性", datasourceId: dsId });
    await collectSse(base, "/api/analyze/" + r.json.taskId + "/stream", 5000);
    const res = await jfetch(base, "/api/analyze/" + r.json.taskId + "/result");
    check("上传数据可分析且行数=3", res.json && res.json.rowCount === 3, res.json && String(res.json.rowCount));
    check("归因命中堵料", res.json.verdict.includes("堵料"), res.json && res.json.verdict);
  }

  console.log("\n[6] 分析入参校验");
  {
    const noQ = await post(base, "/api/analyze", { datasourceId: "sample" });
    check("缺 question → 400", noQ.status === 400, String(noQ.status));
    const longQ = await post(base, "/api/analyze", { question: "长".repeat(501), datasourceId: "sample" });
    check("question 超长 → 400", longQ.status === 400, String(longQ.status));
    const badDs = await post(base, "/api/analyze", { question: "test", datasourceId: "ds_nope" });
    check("数据源不存在 → 404", badDs.status === 404, String(badDs.status));
    const nores = await jfetch(base, "/api/analyze/t_nope/result");
    check("任务不存在 → 404", nores.status === 404, String(nores.status));
    const noapi = await jfetch(base, "/api/nope");
    check("未知 API → 404 JSON", noapi.status === 404 && !!noapi.json.error, noapi.text);
  }

  console.log("\n[7] 知识库");
  {
    const ok = await post(base, "/api/knowledge", { name: "术语表.md", text: "OEE：设备综合效率；回抽：retraction……" });
    check("上传知识文档 → 201 + knowledgeId", ok.status === 201 && !!ok.json.knowledgeId, ok.text);
    const empty = await post(base, "/api/knowledge", { name: "x", text: "   " });
    check("空文档 → 400", empty.status === 400, String(empty.status));
  }

  console.log("\n[8] 分享页");
  {
    const sh = await post(base, "/api/share/" + taskId, {});
    check("生成分享 → 201 + publicUrl", sh.status === 201 && /\/share\/[a-f0-9]+$/.test(sh.json.publicUrl || ""), sh.text);
    const token = sh.json.publicUrl.split("/").pop();
    const page = await jfetch(base, "/share/" + token);
    check("分享页可打开且含报告标题", page.status === 200 && page.text.includes("机台故障率排行"), String(page.status));
    check("分享页含品牌与提问", page.text.includes("FORGE·X 智造洞察") && page.text.includes("哪台机故障率最高"));
    const nope = await jfetch(base, "/share/deadbeefdeadbeef");
    check("无效 token → 404", nope.status === 404, String(nope.status));
    const notDone = await post(base, "/api/share/t_nope", {});
    check("不存在任务分享 → 404", notDone.status === 404, String(notDone.status));
  }

  console.log("\n[9] 限流（独立实例，冷却 60s）");
  {
    const app2 = createApp({ rateLimitMs: 60000, mockDelayMs: 5, logLevel: "error", forceMock: true, dataDir: tmpDataDir() });
    const port2 = await listen(app2);
    const base2 = "http://127.0.0.1:" + port2;
    const a = await post(base2, "/api/analyze", { question: "成本趋势", datasourceId: "sample" });
    check("冷却期首次请求放行", a.status === 202, String(a.status));
    const b = await post(base2, "/api/analyze", { question: "成本趋势", datasourceId: "sample" });
    check("冷却期内第二次 → 429", b.status === 429 && b.json.error.includes("频繁"), b.text);
    await app2.close();
  }

  await app.close();

console.log("\n[10] Provider 抽象：选择逻辑与能力标记");
{
  const { getConfig } = require(path.join(__dirname, "..", "server", "config.js"));
  const base = { logLevel: "error" };

  const local = getConfig(Object.assign({}, base, { infiniKey: "", openaiKey: "", providerPref: "auto" }));
  check("无任何配置 → 本地规则引擎", local.provider === "local", local.provider);
  check("降级原因如实说明", /规则引擎/.test(local.providerReason), local.providerReason);

  const infini = getConfig(Object.assign({}, base, { infiniKey: "sk-x", infiniVerified: true, providerPref: "auto" }));
  check("InfiniSynapse 就绪 → 自动选它", infini.provider === "infinisynapse", infini.provider);

  const oai = getConfig(Object.assign({}, base,
    { infiniKey: "", openaiKey: "sk-y", openaiModel: "gpt-x", providerPref: "auto" }));
  check("仅 OpenAI 兼容就绪 → 自动选它", oai.provider === "openai", oai.provider);

  const both = getConfig(Object.assign({}, base,
    { infiniKey: "sk-x", infiniVerified: true, openaiKey: "sk-y", openaiModel: "gpt-x", providerPref: "auto" }));
  check("两者都就绪 → 按优先级选 InfiniSynapse", both.provider === "infinisynapse", both.provider);

  const forced = getConfig(Object.assign({}, base,
    { infiniKey: "sk-x", infiniVerified: true, providerPref: "local" }));
  check("显式指定 local → 覆盖自动探测", forced.provider === "local", forced.provider);

  const halfOai = getConfig(Object.assign({}, base, { openaiKey: "sk-y", openaiModel: "", providerPref: "openai" }));
  check("指定 openai 但缺 model → 降级并说明原因",
    halfOai.provider === "local" && /缺 OPENAI/.test(halfOai.providerReason), halfOai.providerReason);

  const mock = getConfig(Object.assign({}, base, { infiniKey: "sk-x", infiniVerified: true, forceMock: true }));
  check("INFINI_MOCK=1 优先级最高", mock.provider === "local", mock.provider);

  // 能力标记必须与实现一致，前端据此决定 UI
  const P = require(path.join(__dirname, "..", "server", "services", "providers.js"));
  const lp = P.localProvider(local);
  check("规则引擎不声称有 AI 能力", lp.capabilities.ai === false && lp.id === "server-rules");
  const op = P.openaiProvider(oai, { info() {}, warn() {}, error() {} });
  check("OpenAI provider 声称有 AI 能力", op.capabilities.ai === true && op.id === "openai-compatible");
}

console.log("\n[11] 云端与本地产物同构：数字由本地统计核负责");
{
  const P = require(path.join(__dirname, "..", "server", "services", "providers.js"));
  const engine = require(path.join(__dirname, "..", "server", "services", "local-engine.js"));
  const localReport = engine.analyze("哪台机故障率最高", engine.farmRows().slice(0, 200), { provenance: null });

  // LLM 只给叙述，图表 / highlight / evidence 必须来自本地
  const narrative = { title: "AI 标题", verdict: "AI 结论", sections: [{ h: "AI 小节", lines: ["要点"] }] };
  const merged = P.mergeWithLocal(narrative, localReport, { engine: "openai-compatible", narrativeBy: "gpt-x" });
  check("叙述采用 AI 的", merged.title === "AI 标题" && merged.verdict === "AI 结论");
  check("图表来自本地统计核（云端不再无图表）",
    !!merged.chart && Array.isArray(merged.chart.items) && merged.chart.items.length > 0);
  check("highlight 来自本地（云端也有视口联动）", !!merged.highlight && merged.highlight.type === "machine");
  check("evidence 来自本地（数字可追溯）", Array.isArray(merged.evidence) && merged.evidence.length > 0);
  check("统计明细不被 AI 叙述覆盖掉",
    merged.sections.some((s) => /排行/.test(s.h)), JSON.stringify(merged.sections.map((s) => s.h)));
  check("叙述出处与数字出处分开标注",
    merged.narrativeBy === "gpt-x" && merged.statsBy === "local-stats-kernel",
    `${merged.narrativeBy} / ${merged.statsBy}`);

  // AI 挂了 / 返回不可解析内容时，数字不受影响
  const degraded = P.mergeWithLocal(null, localReport, { engine: "openai-compatible" });
  check("AI 叙述失败时保留本地全部产物",
    degraded.verdict === localReport.verdict && !!degraded.chart && degraded.evidence.length > 0);
  check("AI 叙述失败时如实说明", degraded.sections.some((s) => /降级/.test(s.h)));

  check("JSON 提取能剥掉代码围栏",
    P.extractJson('```json\n{"a":1}\n```').a === 1);
  check("JSON 提取对非 JSON 返回 null", P.extractJson("完全不是 JSON") === null);

  // 系统提示词必须明确禁止 LLM 自己算数
  check("系统提示词禁止 LLM 自行计算", /不要自己做任何算术/.test(P.SYSTEM_PROMPT));
  check("系统提示词要求区分显著与不显著", /未达统计显著/.test(P.SYSTEM_PROMPT));
  check("系统提示词禁止因果表述", /不得表述为因果/.test(P.SYSTEM_PROMPT));
}

console.log("\n[12] 统计简报：token 成本与数据量解耦");
{
  const { buildBrief } = require(path.join(__dirname, "..", "server", "services", "brief.js"));
  const engine = require(path.join(__dirname, "..", "server", "services", "local-engine.js"));
  const rows = engine.farmRows();

  const brief = buildBrief(rows);
  const csvLen = engine.farmCsv().length;
  check("简报显著小于原始 CSV", brief.text.length < csvLen / 5,
    `简报 ${brief.text.length}B vs CSV ${csvLen}B`);

  // 关键性质：行数翻倍，简报大小基本不变（而 CSV 会翻倍）
  const doubled = rows.concat(rows.map((r, i) => Object.assign({}, r, { job_id: "X" + i })));
  const brief2 = buildBrief(doubled);
  check("行数翻倍后简报大小基本不变",
    Math.abs(brief2.text.length - brief.text.length) < brief.text.length * 0.25,
    `${brief.text.length} → ${brief2.text.length}（行数 ${rows.length} → ${doubled.length}）`);

  check("简报含置信区间", /95%CI/.test(brief.text));
  check("简报含显著性标注", /显著高于其余|未达显著/.test(brief.text));
  check("简报含样本量守卫说明", /样本量.*不参与排名/.test(brief.text));
  check("简报明确禁止把相关当因果", /相关不等于因果/.test(brief.text));
  check("简报结构化事实可复用", !!(brief.facts && brief.facts.machines && brief.facts.overall));
  check("简报不含原始行数据（不泄漏逐条记录）",
    !/FARM-0001/.test(brief.text), brief.text.slice(0, 80));
}

console.log("\n[13] 结果缓存：同一问题不重复烧钱");
{
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: tmpDataDir() });
  const tasks = app.ctx.tasks;
  const k1 = tasks.cache.key("哪台机故障率最高", "sample", "openai-compatible");
  const k2 = tasks.cache.key("哪台机故障率最高", "sample", "openai-compatible");
  const k3 = tasks.cache.key("哪台机故障率最高", "sample", "server-rules");
  const k4 = tasks.cache.key("别的问题", "sample", "openai-compatible");
  check("同问题+同数据集+同 provider → 同 key", k1 === k2);
  check("换 provider → 不同 key（不会串用别的引擎的结果）", k1 !== k3);
  check("换问题 → 不同 key", k1 !== k4);

  tasks.cache.set(k1, { verdict: "cached" });
  check("写入后可命中", tasks.cache.get(k1).verdict === "cached");

  // LRU 容量淘汰
  const small = new (Object.getPrototypeOf(tasks.cache).constructor)({ cacheTtlMs: 1e9, cacheMax: 2 });
  small.set("a", { v: 1 }); small.set("b", { v: 2 }); small.set("c", { v: 3 });
  check("超容量淘汰最久未用", small.get("a") === null && !!small.get("c"));

  // TTL 过期
  const expired = new (Object.getPrototypeOf(tasks.cache).constructor)({ cacheTtlMs: -1, cacheMax: 10 });
  expired.set("x", { v: 1 });
  check("过期条目不再命中", expired.get("x") === null);
  app.close();
}

console.log("\n[14] 知识检索（RAG 的 R）");
{
  const R = require(path.join(__dirname, "..", "server", "services", "retrieval.js"));
  const docs = [
    { id: "k1", name: "工艺术语表", text: "翘边：首层与热床附着失效，零件边缘翘起离床。\n\n回抽：喷头空驶前把耗材回抽一小段，防止拉丝。\n\nOEE：设备综合效率 = 可用率 × 性能 × 良率。" },
    { id: "k2", name: "材料参数", text: "ABS 推荐喷嘴 255°C，热床 100°C，需要封闭腔体。\n\nPLA 推荐喷嘴 210°C，热床 60°C，风扇全开。" },
  ];

  check("中文 bigram 分词可用", R.tokenize("翘边").indexOf("翘边") >= 0, R.tokenize("翘边").join(","));
  check("英文数字按词切分", R.tokenize("ABS 255C").indexOf("abs") >= 0, R.tokenize("ABS 255C").join(","));
  check("长文档被切成多个片段", R.chunk(docs[0].text).length >= 3, String(R.chunk(docs[0].text).length));

  const h1 = R.retrieve(docs, "翘边是什么原因");
  check("检索命中相关片段", h1.length > 0 && /翘边/.test(h1[0].text), JSON.stringify(h1[0] && h1[0].text));
  const h2 = R.retrieve(docs, "ABS 用多少度");
  check("跨文档检索正确", h2.length > 0 && /ABS/.test(h2[0].text), h2[0] && h2[0].text);

  // 最重要的一条：不相关就不返回。往提示词里塞无关片段只会干扰模型。
  check("无关问题不返回任何片段", R.retrieve(docs, "zzz quantum foobar").length === 0);
  check("空知识库安全返回", R.retrieve([], "翘边").length === 0);
  check("命中带分数便于排序与调试", h1[0].score > 0 && typeof h1[0].name === "string");
}

console.log("\n[15] 知识库接口：能力标记必须与实际 provider 一致");
{
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: tmpDataDir() });
  const base = "http://127.0.0.1:" + (await listen(app));
  const ok = await post(base, "/api/knowledge", { name: "术语表.md", text: "翘边：首层附着失效。" });
  check("规则引擎下如实标注检索不生效", ok.json.retrievalEnabled === false, JSON.stringify(ok.json));
  check("并说明为什么不生效", /规则引擎/.test(ok.json.note), ok.json.note);

  const s1 = await post(base, "/api/knowledge/search", { question: "翘边" });
  check("检索预览可用（用户能自证会检索到什么）", s1.status === 200 && s1.json.hits.length > 0, s1.text);
  const s2 = await post(base, "/api/knowledge/search", { question: "完全无关的量子力学" });
  check("检索预览：无命中时明说", s2.json.hits.length === 0 && /没有检索到/.test(s2.json.note || ""), s2.text);
  const s3 = await post(base, "/api/knowledge/search", { question: "  " });
  check("检索预览：空问题 → 400", s3.status === 400, String(s3.status));

  await app.close();
}

console.log("\n[16] 持久化：重启不再丢一切");
{
  const dir = tmpDataDir();
  const a1 = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: dir });
  const b1 = "http://127.0.0.1:" + (await listen(a1));

  const up = await post(b1, "/api/datasource", { name: "persist.csv", csv: CSV_OK });
  const dsId = up.json.datasourceId;
  const kb = await post(b1, "/api/knowledge", { name: "术语.md", text: "翘边：首层附着失效。" });
  const t = await post(b1, "/api/analyze", { question: "哪台机故障率最高", datasourceId: dsId });
  await new Promise((r) => setTimeout(r, 300));
  const sh = await post(b1, "/api/share/" + t.json.taskId, {});
  await a1.close();

  // 换一个进程内实例，指向同一个数据目录——等价于「重启」
  const a2 = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: dir });
  const b2 = "http://127.0.0.1:" + (await listen(a2));

  const again = await post(b2, "/api/analyze", { question: "哪台机故障率最高", datasourceId: dsId });
  check("重启后上传的数据源仍可用", again.status === 202, again.text);
  check("重启后知识文档仍在", a2.ctx.knowledge.all().some((d) => d.id === kb.json.knowledgeId),
    String(a2.ctx.knowledge.all().length));

  const page = await jfetch(b2, "/share/" + sh.json.token);
  check("重启后分享页仍可打开（此前重启即失效）", page.status === 200 && page.text.includes("FORGE·X"),
    String(page.status));

  check("持久化状态在 healthz 中可见",
    (await jfetch(b2, "/healthz")).json.persistence === "file");
  await a2.close();

  // 显式关闭持久化 → 回到纯内存，且如实标注
  const a3 = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: "" });
  const b3 = "http://127.0.0.1:" + (await listen(a3));
  check("dataDir 为空时退回纯内存并如实标注",
    (await jfetch(b3, "/healthz")).json.persistence === "memory");
  await a3.close();
}

console.log("\n[17] 文件存储层：原子写 / TTL / 容量淘汰 / 损坏容错");
{
  const { FileStore } = require(path.join(__dirname, "..", "server", "lib", "store.js"));
  const dir = tmpDataDir();
  const quiet = { info() {}, warn() {}, error() {} };

  const s1 = new FileStore({ dir, name: "t1", ttlMs: 0, max: 0, log: quiet });
  s1.set({ id: "a", v: 1 });
  s1.set({ id: "b", v: 2 });
  check("写入后可读", s1.get("a").v === 1 && s1.get("b").v === 2);

  const s1b = new FileStore({ dir, name: "t1", ttlMs: 0, max: 0, log: quiet });
  check("新实例能从盘上恢复", s1b.get("a").v === 1 && s1b.size === 2, String(s1b.size));

  s1b.delete("a");
  const s1c = new FileStore({ dir, name: "t1", ttlMs: 0, max: 0, log: quiet });
  check("删除会落盘（不会复活）", s1c.get("a") === null && s1c.size === 1);

  // 容量淘汰：builtin 项豁免
  const s2 = new FileStore({ dir, name: "t2", ttlMs: 0, max: 2, log: quiet });
  s2.set({ id: "builtin", builtin: true, createdAt: 1 });
  s2.set({ id: "x", createdAt: 2 });
  s2.set({ id: "y", createdAt: 3 });
  s2.set({ id: "z", createdAt: 4 });
  check("超容量淘汰最旧的非 builtin 项", s2.get("x") === null && !!s2.get("z"));
  check("builtin 项豁免淘汰", !!s2.get("builtin"));

  // TTL
  const s3 = new FileStore({ dir, name: "t3", ttlMs: 1, max: 0, log: quiet });
  s3.set({ id: "old", createdAt: Date.now() - 10000 });
  check("过期记录读不到", s3.get("old") === null);
  const s3b = new FileStore({ dir, name: "t3", ttlMs: 1, max: 0, log: quiet });
  check("过期记录不会在重启后复活", s3b.size === 0, String(s3b.size));

  // 损坏文件不能拖垮整个加载
  const s4 = new FileStore({ dir, name: "t4", ttlMs: 0, max: 0, log: quiet });
  s4.set({ id: "good", v: 1 });
  fs.writeFileSync(path.join(dir, "t4", "broken.json"), "{ 这不是 JSON", "utf8");
  const s4b = new FileStore({ dir, name: "t4", ttlMs: 0, max: 0, log: quiet });
  check("损坏的单条记录不影响其余加载", s4b.get("good") && s4b.get("good").v === 1, String(s4b.size));

  // 关闭持久化必须是真的关闭，而不是「换个地方生效」。
  // 曾经 path.join("", name) 得到相对路径，于是跑一次测试就往仓库根目录写文件。
  const off = new FileStore({ dir: "", name: "nowhere", ttlMs: 0, max: 0, log: quiet });
  off.set({ id: "x", v: 1 });
  check("dataDir 为空时不落盘", off.enabled === false && !fs.existsSync("nowhere"));
  check("关闭持久化后内存仍可用", off.get("x").v === 1);

  // id 里的路径分隔符必须被消解，不能写到目录外
  const s5 = new FileStore({ dir, name: "t5", ttlMs: 0, max: 0, log: quiet });
  s5.set({ id: "../../evil", v: 1 });
  check("id 中的路径穿越被消解", fs.existsSync(path.join(dir, "t5")) &&
    fs.readdirSync(path.join(dir, "t5")).every((f) => !f.includes("..")),
    fs.readdirSync(path.join(dir, "t5")).join(","));
}

console.log("\n[18] 成本闸门：额度用尽降级而不是罢工");
{
  const { CostGate } = require(path.join(__dirname, "..", "server", "lib", "quota.js"));
  const quiet = { info() {}, warn() {}, error() {} };
  const mk = (over) => new CostGate(Object.assign({
    dataDir: tmpDataDir(), aiConcurrency: 2, aiQueueMax: 2, dailyPerCaller: 3, dailyGlobal: 5,
  }, over), quiet);

  const g = mk();
  check("初始有额度", g.check("ip:1").ok === true);
  g.consume("ip:1"); g.consume("ip:1"); g.consume("ip:1");
  const ex = g.check("ip:1");
  check("单调用方额度用尽被拦下", ex.ok === false && ex.code === "caller_daily_exhausted", JSON.stringify(ex));
  check("拒绝理由指向自带 key 的出路", /自己的 API key/.test(ex.reason), ex.reason);
  check("换一个调用方仍有额度（按人计费而非全局）", g.check("ip:2").ok === true);

  // 全局兜底：即使换 IP 也烧不过全局上限
  g.consume("ip:2"); g.consume("ip:2");
  const gex = g.check("ip:3");
  check("全局日上限兜底生效", gex.ok === false && gex.code === "global_daily_exhausted", JSON.stringify(gex));

  // 并发与排队
  const g2 = mk({ aiConcurrency: 1, aiQueueMax: 1 });
  const r1 = await g2.acquire();
  check("取得第一个槽位", typeof r1 === "function");
  let queuedInfo = null;
  const p2 = g2.acquire((q) => { queuedInfo = q; });
  check("并发满时进入排队而不是报错", queuedInfo && queuedInfo.position === 1, JSON.stringify(queuedInfo));
  let rejected = null;
  try { await g2.acquire(); } catch (e) { rejected = e; }
  check("队列也满时才拒绝", rejected && rejected.code === "queue_full", rejected && rejected.message);
  r1();                                  // 释放 → 队列里那个应当拿到槽位
  const r2 = await p2;
  check("释放后队列中的任务拿到槽位", typeof r2 === "function");
  r2();
  check("全部释放后并发归零", g2.snapshot().running === 0 && g2.snapshot().queued === 0,
    JSON.stringify(g2.snapshot()));

  // 用量跨重启保留——否则重启就等于重置额度，闸门形同虚设
  const dir = tmpDataDir();
  const ga = new CostGate({ dataDir: dir, aiConcurrency: 1, aiQueueMax: 1, dailyPerCaller: 5, dailyGlobal: 9 }, quiet);
  ga.consume("ip:9"); ga.consume("ip:9");
  const gb = new CostGate({ dataDir: dir, aiConcurrency: 1, aiQueueMax: 1, dailyPerCaller: 5, dailyGlobal: 9 }, quiet);
  check("用量跨重启保留（重启不等于重置额度）", gb.usedBy("ip:9") === 2, String(gb.usedBy("ip:9")));

  check("不限额配置下永远放行", mk({ dailyPerCaller: 0, dailyGlobal: 0 }).check("ip:x").ok === true);
}

console.log("\n[19] 鉴权：默认不挡路，配了 key 才生效");
{
  const { Auth, safeEqual } = require(path.join(__dirname, "..", "server", "lib", "auth.js"));
  const quiet = { info() {}, warn() {}, error() {} };

  const off = new Auth({ apiKeys: "", requireAuth: false }, quiet);
  check("未配置 key 时鉴权关闭", off.enabled === false);
  check("关闭时按 IP 识别身份", off.identify({ headers: {} }, "1.2.3.4").caller === "ip:1.2.3.4");
  check("关闭时不拦截", off.guard(off.identify({ headers: {} }, "1.2.3.4")) === null);

  const on = new Auth({ apiKeys: "k-alpha, k-beta", requireAuth: true }, quiet);
  const idA = on.identify({ headers: { authorization: "Bearer k-alpha" } }, "1.1.1.1");
  check("Bearer 头识别成功", idA.authenticated === true && idA.caller.startsWith("key:"), idA.caller);
  const idX = on.identify({ headers: { "x-api-key": "k-beta" } }, "1.1.1.1");
  check("X-API-Key 头同样识别", idX.authenticated === true);
  check("不同 key → 不同计费主体", idA.caller !== idX.caller);
  check("完整 key 不出现在 caller 标识里", !idA.caller.includes("k-alpha"), idA.caller);

  const bad = on.identify({ headers: { authorization: "Bearer wrong" } }, "1.1.1.1");
  check("错误 key 不通过", bad.authenticated === false);
  check("requireAuth 下拦截未认证请求", on.guard(bad) && on.guard(bad).status === 401);

  const authLogs = [];
  const roleLog = {
    info(message, fields) { authLogs.push(JSON.stringify({ message, fields })); },
    warn(message, fields) { authLogs.push(JSON.stringify({ message, fields })); },
    error(message, fields) { authLogs.push(JSON.stringify({ message, fields })); },
  };
  const roles = new Auth(
    {
      apiKeys: "general-key,overlap-review-key",
      calibrationReviewKeys: "overlap-review-key,separate-review-key",
      requireAuth: false,
    },
    roleLog
  );
  const generalReview = roles.identifyReviewer({ headers: { "x-api-key": "general-key" } });
  check("普通 API key 不会隐式获得校准审核权", generalReview.authenticated === false);
  const overlapApi = roles.identify({ headers: { "x-api-key": "overlap-review-key" } }, "1.1.1.1");
  const overlapReview = roles.identifyReviewer({ headers: { "x-api-key": "overlap-review-key" } });
  check(
    "重叠审核 key 的匿名摘要一致以支持四眼校验",
    overlapApi.authenticated && overlapReview.authenticated && overlapApi.keyId === overlapReview.keyId
  );
  const separateApi = roles.identify({ headers: { "x-api-key": "separate-review-key" } }, "1.1.1.1");
  const separateReview = roles.identifyReviewer({ headers: { "x-api-key": "separate-review-key" } });
  check("独立保管的审核 key 只获得审核角色", !separateApi.authenticated && separateReview.authenticated);
  const emittedAuthLogs = authLogs.join("\n");
  check(
    "鉴权启用日志只记录数量且不泄露密钥",
    !emittedAuthLogs.includes("general-key") &&
      !emittedAuthLogs.includes("overlap-review-key") &&
      !emittedAuthLogs.includes("separate-review-key"),
    emittedAuthLogs
  );

  // 配置矛盾必须被响亮地纠正，否则会以为自己受保护
  const contradictory = new Auth({ apiKeys: "", requireAuth: true }, quiet);
  check("REQUIRE_AUTH=1 但无 key 时降级为不启用", contradictory.required === false);

  check("常数时间比较对等长/不等长都可用",
    safeEqual("abc", "abc") === true && safeEqual("abc", "abcd") === false && safeEqual("abc", "abd") === false);
}

console.log("\n[20] 额度用尽时的端到端行为：降级而非报错");
{
  // 把 AI 额度设为 0，但 provider 仍是规则引擎——验证降级路径本身
  const app = createApp({
    logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: tmpDataDir(),
    dailyPerCaller: 0, dailyGlobal: 0,
  });
  const base = "http://127.0.0.1:" + (await listen(app));
  const r = await post(base, "/api/analyze", { question: "哪台机故障率最高" });
  check("建任务返回配额信息", r.status === 202 && "willUseAi" in r.json, r.text);
  check("规则引擎模式下 willUseAi 为 false", r.json.willUseAi === false);
  check("规则引擎模式下不返回配额（不该给用不上的限制）", r.json.quota === null);
  await app.close();
}

console.log("\n[21] /metrics：Prometheus 文本格式");
{
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: tmpDataDir() });
  const base = "http://127.0.0.1:" + (await listen(app));
  await post(base, "/api/analyze", { question: "成本趋势" });
  const m = await jfetch(base, "/metrics");
  check("/metrics 可访问", m.status === 200, String(m.status));
  check("Content-Type 为 Prometheus 文本格式",
    /text\/plain/.test(m.headers.get("content-type") || ""), m.headers.get("content-type"));
  check("含任务计数", /forgex_tasks_total \d+/.test(m.text), m.text.slice(0, 120));
  check("含 HELP/TYPE 注释（Prometheus 规范）",
    /# HELP forgex_tasks_total/.test(m.text) && /# TYPE forgex_tasks_total counter/.test(m.text));
  check("含配额与存储指标",
    /forgex_ai_daily_limit/.test(m.text) && /forgex_datasources/.test(m.text));
  await app.close();
}

console.log("\n[22] 分享页：可撤销 + 披露可信度与数据来源");
{
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0, dataDir: tmpDataDir() });
  const base = "http://127.0.0.1:" + (await listen(app));
  const t = await post(base, "/api/analyze", { question: "哪台机故障率最高" });
  await new Promise((r) => setTimeout(r, 300));
  const sh = await post(base, "/api/share/" + t.json.taskId, {});
  check("创建分享返回撤销密钥与有效期",
    !!sh.json.revokeKey && sh.json.expiresAt > Date.now(), sh.text);

  const page = await jfetch(base, "/share/" + sh.json.token);
  check("分享页披露可信度", /可信度/.test(page.text));
  check("分享页披露合成数据来源（分享出去的更要说清楚）", /非真实产线数据/.test(page.text));
  check("分享页引擎标注不冒充 AI", /规则引擎/.test(page.text) && !/云端 AI/.test(page.text));

  const badRevoke = await post(base, "/api/share/" + sh.json.token + "/revoke", { revokeKey: "wrong" });
  check("错误撤销密钥 → 403", badRevoke.status === 403, String(badRevoke.status));
  const stillThere = await jfetch(base, "/share/" + sh.json.token);
  check("撤销失败后分享页仍可访问", stillThere.status === 200);

  const ok = await post(base, "/api/share/" + sh.json.token + "/revoke", { revokeKey: sh.json.revokeKey });
  check("正确密钥可撤销", ok.status === 200 && ok.json.revoked === true, ok.text);
  const gone = await jfetch(base, "/share/" + sh.json.token);
  check("撤销后分享页立即失效", gone.status === 404, String(gone.status));
  await app.close();
}

console.log("\n[23] C# G-code 权威计算同源流式代理");
{
  const authorityRequests = [];
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => { /* 代理主动中止超限请求时忽略 */ });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      authorityRequests.push({ url: req.url, headers: req.headers, body });
      const requestedStatus = new URL(req.url, "http://authority.invalid").searchParams.get("status");
      res.writeHead(requestedStatus === "200" ? 200 : 207, {
        "Content-Type": "application/vnd.forgex.authority+json; charset=utf-8",
        Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "X-Correlation-ID": "csharp-authority-42",
      });
      res.end(JSON.stringify({ receivedBytes: body.length, authoritative: true }));
    });
  });
  const authorityPort = await listenServer(authority);
  const authorityOrigin = "http://127.0.0.1:" + authorityPort;

  const proxyApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: authorityOrigin,
  });
  const proxyBase = "http://127.0.0.1:" + (await listen(proxyApp));
  const source = Buffer.from("G28\r\nG1 X10.25 Y4.5 E0.42\n; 原始字节\n", "utf8");
  const success = await jfetch(proxyBase, "/api/v1/gcode/analyze?bedSizeX=220&origin=center", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/x-gcode",
      Authorization: "Bearer browser-secret",
      Cookie: "session=browser-secret",
      "X-API-Key": "browser-secret",
      "X-Request-ID": "browser-controlled-secret",
    },
    body: source,
  });
  const observed = authorityRequests[0];
  check("权威代理透传上游状态码", success.status === 207, String(success.status));
  check(
    "权威代理透传 Content-Type",
    /application\/vnd\.forgex\.authority\+json/.test(success.headers.get("content-type") || ""),
    success.headers.get("content-type")
  );
  check(
    "权威代理透传 trace headers",
    success.headers.get("traceparent") === "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" &&
      success.headers.get("x-correlation-id") === "csharp-authority-42"
  );
  check(
    "权威代理固定目标路径并保留 query",
    observed && observed.url === "/api/v1/gcode/analyze?bedSizeX=220&origin=center",
    observed && observed.url
  );
  check("权威代理逐字节保留 raw body", observed && observed.body.equals(source));
  check(
    "Cookie/API key/Authorization 均不转发到 C#",
    observed && !observed.headers.cookie && !observed.headers.authorization && !observed.headers["x-api-key"],
    observed && JSON.stringify(observed.headers)
  );
  check(
    "客户端伪造的请求 ID 不透传，Node 生成新 trace ID",
    observed && /^[0-9a-f]{8}$/.test(observed.headers["x-request-id"] || ""),
    observed && observed.headers["x-request-id"]
  );
  check(
    "生产 G-code 请求体硬上限固定为 64 MiB",
    proxyApp.cfg.gcodeAuthorityMaxBytes === GCODE_AUTHORITY_HARD_MAX_BYTES,
    String(proxyApp.cfg.gcodeAuthorityMaxBytes)
  );
  check("REQUIRE_AUTH=0 时保持匿名调用兼容", proxyApp.cfg.requireAuth === false && success.status === 207);
  await proxyApp.close();

  const protectedApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: authorityOrigin,
    apiKeys: "authority-key",
    requireAuth: true,
  });
  const protectedBase = "http://127.0.0.1:" + (await listen(protectedApp));
  const beforeProtected = authorityRequests.length;
  const anonymous = await jfetch(protectedBase, "/api/v1/gcode/analyze?status=200", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode" },
    body: "G28\n",
  });
  check("REQUIRE_AUTH=1 时匿名权威分析返回 401", anonymous.status === 401, anonymous.text);
  check("身份守卫拒绝时不连接 sidecar", authorityRequests.length === beforeProtected);

  const apiKeyAccepted = await jfetch(protectedBase, "/api/v1/gcode/analyze?status=200&auth=x-api-key", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode", "X-API-Key": "authority-key" },
    body: "G28\n",
  });
  const bearerAccepted = await jfetch(protectedBase, "/api/v1/gcode/analyze?status=200&auth=bearer", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode", Authorization: "Bearer authority-key" },
    body: "G28\n",
  });
  const protectedObserved = authorityRequests.slice(beforeProtected);
  check("合法 X-API-Key 可调用权威分析", apiKeyAccepted.status === 200, apiKeyAccepted.text);
  check("合法 Bearer 可调用权威分析", bearerAccepted.status === 200, bearerAccepted.text);
  check(
    "合法 API Key/Bearer 只用于 Node 守卫且不转发 sidecar",
    protectedObserved.length === 2 &&
      protectedObserved.every((item) => !item.headers["x-api-key"] && !item.headers.authorization),
    JSON.stringify(protectedObserved.map((item) => item.headers))
  );
  await protectedApp.close();

  const cookieApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: authorityOrigin,
    apiKeys: "authority-key",
    requireAuth: true,
    publicBase: "http://127.0.0.1:8787",
    infiniPartnerClientId: "test-client",
    infiniPartnerClientSecret: "test-secret",
  });
  const cookieToken = "authority-cookie-session";
  cookieApp.ctx.partnerSSO.sessions.set(cookieToken, {
    user: { id: "authority-user", nickname: "Authority User", email: "", avatar: "" },
    apiKey: "partner-side-secret",
    expiresAt: Date.now() + 60000,
  });
  const cookieBase = "http://127.0.0.1:" + (await listen(cookieApp));
  const beforeCookie = authorityRequests.length;
  const cookieAccepted = await jfetch(cookieBase, "/api/v1/gcode/analyze?status=200&auth=cookie", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode", Cookie: "fx_session=" + cookieToken },
    body: "G28\n",
  });
  const cookieObserved = authorityRequests[beforeCookie];
  check("合法 Partner SSO Cookie 可调用权威分析", cookieAccepted.status === 200, cookieAccepted.text);
  check(
    "合法 SSO Cookie 只用于 Node 守卫且不转发 sidecar",
    cookieObserved && !cookieObserved.headers.cookie && !cookieObserved.headers.authorization,
    cookieObserved && JSON.stringify(cookieObserved.headers)
  );
  await cookieApp.close();

  const rateLimitedApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 60000,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: authorityOrigin,
    apiKeys: "authority-key",
    requireAuth: true,
  });
  const rateLimitedBase = "http://127.0.0.1:" + (await listen(rateLimitedApp));
  const beforeRateLimit = authorityRequests.length;
  const concurrent = await Promise.all([
    jfetch(rateLimitedBase, "/api/v1/gcode/analyze?status=200&request=1", {
      method: "POST",
      headers: { "Content-Type": "text/x-gcode", "X-API-Key": "authority-key" },
      body: "G28\n",
    }),
    jfetch(rateLimitedBase, "/api/v1/gcode/analyze?status=200&request=2", {
      method: "POST",
      headers: { "Content-Type": "text/x-gcode", "X-API-Key": "authority-key" },
      body: "G28\n",
    }),
  ]);
  const concurrentStatuses = concurrent.map((item) => item.status).sort((a, b) => a - b);
  check(
    "并发权威分析复用既有冷却限流并返回 429",
    concurrentStatuses[0] === 200 && concurrentStatuses[1] === 429,
    concurrentStatuses.join(",")
  );
  check("被限流请求不连接 sidecar", authorityRequests.length === beforeRateLimit + 1);
  await rateLimitedApp.close();

  const limitedApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: authorityOrigin,
    gcodeAuthorityMaxBytes: 8,
  });
  const limitedBase = "http://127.0.0.1:" + (await listen(limitedApp));
  const beforePreflight = authorityRequests.length;
  const preflight = await rawRequest(
    limitedBase + "/api/v1/gcode/analyze",
    { "Content-Type": "text/x-gcode", "Content-Length": "9" },
    []
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  check(
    "Content-Length 预检超限返回结构化 413",
    preflight.status === 413 && preflight.json && preflight.json.code === "payload_too_large",
    preflight.text
  );
  check("Content-Length 预检失败时不连接 C#", authorityRequests.length === beforePreflight);

  const chunked = await rawRequest(
    limitedBase + "/api/v1/gcode/analyze",
    { "Content-Type": "text/x-gcode" },
    [Buffer.from("12345"), Buffer.from("67890")]
  );
  check(
    "chunked 上传按实际字节计数并在超限时返回 413",
    chunked.status === 413 && chunked.json && chunked.json.code === "payload_too_large",
    chunked.text
  );
  await limitedApp.close();

  const disabledApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: "",
  });
  const disabledBase = "http://127.0.0.1:" + (await listen(disabledApp));
  const disabled = await jfetch(disabledBase, "/api/v1/gcode/analyze", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode" },
    body: "G28\n",
  });
  check(
    "未配置 sidecar 时返回结构化 503",
    disabled.status === 503 && disabled.json && disabled.json.code === "authority_not_configured",
    disabled.text
  );
  check("新增代理不影响既有 healthz", (await jfetch(disabledBase, "/healthz")).status === 200);
  await disabledApp.close();

  const unused = http.createServer();
  const unusedPort = await listenServer(unused);
  await closeServer(unused);
  const unavailableApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: "http://127.0.0.1:" + unusedPort,
    gcodeAuthorityTimeoutMs: 500,
  });
  const unavailableBase = "http://127.0.0.1:" + (await listen(unavailableApp));
  const unavailable = await jfetch(unavailableBase, "/api/v1/gcode/analyze", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode" },
    body: "G28\n",
  });
  check(
    "C# sidecar 不可连接时返回结构化 502",
    unavailable.status === 502 && unavailable.json && unavailable.json.code === "authority_unavailable",
    unavailable.text
  );
  await unavailableApp.close();

  const hanging = http.createServer((req) => {
    req.on("error", () => { /* 代理超时后会主动断开 */ });
    req.resume();
  });
  const hangingPort = await listenServer(hanging);
  const timeoutApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: "http://127.0.0.1:" + hangingPort,
    gcodeAuthorityTimeoutMs: 30,
  });
  const timeoutBase = "http://127.0.0.1:" + (await listen(timeoutApp));
  const timedOut = await jfetch(timeoutBase, "/api/v1/gcode/analyze", {
    method: "POST",
    headers: { "Content-Type": "text/x-gcode" },
    body: "G28\n",
  });
  check(
    "sidecar 超时返回结构化 504",
    timedOut.status === 504 && timedOut.json && timedOut.json.code === "authority_timeout",
    timedOut.text
  );
  await timeoutApp.close();
  await closeServer(hanging);

  let markStarted;
  let markCancelled;
  const upstreamStarted = new Promise((resolve) => { markStarted = resolve; });
  const upstreamCancelled = new Promise((resolve) => { markCancelled = resolve; });
  const cancellable = http.createServer((req) => {
    markStarted();
    req.on("aborted", markCancelled);
    req.on("close", () => { if (!req.complete) markCancelled(); });
    req.on("error", () => { /* 预期的客户端取消 */ });
    req.resume();
  });
  const cancellablePort = await listenServer(cancellable);
  const cancelApp = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tmpDataDir(),
    gcodeAuthorityUrl: "http://127.0.0.1:" + cancellablePort,
  });
  const cancelPort = await listen(cancelApp);
  const clientReq = http.request({
    host: "127.0.0.1",
    port: cancelPort,
    method: "POST",
    path: "/api/v1/gcode/analyze",
    headers: { "Content-Type": "text/x-gcode" },
  });
  clientReq.on("error", () => { /* destroy() 的预期结果 */ });
  clientReq.write(Buffer.alloc(1024, 65));
  const started = await Promise.race([
    upstreamStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  clientReq.destroy();
  const cancelled = await Promise.race([
    upstreamCancelled.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  check("浏览器取消上传会中止 C# 上游请求", started && cancelled);
  await cancelApp.close();
  await closeServer(cancellable);

  const invalidTargets = [
    "ftp://127.0.0.1:8788",
    "http://user:password@127.0.0.1:8788",
    "http://127.0.0.1:8788/private/path",
    "https://example.com",
  ];
  for (const target of invalidTargets) {
    let rejected = false;
    try {
      getConfig({ gcodeAuthorityUrl: target, gcodeAuthorityAllowRemote: false });
    } catch (e) {
      rejected = /GCODE_AUTHORITY_URL/.test(e.message);
    }
    check("危险 authority target 配置被拒绝：" + target, rejected);
  }
  const optedInRemote = getConfig({
    gcodeAuthorityUrl: "https://authority.example.com",
    gcodeAuthorityAllowRemote: true,
  });
  check("远端 origin 仅在显式 opt-in 后接受", optedInRemote.gcodeAuthorityUrl === "https://authority.example.com");

  await closeServer(authority);
}

  cleanupTmp();

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {

  cleanupTmp();
  console.error("测试框架异常：", e);
  process.exit(1);
});
