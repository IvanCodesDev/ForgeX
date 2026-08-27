/* 分析任务编排：任务存储 + 进度事件（SSE 订阅/重放）+ provider 路由 + 结果缓存。
   事件全量缓存后重放，SSE 晚接入或断线重连都不丢进度；任务终态后连接自动收口。

   provider 由 services/providers.js 决定（local / openai 兼容），单次请求还可
   自带 OpenAI 兼容端点覆盖进程级配置（ctx.aiOverride，优先级最高）。
   本模块不关心用的是哪个 AI——它只负责编排、进度、缓存与终态。 */
"use strict";
const crypto = require("crypto");
const { sseSend } = require("../lib/http");
const { createProvider } = require("./providers");
const { retrieve } = require("./retrieval");

/**
 * 结果缓存：同一「问题 + 数据集 + provider」不重复调用 AI。
 *
 * 为什么必须有：一次云端分析实测 160–230 秒且要花钱，
 * 用户手滑点两次、或者刷新页面重问同一个问题，不该产生第二次调用。
 * LRU + TTL，容量与时长都可配。
 */
class ResultCache {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map(); // Map 迭代序 = 插入序；命中时 delete+set 使其等于「最近使用序」
  }

  key(question, datasourceId, provider, scope) {
    return crypto
      .createHash("sha256")
      .update([provider, datasourceId, String(question).trim()].join("\0"))
      .update(String(scope || "global"))
      .digest("hex")
      .slice(0, 32);
  }

  get(k) {
    const hit = this.map.get(k);
    if (!hit) return null;
    if (Date.now() - hit.at > this.cfg.cacheTtlMs) {
      this.map.delete(k);
      return null;
    }
    this.map.delete(k);
    this.map.set(k, hit); // 提升为最近使用
    return hit.report;
  }

  set(k, report) {
    if (this.cfg.cacheMax <= 0) return;
    this.map.delete(k);
    this.map.set(k, { at: Date.now(), report });
    while (this.map.size > this.cfg.cacheMax) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  sweep(now) {
    for (const [k, v] of this.map) {
      if (now - v.at > this.cfg.cacheTtlMs) this.map.delete(k);
    }
  }
}

class TaskStore {
  constructor(cfg, log, knowledge, gate, persistence, rulesEngine) {
    this.cfg = cfg;
    this.log = log;
    this.knowledge = knowledge || null;
    this.gate = gate || null; // 成本闸门；null 表示不限（本地开发）
    this.persistence = persistence || null;
    this.rulesEngine = rulesEngine || null; // 未注入时由 providers.js 自建（默认 node 模式）
    this.map = new Map();
    this.provider = createProvider(cfg, log, { rulesEngine: this.rulesEngine });
    this.fallback = createProvider(Object.assign({}, cfg, { provider: "local" }), log, {
      forceLocal: true,
      rulesEngine: this.rulesEngine,
    });
    this.cache = new ResultCache(cfg);
    this.onTerminal = null;
  }

  /** 当前是否走 AI（决定要不要过闸门、要不要检索知识） */
  get usesAi() {
    return !!this.provider.capabilities.ai;
  }

  /**
   * 启动探活：AI provider 不可用时立刻降级为规则引擎。
   *
   * 人工核准类开关只能证明「有人核准过端点」，证明不了「此刻密钥还有效、
   * 服务还活着」。探活是运行时事实，人工标记是历史记忆。
   */
  async probeProvider() {
    if (!this.provider.probe) return { ok: true, skipped: true };
    const out = await this.provider.probe();
    if (out.ok) {
      this.log.info("provider probe ok", { provider: this.provider.id, detail: out.detail });
      return out;
    }
    this.log.warn("provider probe failed, falling back to rules engine", {
      provider: this.provider.id,
      detail: out.detail,
    });
    this.probeFailure = { provider: this.provider.id, detail: out.detail };
    this.provider = this.fallback;
    return out;
  }

  /** 检索与问题相关的知识片段。检索不到就返回空——宁可不给，也不给无关内容。 */
  knowledgeFor(question, provider, owner) {
    if (!this.knowledge || !(provider || this.provider).capabilities.ai) return [];
    const docs = this.knowledge.all(owner);
    if (!docs.length) return [];
    const hits = retrieve(docs, question, { topK: 4 });
    if (hits.length) {
      this.log.info("knowledge retrieved", { hits: hits.length, top: hits[0].name, score: hits[0].score });
    }
    return hits;
  }

