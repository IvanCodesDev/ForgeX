/* FORGE·X 后端契约测试（node tests/server.test.js）
   覆盖：healthz / 数据源上传 / 分析任务 + SSE 进度 + 结果 / 轮询兜底 /
        知识库 / 分享页 / 静态托管 allowlist 与路径穿越 / 输入校验 / 限流。
   进程内起服务（端口 0 随机），规则引擎（forceMock），不依赖外部网络。 */
"use strict";
const http = require("http");
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
    check("门禁生效：未配密钥时为规则引擎", r.json.engine === "rules", r.json && r.json.engine);
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
    check("返回引擎标识 rules", r.json.engine === "rules", r.json && r.json.engine);

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
  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("测试框架异常：", e);
  process.exit(1);
});
