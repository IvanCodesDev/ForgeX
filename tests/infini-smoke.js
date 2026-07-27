/* InfiniSynapse 集成冒烟。
   用法：node tests/infini-smoke.js [--task]
     默认只做只读连通性冒烟（profile）；带 --task 走官方完整异步链路发一次 hello-world
     任务（会产生平台调用日志，taskId 可在 app.infinisynapse.cn/tasks 核对）。
   官方契约（infinisynapse.com 官方博客，2026 核准）：
     ① 先开 SSE：GET {server}/api/ai/events?connId=<uuid>   ← 必须先于 newTask，否则丢早期事件
     ② 发任务：POST {server}/api/ai/message  {type:"newTask", connId, text, chatSettings:{mode:"act"}}
     ③ 事件流：message.partial / message.add / … / completion_result
     ④ 取产物：GET {server}/api/ai_task/getTaskWorkspace/<taskId>
   密钥从 server/.env 读取，输出绝不回显完整 key。 */
"use strict";
const crypto = require("crypto");
const { getConfig } = require("../server/config");

const cfg = getConfig();
if (!cfg.infiniKey) {
  console.error("未配置 INFINI_API_KEY（server/.env），无法冒烟");
  process.exit(2);
}
const mask = cfg.infiniKey.slice(0, 5) + "…" + cfg.infiniKey.slice(-4);
const AUTH = { Authorization: "Bearer " + cfg.infiniKey };
const server = cfg.infiniServerUrl.replace(/\/$/, "");

async function jcall(name, url, opts) {
  const started = Date.now();
  try {
    const res = await fetch(url, Object.assign({ headers: Object.assign({ "Content-Type": "application/json" }, AUTH), signal: AbortSignal.timeout(30000) }, opts));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    console.log(`  [${name}] HTTP ${res.status} (${Date.now() - started}ms)`);
    console.log(`    body: ${text.slice(0, 800).replace(/\n/g, " ")}`);
    return { status: res.status, json, text };
  } catch (err) {
    console.log(`  [${name}] 请求失败：${err.message}`);
    return { status: 0, json: null, text: "", error: err };
  }
}

/** 打开 SSE 事件流并逐事件回调；返回 {close}。事件原文全部打印（核准证据）。 */
async function openSse(connId, onEvent, onOpen) {
  const ctrl = new AbortController();
  const url = server + "/api/ai/events?connId=" + encodeURIComponent(connId);
  const res = await fetch(url, {
    headers: Object.assign({ Accept: "text/event-stream" }, AUTH),
    signal: ctrl.signal,
  });
  console.log(`  [SSE] HTTP ${res.status}  content-type=${res.headers.get("content-type")}`);
  if (res.status !== 200) {
    const t = await res.text().catch(() => "");
    console.log(`    body: ${t.slice(0, 400)}`);
    throw new Error("SSE HTTP " + res.status);
  }
  if (onOpen) onOpen();
  (async () => {
    try {
      let buf = "";
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) onEvent(event, data);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") console.log("  [SSE] 流中断：" + e.message);
    }
  })();
  return { close: () => ctrl.abort() };
}

(async () => {
  console.log(`═══ InfiniSynapse 冒烟 · key=${mask} ═══`);
  console.log(`console=${cfg.infiniConsoleUrl}  server=${server}\n`);

  console.log("[1] Console · GET /user/profile（只读连通性）");
  const prof = await jcall("profile", cfg.infiniConsoleUrl.replace(/\/$/, "") + "/user/profile");
  if (prof.status !== 200) { console.error("\nprofile 未通，终止"); process.exit(1); }

  if (!process.argv.includes("--task")) {
    console.log("\n[2] 跳过任务链路（加 --task 才发起真实任务）");
    return;
  }

  console.log("\n[2] 官方异步链路：SSE 先行 → newTask → completion_result");
  const connId = crypto.randomUUID();
  console.log(`  connId=${connId}`);

  let taskId = null;
  let done = false;
  const events = [];
  const sse = await openSse(connId, (event, data) => {
    events.push({ event, data });
    console.log(`  [ev#${events.length}] ${event}: ${data.slice(0, 500)}`);
    try {
      const j = JSON.parse(data);
      const t = j.taskId || (j.data && j.data.taskId) || (j.payload && j.payload.taskId);
      if (t) taskId = t;
      if (event === "completion_result" || j.type === "completion_result") done = true;
    } catch (e) { /* 非 JSON data */ }
  });

  await new Promise((r) => setTimeout(r, 800));   // 稳定连接后再发任务（官方：先订阅后创建）

  console.log("\n[3] POST /api/ai/message · type=newTask");
  const created = await jcall("newTask", server + "/api/ai/message", {
    method: "POST",
    body: JSON.stringify({
      type: "newTask",
      connId,
      text: "连通性验证：请直接回答 1+1 等于几，无需查询任何数据。",
      chatSettings: { mode: "act" },
    }),
  });
  const ct = created.json || {};
  taskId = taskId || ct.taskId || (ct.data && (ct.data.taskId || ct.data.id)) || ct.id || null;
  console.log(`  解析到 taskId=${taskId}`);

  console.log("\n[4] 等待 completion_result（上限 120s）…");
  const deadline = Date.now() + 120000;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  sse.close();
  console.log(`  事件总数=${events.length} done=${done} taskId=${taskId}`);

  if (taskId) {
    console.log("\n[5] GET /api/ai_task/getTaskWorkspace/" + taskId);
    await jcall("workspace", server + "/api/ai_task/getTaskWorkspace/" + taskId);
    console.log(`\n✅ 评委可核对：app.infinisynapse.cn/tasks 应出现 taskId=${taskId}`);
  } else {
    console.log("\n⚠️ 未解析到 taskId — 请核对上方事件/响应原文，修正字段映射");
  }
})();
