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
  async runAnalysis({ question, systemPrompt, userText, datasourceName, onProgress }) {
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
          text: this._buildPrompt(question, systemPrompt, userText, datasourceName),
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

  /**
   * 云端任务指令。
   *
   * ⚠ 重要变更（P3）：这里**不再内联整份 CSV**。
   * 旧做法把 400 行 CSV（约 32KB）塞进 prompt 让云端自己建表、自己算，
   * 结果是 token 成本随数据量线性增长、上万行直接超限，而且数字由 LLM 心算、无从校验。
   * 现在传的是本地统计核算好并核验过的**统计简报**（约 2KB，行数再涨十倍也不会变大），
   * 云端只负责把已验证的事实组织成叙述。
   *
   * 因此原先「不要创建 .csv 文件、改用 execute_infinity_sql 加载」那条提示也不再需要——
   * 已经没有数据文件要加载了。
   */
  _buildPrompt(question, systemPrompt, userText, datasourceName) {
    return [
      systemPrompt,
      "",
      "数据集名称：" + (datasourceName || "print_jobs"),
      "",
      userText,
    ].join("\n");
  }
}

module.exports = { InfiniClient, ENDPOINTS };
