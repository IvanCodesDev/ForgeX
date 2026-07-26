/* InfiniSynapse Server API 客户端 — 全服务里唯一接触 sk- 密钥的模块。
   ✅ 端点契约已于 2026-07-21 用真实调用核准（tests/infini-smoke.js --task，
   taskId 1784639167613 可在 app.infinisynapse.cn/tasks 核对），来源：官方博客 + 实测响应。

   官方异步链路（顺序不可颠倒，先订阅后建任务，否则丢早期事件）：
     ① GET  {server}/api/ai/events?connId=<uuid>          SSE 订阅（Accept: text/event-stream）
     ② POST {server}/api/ai/message                        {type:"newTask", connId, text, chatSettings:{mode:"act"}}
        → HTTP 201；taskId 不在响应体，而在 SSE 事件里
     ③ SSE 事件：event 名 = message.add / message.partial / message.update / state.ready /
        notification / heartbeat；data = {taskId, message:{type:"say"|"ask", say, text, partial}}
        终结标志 = say:"completion_result" 且 partial:false（伴随 notification success）
     ④ GET  {server}/api/ai_task/getTaskWorkspace/<taskId> 产物文件列表 */
"use strict";
const crypto = require("crypto");

/** 端点表（2026-07-21 实测核准；修改前必须重新核准） */
const ENDPOINTS = {
  profile: { method: "GET", path: "/user/profile", base: "console" },
  events: { method: "GET", path: "/api/ai/events", base: "server" },
  newTask: { method: "POST", path: "/api/ai/message", base: "server" },
  workspace: { method: "GET", path: "/api/ai_task/getTaskWorkspace/", base: "server" },
};

