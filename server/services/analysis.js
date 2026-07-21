/* 分析任务编排：任务存储 + 进度事件（SSE 订阅/重放）+ 引擎路由（mock / InfiniSynapse）。
   事件全量缓存后重放，SSE 晚接入或断线重连都不丢进度；任务终态后连接自动收口。 */
"use strict";
const crypto = require("crypto");
const engine = require("./local-engine");
const { sseSend } = require("../lib/http");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从可能带说明文字/代码围栏/截断的文本中提取第一个完整 JSON 对象（括号配对 + 字符串感知）。
    云端 completion_result 偶发被截断（SSE 终稿早退），贪婪 regex 会拿到断尾 JSON，这里逐层配对更稳。 */
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

class TaskStore {
  constructor(cfg, log, infini) {
    this.cfg = cfg;
    this.log = log;
    this.infini = infini;
    this.map = new Map();
  }

  create(question, ds, reqId) {
    const task = {
      id: "t_" + crypto.randomBytes(8).toString("hex"),
      question,
      datasourceId: ds.id,
      engine: this.cfg.mode,           // "mock" | "infinisynapse"
      status: "running",
      events: [],
      evSeq: 0,
      report: null,
      error: null,
      upstreamTaskId: null,
      shared: false,
      subscribers: new Set(),
      createdAt: Date.now(),
      finishedAt: 0,
    };
    this.map.set(task.id, task);
    this.log.info("task created", { reqId, taskId: task.id, engine: task.engine, datasourceId: ds.id, rows: ds.rows.length });

    const run = task.engine === "infinisynapse" ? this._runInfini(task, ds) : this._runMock(task, ds);
    run.catch((err) => this._fail(task, err));
    return task;
  }

  get(id) {
    return this.map.get(String(id || "")) || null;
  }

  /* ── 进度事件 ─────────────────────────────── */

  emit(task, ev) {
    const event = Object.assign({ seq: ++task.evSeq, ts: Date.now() }, ev);
    task.events.push(event);
    for (const res of task.subscribers) {
      if (!sseSend(res, event)) task.subscribers.delete(res);
    }
    if (event.done) this._closeSubscribers(task);
  }

  /** SSE 订阅：先重放历史事件，终态任务重放完即收口 */
  subscribe(task, res) {
    for (const ev of task.events) sseSend(res, ev);
    if (task.status === "done" || task.status === "failed") {
      res.end();
      return () => {};
    }
    task.subscribers.add(res);
    return () => task.subscribers.delete(res);
  }

  _closeSubscribers(task) {
    for (const res of task.subscribers) {
      try { res.end(); } catch (e) { /* 连接已断 */ }
    }
    task.subscribers.clear();
  }

  /* ── mock 引擎（复用前端本地分析引擎，产物同构） ── */

  async _runMock(task, ds) {
    const d = this.cfg.mockDelayMs;
    const steps = [
      ["intent", "解析问题意图", 0.2],
      ["aggregate", "聚合生产数据", 0.55],
      ["generate", "生成结论与建议", 0.85],
    ];
    for (const [stage, message, progress] of steps) {
      this.emit(task, { stage, message, progress });
      await sleep(d);
    }
    const report = engine.analyze(task.question, ds.rows);
    report.engine = "mock";
    report.taskId = task.id;
    this._finish(task, report);
  }

  /* ── InfiniSynapse 通道（2026-07-21 端点已核准，见 services/infini.js 头注） ── */

  async _runInfini(task, ds) {
    this.emit(task, { stage: "submit", message: "提交 InfiniSynapse 分析任务", progress: 0.1 });
    // 云端进度无确定步数：按事件推进到 0.9 封顶，完成事件时归 1
    let prog = 0.1;
    const { taskId: upstreamId, resultText, workspace } = await this.infini.runAnalysis({
      question: task.question,
      csvText: ds.csv,
      datasourceName: ds.name,
      onProgress: (p) => {
        prog = Math.min(0.9, prog + 0.08);
        this.emit(task, { stage: p.stage, message: p.message, progress: prog });
      },
    });
    task.upstreamTaskId = upstreamId;   // 评委可持此 ID 到 app.infinisynapse.cn/tasks 核对日志

    const report = this._mapCloudReport(resultText, task, ds, upstreamId);
    if (workspace && Array.isArray(workspace.files) && workspace.files.length) {
      report.sections.push({ h: "云端产物文件", lines: workspace.files.map((f) => String(f.name || f.path || f)) });
    }
    this._finish(task, report);
  }

  /** 云端结论 → 前端同构报告。优先解析约定 JSON；解析不出时如实按纯文本呈现（绝不编造结构） */
  _mapCloudReport(resultText, task, ds, upstreamId) {
    const base = {
      chart: null,
      intent: "cloud",
      rowCount: ds.rows.length,
      engine: "infinisynapse",
      taskId: task.id,
      upstreamTaskId: upstreamId,
    };
    const j = extractJson(String(resultText || ""));
    if (j && j.title && j.verdict) {
      return Object.assign(base, {
        title: String(j.title).slice(0, 32),
        verdict: String(j.verdict).slice(0, 200),
        sections: Array.isArray(j.sections)
          ? j.sections.slice(0, 8).map((s) => ({
              h: String(s.h || "").slice(0, 32),
              lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 12).map((l) => String(l).slice(0, 300)),
            }))
          : [],
      });
    }
    this.log.warn("cloud result not in agreed JSON, fallback to plain text", { taskId: task.id });
    return Object.assign(base, {
      title: "InfiniSynapse 分析",
      verdict: String(resultText).slice(0, 200),
      sections: [{ h: "云端结论", lines: String(resultText).split(/\n+/).filter(Boolean).slice(0, 20).map((l) => l.slice(0, 300)) }],
    });
  }

  /* ── 终态 ─────────────────────────────────── */

  _finish(task, report) {
    task.report = report;
    task.status = "done";
    task.finishedAt = Date.now();
    this.emit(task, { done: true, progress: 1, message: "分析完成" });
    this.log.info("task done", { taskId: task.id, engine: task.engine, upstreamTaskId: task.upstreamTaskId || undefined, ms: task.finishedAt - task.createdAt });
  }

  _fail(task, err) {
    if (task.status !== "running") return;
    task.status = "failed";
    task.error = err && err.message ? err.message : "分析失败";
    task.finishedAt = Date.now();
    this.emit(task, { done: true, error: task.error, message: "分析失败：" + task.error });
    this.log.error("task failed", { taskId: task.id, engine: task.engine, error: task.error });
  }

  sweep(now) {
    for (const [id, t] of this.map) {
      if (t.finishedAt && now - t.finishedAt > this.cfg.taskTtlMs) this.map.delete(id);
    }
  }

  /** 优雅停机：关掉所有挂着的 SSE 连接 */
  closeAll() {
    for (const t of this.map.values()) this._closeSubscribers(t);
  }
}

module.exports = { TaskStore };