  create(question, ds, reqId, ctx) {
    ctx = ctx || {};
    // 用户自带端点：仅本次任务生效。密钥只存在于 provider 闭包中——
    // task 对象不携带任何 aiOverride 字段，持久化快照与响应因此天然无密钥。
    const providerImpl = ctx.aiOverride
      ? createProvider(
          Object.assign({}, this.cfg, {
            provider: "openai",
            openaiBaseUrl: ctx.aiOverride.baseUrl,
            openaiKey: ctx.aiOverride.apiKey,
            openaiModel: ctx.aiOverride.model,
          }),
          this.log,
          { rulesEngine: this.rulesEngine }
        )
      : this.provider;
    // 结果缓存按端点+模型分桶：换了端点或模型不应命中旧叙述（密钥不参与派生）。
    const cacheVariant = ctx.aiOverride
      ? crypto.createHash("sha256").update(ctx.aiOverride.baseUrl + "\0" + ctx.aiOverride.model).digest("hex").slice(0, 16)
      : "";
    const task = {
      id: "t_" + crypto.randomBytes(8).toString("hex"),
      question,
      datasourceId: ds.id,
      engine: providerImpl.id,
      provider: providerImpl.id,
      providerImpl,
      cacheVariant,
      credentialScope: ctx.credentialScope || "global",
      status: "running",
      events: [],
      evSeq: 0,
      report: null,
      error: null,
      upstreamTaskId: null,
      cached: false,
      shared: false,
      caller: ctx.caller || "anonymous",
      degraded: false,
      subscribers: new Set(),
      createdAt: Date.now(),
      finishedAt: 0,
    };
    if (this.persistence && typeof this.persistence.context === "function") {
      Object.assign(task, this.persistence.context(task.caller));
    }
    this.map.set(task.id, task);
    this._persist(task);
    this.log.info("task created", {
      reqId,
      taskId: task.id,
      provider: providerImpl.id,
      datasourceId: ds.id,
      rows: ds.rows.length,
    });

    this._run(task, ds).catch((err) => this._fail(task, err));
    return task;
  }

  /** 统一执行路径：缓存 → provider → 终态。provider 之间的差异全在 providers.js 里。 */
  async _run(task, ds) {
    const datasourceKey = ds.cacheKey || ds.contentSha256 || ds.id;
    const providerKey = task.cacheVariant ? task.providerImpl.id + ":" + task.cacheVariant : task.providerImpl.id;
    const ck = this.cache.key(task.question, datasourceKey, providerKey, task.credentialScope);

    const cached = this.cache.get(ck);
    if (cached) {
      // 命中缓存也要如实标注——用户有权知道这份结果不是刚算的
      this.emit(task, { stage: "cache", message: "命中缓存，未重复调用分析引擎", progress: 1 });
      const report = Object.assign({}, cached, { taskId: task.id, cached: true });
      task.cached = true;
      task.upstreamTaskId = cached.upstreamTaskId || null;
      this._finish(task, report);
      return;
    }

    const report = await this._runProvider(task, ds);

    report.taskId = task.id;
    report.cached = false;
    if (report.upstreamTaskId) task.upstreamTaskId = report.upstreamTaskId;
    this.cache.set(ck, report);
    this._finish(task, report);
  }

  /**
   * 执行 provider，AI 路径先过成本闸门。
   *
   * 关键设计：**额度用尽不等于服务不可用**。规则引擎不花钱，凭什么限流——
   * 所以闸门关死时降级为规则引擎继续给出结论（依然带置信区间与显著性检验），
   * 只是少了 AI 叙述，并在报告里如实说明为什么降级。
   */
  async _runProvider(task, ds) {
    const provider = task.providerImpl || this.provider;
    const usesAi = !!provider.capabilities.ai;
    if (!usesAi || !this.gate) {
      return provider.analyze({
        question: task.question,
        dataset: ds,
        knowledge: this.knowledgeFor(task.question, provider, task.caller),
        onProgress: (p) => this.emit(task, p),
      });
    }

    const verdict = this.gate.check(task.caller);
    if (!verdict.ok) {
      this.log.info("quota exhausted, degrading to rules engine", {
        taskId: task.id,
        caller: task.caller,
        code: verdict.code,
      });
      this.emit(task, { stage: "quota", message: "AI 额度已用尽，降级为规则引擎", progress: 0.1 });
      return this._degrade(task, ds, verdict.reason, verdict.code);
    }

    let release;
    try {
      release = await this.gate.acquire((q) => {
        this.emit(task, {
          stage: "queued",
          message: "排队中：前面还有 " + (q.position - 1) + " 个任务（并发上限 " + this.cfg.aiConcurrency + "）",
          progress: 0.03,
        });
      });
    } catch (e) {
      // 队列也满了：同样降级而不是报错——用户要的是结论，不是 503
      this.log.warn("ai queue full, degrading", { taskId: task.id, code: e.code });
      return this._degrade(task, ds, e.message, e.code || "queue_full");
    }

    try {
      this.gate.consume(task.caller);
      task.quotaRemaining = verdict.remaining;
      return await provider.analyze({
        question: task.question,
        dataset: ds,
        knowledge: this.knowledgeFor(task.question, provider, task.caller),
        onProgress: (p) => this.emit(task, p),
      });
    } finally {
      release();
    }
  }