class InfiniClient {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
  }

  _ensureUsable() {
    if (this.cfg.mode !== "infinisynapse") {
      throw new Error("InfiniSynapse 通道未启用：" + this.cfg.modeReason);
    }
  }

  _url(ep, suffix) {
    const base = ep.base === "console" ? this.cfg.infiniConsoleUrl : this.cfg.infiniServerUrl;
    return base.replace(/\/$/, "") + ep.path + (suffix || "");
  }

  _headers(extra) {
    return Object.assign({ Authorization: "Bearer " + this.cfg.infiniKey }, extra);
  }

  async _json(ep, { suffix, body, timeoutMs } = {}) {
    this._ensureUsable();
    const res = await fetch(this._url(ep, suffix), {
      method: ep.method,
      headers: this._headers(body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs || 30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 上游报文可能含敏感细节，日志留全文、对外只给状态码
      this.log.error("infini upstream error", { status: res.status, path: ep.path, body: text.slice(0, 500) });
      throw new Error("上游服务响应异常（HTTP " + res.status + "）");
    }
    return res.json();
  }

  /** 连通性冒烟：取用户信息（实测 200，data.userId） */
  profile() {
    return this._json(ENDPOINTS.profile);
  }

  /** 任务产物列表（实测 200，data:{cwd, files[]}）；失败不致命，返回 null */
  async workspace(taskId) {
    try {
      const out = await this._json(ENDPOINTS.workspace, { suffix: encodeURIComponent(taskId) });
      return (out && out.data) || null;
    } catch (e) {
      this.log.warn("infini workspace fetch failed", { taskId, error: e.message });
      return null;
    }
  }

  /**
   * 完整分析链路（SSE 先行 → newTask → completion_result → workspace）。
   * onProgress 已内置节流（partial 洪峰每几毫秒一条，原样透传会撑爆事件缓存）。
   * 返回 {taskId, resultText, workspace}
   */
  async runAnalysis({ question, csvText, datasourceName, onProgress }) {
    this._ensureUsable();
    const connId = crypto.randomUUID();
    const deadline = Date.now() + this.cfg.infiniTimeoutMs;

    const sse = await this._openEvents(connId);
    try {
      let taskId = null;
      let resultText = "";
      let done = false;
      let lastEmit = 0;
      let lastStage = "";
      const throttled = (stage, message) => {
        const now = Date.now();
        if (stage !== lastStage || now - lastEmit > 1500) {
          lastStage = stage;
          lastEmit = now;
          onProgress({ stage, message });
        }
      };

      const consume = (event, data) => {
        let j;
        try { j = JSON.parse(data); } catch (e) { return; }   // heartbeat: "ping" 等非 JSON
        if (j && j.taskId && !taskId) {
          taskId = String(j.taskId);
          this.log.info("infini task created", { infiniTaskId: taskId });
          throttled("task_created", "InfiniSynapse 任务已创建 #" + taskId);
        }
        const msg = j && j.message;
        if (!msg) return;
        if (msg.say === "reasoning") throttled("reasoning", "云端推理中…");
        else if (msg.say === "text" && msg.partial) throttled("generating", "生成结论中…");
        else if (msg.say === "completion_result") {
          const t = typeof msg.text === "string" ? msg.text : "";
          // partial 流式增长：partial:false 的终稿无条件采信；中途只保留最长文本（防晚到的短 update 回退）
          if (t && t !== "null" && (msg.partial === false || t.length > resultText.length)) resultText = t;
          if (msg.partial === false) done = true;
        } else if (msg.type === "ask" && msg.ask === "completion_result") done = true;   // 兜底终结标志
      };

      sse.onEvent(consume);

      // 官方要求：先订阅后建任务（HTTP 201，taskId 由 SSE 带回）
      await this._json(ENDPOINTS.newTask, {
        body: {
          type: "newTask",
          connId,
          text: this._buildPrompt(question, csvText, datasourceName),
          chatSettings: { mode: "act" },
        },
      });
      throttled("submitted", "任务已提交，等待云端受理");

      while (!done) {
        if (Date.now() > deadline) throw new Error("上游任务超时（" + Math.round(this.cfg.infiniTimeoutMs / 1000) + "s）");
        if (sse.failed) throw new Error("上游事件流中断：" + sse.failed.message);
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!resultText) throw new Error("云端任务结束但未返回结论文本");

      const workspace = taskId ? await this.workspace(taskId) : null;
      return { taskId, resultText, workspace };
    } finally {
      sse.close();
    }
  }

  /** 打开 SSE 事件流；返回 {onEvent, close, failed}。解析标准 event:/data: 块。 */
  async _openEvents(connId) {
    const ctrl = new AbortController();
    const res = await fetch(this._url(ENDPOINTS.events) + "?connId=" + encodeURIComponent(connId), {
      headers: this._headers({ Accept: "text/event-stream" }),
      signal: ctrl.signal,
    });
    if (res.status !== 200) {
      ctrl.abort();
      throw new Error("上游事件流拒绝（HTTP " + res.status + "）");
    }
    const state = { handler: null, failed: null };
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
            if (data && state.handler) state.handler(event, data);
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") state.failed = e;
      }
    })();
    return {
      onEvent: (fn) => { state.handler = fn; },
      close: () => { try { ctrl.abort(); } catch (e) { /* 已关闭 */ } },
      get failed() { return state.failed; },
    };
  }

  /** 分析指令：要求 JSON 产物便于结构化渲染；解析失败有降级（analysis.js）。
      实测教训：不给加载提示时云端会先尝试创建 .csv 文件（平台禁止，白耗 ~45s），
      明示「inline JSON → Infinity SQL」路径可直达。 */
  _buildPrompt(question, csvText, datasourceName) {
    return [
      "你是增材制造（3D 打印）领域的资深数据分析师。请基于下面给出的 CSV 生产数据回答用户问题。",
      "生产数据（" + (datasourceName || "print_jobs.csv") + "，金额列 cost_cny 单位为元）：",
      "```csv\n" + csvText + "\n```",
      "用户问题：" + question,
      "要求：",
      "1. 不要尝试创建 .csv 等数据文件（平台禁止）；请把上述数据转成 inline JSON 用 execute_infinity_sql 加载为表，再用 SQL 聚合计算；",
      "2. 结论必须来自真实计算（计数/求和/均值/比率），未知不编造；",
      "3. 中文回答，附数据依据（样本数、比率、金额），并给出可执行建议；",
      "4. 最终结论（attempt_completion）请严格输出如下 JSON（不要输出 JSON 以外的文字）：",
      '{"title":"报告标题(≤16字)","verdict":"一句话核心结论(≤80字)","sections":[{"h":"小节标题","lines":["要点…"]}]}',
    ].join("\n\n");
  }
}

module.exports = { InfiniClient, ENDPOINTS };
