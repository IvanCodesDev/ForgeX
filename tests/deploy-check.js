/* FORGE·X 部署后线上冒烟。
   用法：node tests/deploy-check.js https://your-app.example.com
   覆盖评委视角验收清单：打开即用 → 提问出报告 → 产物可分享。
   零依赖（Node ≥18 全局 fetch）；对已部署环境只做只读+一次分析的最小写入。 */
"use strict";

const base = String(process.argv[2] || "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("用法：node tests/deploy-check.js <公网URL>   例：node tests/deploy-check.js https://forgex.onrender.com");
  process.exit(2);
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jfetch(path, opts) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** POST /api/analyze，命中限流(429)时按提示冷却后重试一次 */
async function createTask(question) {
  const body = JSON.stringify({ question });
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  let r = await jfetch("/api/analyze", opts);
  if (r.status === 429) {
    console.log("  INFO  命中限流（正常防刷行为），7 秒后重试一次…");
    await sleep(7000);
    r = await jfetch("/api/analyze", opts);
  }
  return r;
}

/** 读 SSE 直到 done 事件（fetch 流式），上限 timeoutMs */
async function collectSse(path, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(base + path, { signal: ctrl.signal });
    if (res.status !== 200) throw new Error("SSE HTTP " + res.status);
    const contentType = res.headers.get("content-type") || "";
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            events.push(ev);
            if (ev.done) { ctrl.abort(); return { events, contentType }; }
          } catch (e) { /* 心跳注释行 */ }
        }
      }
    }
    return { events, contentType };
  } catch (err) {
    if (err.name === "AbortError" && events.some((e) => e.done)) {
      return { events, contentType: "" };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log("═══ FORGE·X 线上冒烟 @ " + base + " ═══\n");

  console.log("[1] 健康检查");
  const hz = await jfetch("/healthz");
  check("GET /healthz → 200 ok:true", hz.status === 200 && hz.json && hz.json.ok === true, "HTTP " + hz.status);
  const engine = hz.json ? hz.json.engine : "?";
  console.log(`  INFO  引擎模式：${engine}（${hz.json ? hz.json.reason : "?"}）`);

  console.log("\n[2] 前端资产可达");
  const home = await jfetch("/");
  check("GET / → 200 且含品牌", home.status === 200 && home.text.includes("FORGE·X"), "HTTP " + home.status);
  const jsOk = await jfetch("/js/util.js");
  check("GET /js/util.js → 200", jsOk.status === 200, "HTTP " + jsOk.status);
  const profileOk = await jfetch("/profiles/example-bundle.json");
  check("公开 Profile 示例可下载", profileOk.status === 200 && profileOk.text.includes("forgex-profile-bundle"), "HTTP " + profileOk.status);
  const envHidden = await jfetch("/server/.env");
  check("server/.env 不可达", envHidden.status === 404, "HTTP " + envHidden.status);

  console.log("\n[3] 分析链路端到端（内置示例数据）");
  const created = await createTask("哪台机故障率最高，主要故障是什么");
  check("POST /api/analyze → 202 + taskId", created.status === 202 && created.json && created.json.taskId, "HTTP " + created.status + " " + (created.text || "").slice(0, 120));
  if (created.json && created.json.taskId) {
    const taskId = created.json.taskId;
    console.log(`  INFO  taskId=${taskId} engine=${created.json.engine}`);
    const sse = await collectSse("/api/analyze/" + taskId + "/stream", 180000);
    check("SSE 进度流含终止事件 done", sse.events.some((e) => e.done), "events=" + sse.events.length);
    let result = await jfetch("/api/analyze/" + taskId + "/result");
    for (let i = 0; i < 10 && result.status === 202; i++) { await sleep(1000); result = await jfetch("/api/analyze/" + taskId + "/result"); }
    check("结果 → 200 完整报告", result.status === 200 && result.json && !!result.json.title && !!result.json.verdict, "HTTP " + result.status);
    if (result.json) {
      console.log(`  INFO  报告《${result.json.title}》· ${result.json.verdict ? result.json.verdict.slice(0, 60) : ""}…`);
      if (result.json.upstreamTaskId) console.log(`  INFO  InfiniSynapse taskId=${result.json.upstreamTaskId}（可在 app.infinisynapse.cn/tasks 核对）`);
    }

    console.log("\n[4] 分享页");
    const share = await jfetch("/api/share/" + taskId, { method: "POST" });
    check("POST /api/share → 201 + publicUrl", share.status === 201 && share.json && share.json.publicUrl, "HTTP " + share.status);
    if (share.json && share.json.publicUrl) {
      const shareUrl = new URL(share.json.publicUrl, base + "/").href;
      const page = await fetch(shareUrl).then((r) => r.text().then((t) => ({ status: r.status, text: t })));
      check("分享页可打开且含报告", page.status === 200 && page.text.includes("FORGE·X 智造洞察"), "HTTP " + page.status);
      console.log(`  INFO  分享链接：${shareUrl}`);
    }
  }

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  if (engine === "rules") console.log("提示：当前为规则引擎（非 AI）。配置 INFINI_API_KEY + INFINI_VERIFIED=1 后切云端 AI 分析。");
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("冒烟中断：", err.message);
  process.exit(1);
});