  /** 降级为规则引擎，并把降级原因如实写进报告 */
  async _degrade(task, ds, reason, code) {
    task.degraded = true;
    task.degradeCode = code;
    const report = await this.fallback.analyze({
      question: task.question,
      dataset: ds,
      knowledge: [],
      onProgress: (p) => this.emit(task, p),
    });
    report.degradedFrom = (task.providerImpl || this.provider).id;
    report.degradeReason = reason;
    report.sections = (report.sections || []).concat([
      {
        h: "为什么这份报告没有 AI 叙述",
        lines: [
          reason,
          "以上结论由规则引擎产出：统计口径、置信区间、显著性检验与 AI 模式完全一致——" +
            "少的只是自然语言叙述，数字一个都没少。",
        ],
      },
    ]);
    return report;
  }

  get(id) {
    return this.map.get(String(id || "")) || null;
  }

  async ready(owner) {
    if (!this.persistence || typeof this.persistence.ready !== "function") return;
    const snapshots = await this.persistence.ready(owner);
    for (const snapshot of snapshots || []) {
      if (!this.map.has(snapshot.id)) this.map.set(snapshot.id, snapshot);
    }
  }

  _persist(task) {
    if (!this.persistence || typeof this.persistence.save !== "function") return;
    this.persistence.save(task).catch((error) => {
      this.log.warn("analysis task persistence failed", { taskId: task.id, error: error.message });
    });
  }

  persist(task) {
    if (!this.persistence || typeof this.persistence.save !== "function") return Promise.resolve();
    return this.persistence.save(task);
  }

  /* ── 进度事件 ─────────────────────────────── */

  emit(task, ev) {
    const event = Object.assign({ seq: ++task.evSeq, ts: Date.now() }, ev);
    task.events.push(event);
    for (const res of task.subscribers) {
      if (!sseSend(res, event)) task.subscribers.delete(res);
    }
    if (event.done) this._closeSubscribers(task);
    this._persist(task);
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
      try {
        res.end();
      } catch (e) {
        /* 连接已断 */
      }
    }
    task.subscribers.clear();
  }

  /* ── 终态 ─────────────────────────────────── */

  _finish(task, report) {
    task.report = report;
    task.status = "done";
    task.finishedAt = Date.now();
    this.emit(task, { done: true, progress: 1, message: "分析完成" });
    this.log.info("task done", {
      taskId: task.id,
      engine: task.engine,
      upstreamTaskId: task.upstreamTaskId || undefined,
      ms: task.finishedAt - task.createdAt,
    });
    if (this.onTerminal) this.onTerminal(task);
  }

  _fail(task, err) {
    if (task.status !== "running") return;
    task.status = "failed";
    task.error = err && err.message ? err.message : "分析失败";
    task.finishedAt = Date.now();
    this.emit(task, { done: true, error: task.error, message: "分析失败：" + task.error });
    this.log.error("task failed", { taskId: task.id, engine: task.engine, error: task.error });
    if (this.onTerminal) this.onTerminal(task);
  }

  sweep(now) {
    this.cache.sweep(now);
    for (const [id, t] of this.map) {
      if (t.finishedAt && now - t.finishedAt > this.cfg.taskTtlMs) this.map.delete(id);
    }
    if (this.persistence && typeof this.persistence.sweep === "function") {
      this.persistence.sweep(now).catch((error) => {
        this.log.warn("analysis task persistence sweep failed", { error: error.message });
      });
    }
  }

  /** 优雅停机：关掉所有挂着的 SSE 连接 */
  closeAll() {
    for (const t of this.map.values()) this._closeSubscribers(t);
  }

  async close() {
    this.closeAll();
    if (this.persistence && typeof this.persistence.close === "function") await this.persistence.close();
  }
}

module.exports = { TaskStore };
