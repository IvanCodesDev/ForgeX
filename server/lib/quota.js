/* 成本闸门 —— 开源公网部署的生死线。

   问题有多实在：一次云端分析实测 160–230 秒且按 token 计费。
   这个服务如果配了密钥再公开访问，**任何人都能持续触发真实调用，费用记在维护者账上**。
   P0 体检时这一条被写进 SECURITY.md 作为「已知边界」，README 里也劝人别配密钥，
   但劝阻不是防护。这里把它变成防护。

   四道闸：

     ① 并发上限   同时最多几个 AI 任务在跑。超出的排队，不是拒绝——
                  用户手滑连点两下不该收到报错。
     ② 队列上限   队列也满了才拒绝，并告知前面还有几个。
     ③ 日预算     按「谁」计费：有 API key 按 key 算，没有按 IP 算。
                  跨重启持久化，否则重启就等于重置额度。
     ④ 全局日上限 兜底：即使有一堆不同的 key/IP，整个实例一天也烧不过这个数。

   规则引擎（本地统计）**不受任何闸门限制**——它不花钱，凭什么限流。
   这一点很重要：闸门关死时服务不该整个不可用，而是优雅降级为规则引擎。 */
"use strict";

const path = require("path");
const { JsonFile } = require("./store");

/** 当天日期键（UTC，避免时区导致的跨天歧义） */
function dayKey(now) {
  return new Date(now || Date.now()).toISOString().slice(0, 10);
}

class CostGate {
  /**
   * @param cfg.aiConcurrency   同时在跑的 AI 任务上限
   * @param cfg.aiQueueMax      排队上限
   * @param cfg.dailyPerCaller  单个调用方（key 或 IP）每日 AI 任务数上限；0 = 不限
   * @param cfg.dailyGlobal     整个实例每日 AI 任务数上限；0 = 不限
   * @param cfg.dataDir
   */
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.running = 0;
    this.queue = [];
    this.state = new JsonFile(
      path.join(cfg.dataDir, "usage.json"),
      { day: dayKey(), perCaller: {}, global: 0, totalEver: 0 },
      log
    );
    this._rollover();
  }

  /** 跨天重置。日预算按自然日计，重启不重置（这正是要持久化的原因）。 */
  _rollover() {
    const today = dayKey();
    if (this.state.data.day !== today) {
      this.log.info("quota rollover", { from: this.state.data.day, to: today });
      this.state.data.day = today;
      this.state.data.perCaller = {};
      this.state.data.global = 0;
      this.state.save();
    }
  }

  usedBy(caller) {
    this._rollover();
    return this.state.data.perCaller[caller] || 0;
  }

  /**
   * 检查是否还有额度。**不占用**，只是查询——
   * 用于在建任务之前给出明确拒绝，而不是排到队首才发现没钱。
   * @returns {{ok, reason?, code?, remaining?}}
   */
  check(caller) {
    this._rollover();
    const d = this.state.data;
    if (this.cfg.dailyGlobal > 0 && d.global >= this.cfg.dailyGlobal) {
      return {
        ok: false,
        code: "global_daily_exhausted",
        reason:
          "本实例今日的 AI 分析额度已用尽（" + this.cfg.dailyGlobal + " 次/日）。" +
          "规则引擎不受限制，仍可正常分析（结论同样带置信区间与显著性检验）；" +
          "需要 AI 叙述请自行部署并配置自己的 API key。",
      };
    }
    if (this.cfg.dailyPerCaller > 0) {
      const used = d.perCaller[caller] || 0;
      if (used >= this.cfg.dailyPerCaller) {
        return {
          ok: false,
          code: "caller_daily_exhausted",
          reason:
            "你今日的 AI 分析额度已用尽（" + this.cfg.dailyPerCaller + " 次/日）。" +
            "规则引擎不受限制，仍可正常分析；需要更多 AI 额度请自行部署并配置自己的 API key。",
          remaining: 0,
        };
      }
      return { ok: true, remaining: this.cfg.dailyPerCaller - used };
    }
    return { ok: true, remaining: Infinity };
  }

  /** 实际消耗一次额度（在任务真正提交给 AI 之前调用） */
  consume(caller) {
    this._rollover();
    const d = this.state.data;
    d.perCaller[caller] = (d.perCaller[caller] || 0) + 1;
    d.global += 1;
    d.totalEver += 1;
    this.state.save();
  }

  /**
   * 取得一个并发槽位。满了就排队；队列也满了就拒绝。
   * @param onQueued 排队时的回调，用于把「前面还有几个」告诉用户
   * @returns {Promise<function>} resolve 出 release()，务必在 finally 里调用
   */
  acquire(onQueued) {
    if (this.running < this.cfg.aiConcurrency) {
      this.running++;
      return Promise.resolve(() => this._release());
    }
    if (this.queue.length >= this.cfg.aiQueueMax) {
      const err = new Error(
        "分析队列已满（正在跑 " + this.running + " 个，排队 " + this.queue.length +
        " 个）。请稍后重试，或改用不受限的规则引擎。"
      );
      err.code = "queue_full";
      err.status = 503;
      return Promise.reject(err);
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (onQueued) onQueued({ position: this.queue.length, running: this.running });
    });
  }

  _release() {
    const next = this.queue.shift();
    if (next) {
      // 槽位直接交给下一个，running 不变
      next(() => this._release());
      return;
    }
    this.running = Math.max(0, this.running - 1);
  }

  /** 供 /metrics 与 /healthz 读取 */
  snapshot() {
    this._rollover();
    const d = this.state.data;
    return {
      running: this.running,
      queued: this.queue.length,
      concurrencyLimit: this.cfg.aiConcurrency,
      queueLimit: this.cfg.aiQueueMax,
      day: d.day,
      globalUsed: d.global,
      globalLimit: this.cfg.dailyGlobal || null,
      perCallerLimit: this.cfg.dailyPerCaller || null,
      callers: Object.keys(d.perCaller).length,
      totalEver: d.totalEver,
      persisted: this.state.enabled,
    };
  }
}

module.exports = { CostGate, dayKey };
