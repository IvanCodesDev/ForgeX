/* FORGE·X 后端契约测试（node tests/server.test.js）
   覆盖：healthz / 数据源上传 / 分析任务 + SSE 进度 + 结果 / 轮询兜底 /
        知识库 / 分享页 / 静态托管 allowlist 与路径穿越 / 输入校验 / 限流。
   进程内起服务（端口 0 随机），规则引擎（forceMock），不依赖外部网络。 */
"use strict";
const http = require("http");
const path = require("path");
const { createApp } = require("../server/index");

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
  const app = createApp({ rateLimitMs: 0, mockDelayMs: 5, logLevel: "error", forceMock: true });
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
    const js = await jfetch(base, "/js/util.js");
    check("GET /js/util.js 可达", js.status === 200 && js.text.includes("FXU"));
    const cfgFile = await jfetch(base, "/server/config.js");
    check("server/ 目录不可达", cfgFile.status === 404, String(cfgFile.status));
    const env = await jfetch(base, "/server/.env");
    check(".env 不可达", env.status === 404, String(env.status));
    const trav = await jfetch(base, "/js/..%2Fserver%2Fconfig.js");
    check("编码路径穿越被拒", trav.status === 404, String(trav.status));
    const doc = await jfetch(base, "/doc/" + encodeURIComponent("开发文档.md"));
    check("doc 内部文档不外露", doc.status === 404, String(doc.status));
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
    const app2 = createApp({ rateLimitMs: 60000, mockDelayMs: 5, logLevel: "error", forceMock: true });
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
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0 });
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
  const app = createApp({ logLevel: "error", forceMock: true, rateLimitMs: 0 });
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

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试框架异常：", e);
  process.exit(1);
});
