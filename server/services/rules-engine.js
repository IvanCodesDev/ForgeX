/* Stage 8.3：本地规则计算腿的权威边界（RULES_ENGINE_AUTHORITY=node|csharp）。

   这里收拢了此前散落在 datasource / calibration / providers 里的五件事：
   CSV 规范化、内置 farm 数据集、数据契约元信息、统计简报、校准包验证。
   消费方只面对一个**统一异步**的方法面，不再直接 require classic 逻辑——
   于是切到 C# sidecar 时不需要再碰任何消费方。

   - node 模式（默认）：惰性 require 现有 local-engine / brief / calibration-registry，
     计算语义与切流前逐字节一致，只是从「构造时同步取值」变成「首次调用时取值」。
   - csharp 模式：fetch ForgeX.Api 的内部端点（与 G-code 权威共用同一 sidecar origin），
     端点契约的唯一权威是 backend/src/ForgeX.Api/RulesEngineEndpoints.cs。
     错误处理沿用 providers.js 的写法：非 2xx 抛状态码 + 截断的响应正文。 */
"use strict";

/** farm/meta 这类不变量只取一次；失败不缓存，下次调用重试（与 postgres ready() 同模式）。 */
function memoize(fn) {
  let cached = null;
  return function () {
    if (!cached) {
      cached = Promise.resolve().then(fn);
      cached.catch(() => {
        cached = null;
      });
    }
    return cached;
  };
}

/* ══ node 模式：classic 规则腿 ═══════════════ */

function nodeEngine() {
  // 惰性加载：classic 脚本挂 globalThis，只在真正用到时才拉起
  let localEngine = null;
  let briefModule = null;
  let registry = null;
  const local = () => localEngine || (localEngine = require("./local-engine"));
  const brief = () => briefModule || (briefModule = require("./brief"));
  const calibrationRegistry = () => {
    if (!registry) {
      require("../../frontend/classic/js/time-calibration.js");
      require("../../frontend/classic/js/calibration-registry.js");
      registry = globalThis.FXCalibrationRegistry;
    }
    return registry;
  };

  return {
    mode: "node",
    farm: memoize(async () => ({
      csv: local().farmCsv(),
      rows: local().farmRows(),
      provenance: local().PROVENANCE.farm,
    })),
    meta: memoize(async () => ({
      fields: local().FIELDS,
      minSample: local().MIN_SAMPLE,
      provenance: local().PROVENANCE,
    })),
    async normalizeCsv(text) {
      const out = local().parseCsv(text);
      return { rows: out.rows, errors: out.errors, csv: local().toCsv(out.rows) };
    },
    async buildBrief(rows) {
      return brief().buildBrief(rows);
    },
    async validateBundle(bundle) {
      const checked = calibrationRegistry().validateBundle(bundle);
      return { ok: checked.ok, errors: checked.errors };
    },
    async analyze(question, rows, opts) {
      return local().analyze(question, rows, opts);
    },
  };
}

/* ══ csharp 模式：ForgeX.Api sidecar ═════════ */

function csharpEngine(cfg) {
  async function call(pathname, body) {
    const response = await fetch(new URL(pathname, cfg.gcodeAuthorityUrl), {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.rulesEngineTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error("C# rules engine HTTP " + response.status + (detail ? ": " + detail.slice(0, 240) : ""));
    }
    const payload = await response.json();
    if (
      !payload ||
      payload.schemaVersion !== "1.0" ||
      !payload.engine ||
      payload.engine.name !== "forgex-analytics-csharp"
    ) {
      throw new Error("C# rules engine response contract is invalid (" + pathname + ")");
    }
    return payload;
  }

  return {
    mode: "csharp",
    farm: memoize(async () => {
      const payload = await call("/api/v1/analytics/datasets/farm");
      if (typeof payload.csv !== "string" || !Array.isArray(payload.rows) || !payload.provenance) {
        throw new Error("C# rules engine farm dataset response is invalid");
      }
      return { csv: payload.csv, rows: payload.rows, provenance: payload.provenance };
    }),
    meta: memoize(async () => {
      const payload = await call("/api/v1/analytics/datasets/meta");
      if (!Array.isArray(payload.fields) || !payload.provenance || typeof payload.provenance !== "object") {
        throw new Error("C# rules engine dataset meta response is invalid");
      }
      return { fields: payload.fields, minSample: payload.minSample, provenance: payload.provenance };
    }),
    async normalizeCsv(text) {
      const payload = await call("/api/v1/analytics/datasets/normalize", {
        schemaVersion: "1.0",
        csvText: String(text == null ? "" : text),
      });
      if (!Array.isArray(payload.rows) || !Array.isArray(payload.errors) || typeof payload.csv !== "string") {
        throw new Error("C# rules engine normalize response is invalid");
      }
      return { rows: payload.rows, errors: payload.errors, csv: payload.csv };
    },
    async buildBrief(rows) {
      const payload = await call("/api/v1/analytics/briefs", { schemaVersion: "1.0", rows });
      if (typeof payload.text !== "string" || !payload.facts) {
        throw new Error("C# rules engine brief response is invalid");
      }
      return { text: payload.text, facts: payload.facts };
    },
    async validateBundle(bundle) {
      const payload = await call("/api/v1/calibration/validate", { schemaVersion: "1.0", bundle });
      if (typeof payload.ok !== "boolean" || !Array.isArray(payload.errors)) {
        throw new Error("C# rules engine calibration validate response is invalid");
      }
      return { ok: payload.ok, errors: payload.errors };
    },
    async analyze(question, rows, opts) {
      // 复用 providers.js 的 C# reports 通道（含契约校验与 engine 字段改写），不重复实现。
      // 惰性 require：providers.js 顶层依赖本模块，这里反向引用必须延迟到调用期。
      const { csharpAnalyticsProvider } = require("./providers");
      return csharpAnalyticsProvider(cfg).analyze({
        question,
        dataset: { rows, provenance: (opts && opts.provenance) || null },
        onProgress: () => {},
      });
    },
  };
}

/* ══ 工厂 ════════════════════════════════════ */

/**
 * 按 cfg.rulesEngineAuthority 返回统一的异步规则引擎边界。
 * createApp 建单例注入各消费方；直接 new 某个 store 的旧代码/测试
 * 不传 engine 时由 store 自建（默认 node 模式，行为不变）。
 */
function createRulesEngine({ config }) {
  return config.rulesEngineAuthority === "csharp" ? csharpEngine(config) : nodeEngine();
}

module.exports = { createRulesEngine };
