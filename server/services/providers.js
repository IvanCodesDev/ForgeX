/* AnalysisProvider 抽象 —— 把「用什么引擎分析」变成一个可替换的实现细节。

   重构前的问题：分析能力硬绑 InfiniSynapse 一家，而且是靠手工 INFINI_VERIFIED=1
   开关。对一个开源项目来说这是硬伤——别人拿去用，多半用的不是这家。

   当前契约：

     provider = {
       id, label,
       capabilities: { ai, streaming, structuredOutput },
       analyze({ question, dataset, knowledge, onProgress }) -> Promise<AnalysisReport>
     }

   ★ 最重要的架构约定：**LLM 只负责叙述，数字由本地统计核算。**

   本地统计核先算出完整报告（含 Wilson 区间、Fisher 检验、图表、highlight、evidence），
   AI provider 拿到的是**已验证的统计简报**而非原始 CSV，只负责把事实组织成叙述。
   合并时叙述用 LLM 的，图表 / highlight / evidence 一律用本地的。

   这样做的三个后果：
     1. 云端模式不再弱于本地——图表与视口联动始终存在；
     2. prompt 与数据量解耦——上万行也不会超限；
     3. 叙述里的每个数字都能在 evidence 里找到出处，不是 LLM 心算的。 */
"use strict";

const { createRulesEngine } = require("./rules-engine");

/** 统计核与简报统一走规则引擎边界；未注入时自建（默认 node 模式，行为不变）。 */
function resolveRulesEngine(cfg, rulesEngine) {
  return rulesEngine || createRulesEngine({ config: cfg });
}

function authorityRow(row) {
  const value = row || {};
  const number = (name, fallback) => {
    const candidate = value[name];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  };
  return {
    job_id: typeof value.job_id === "string" ? value.job_id : typeof value.jobId === "string" ? value.jobId : null,
    date: typeof value.date === "string" ? value.date : null,
    machine_id: typeof value.machine_id === "string" ? value.machine_id : typeof value.machineId === "string" ? value.machineId : null,
    model_name: typeof value.model_name === "string" ? value.model_name : typeof value.modelName === "string" ? value.modelName : null,
    material: typeof value.material === "string" ? value.material : null,
    layer_height_mm: number("layer_height_mm", number("layerHeightMm", null)),
    duration_min: number("duration_min", number("durationMin", null)),
    filament_g: number("filament_g", number("filamentG", null)),
    cost_fen: number("cost_fen", number("costFen", null)),
    status: value.status === "fail" ? "fail" : "success",
    fail_reason: typeof value.fail_reason === "string" ? value.fail_reason : typeof value.failReason === "string" ? value.failReason : null,
    energy_kwh: number("energy_kwh", number("energyKwh", null)),
  };
}

function csharpAnalyticsProvider(cfg) {
  return {
    id: "server-rules",
    label: "C# Analytics 权威规则引擎",
    capabilities: { ai: false, streaming: false, structuredOutput: true },

    async probe() {
      if (!cfg.gcodeAuthorityUrl || !cfg.analyticsAuthorityEnabled) {
        return { ok: false, detail: "C# Analytics authority is not configured" };
      }
      try {
        const response = await fetch(new URL("/health/live", cfg.gcodeAuthorityUrl), {
          signal: AbortSignal.timeout(cfg.analyticsAuthorityTimeoutMs),
        });
        return response.ok
          ? { ok: true, detail: "C# Analytics authority reachable" }
          : { ok: false, detail: "HTTP " + response.status };
      } catch (error) {
        return { ok: false, detail: error && error.message ? error.message : String(error) };
      }
    },

    async analyze({ question, dataset, onProgress }) {
      if (!cfg.gcodeAuthorityUrl || !cfg.analyticsAuthorityEnabled) {
        throw new Error("C# Analytics authority is not configured");
      }
      onProgress({ stage: "authority", message: "调用 C# Analytics 权威规则引擎", progress: 0.25 });
      const body = {
        schemaVersion: "1.0",
        question: String(question || "").trim(),
        rows: (dataset.rows || []).map(authorityRow),
        provenance: null,
      };
      const response = await fetch(new URL("/api/v1/analytics/reports", cfg.gcodeAuthorityUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.analyticsAuthorityTimeoutMs),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error("C# Analytics authority HTTP " + response.status + (detail ? ": " + detail.slice(0, 240) : ""));
      }
      const payload = await response.json();
      if (
        !payload ||
        !payload.engine ||
        payload.engine.name !== "forgex-analytics-csharp" ||
        !payload.report ||
        payload.report.engine !== "local-rules" ||
        payload.report.rowCount !== body.rows.length
      ) {
        throw new Error("C# Analytics authority response contract is invalid");
      }
      const report = Object.assign({}, payload.report, {
        engine: "server-rules",
        authorityEngine: payload.engine,
        statsBy: "csharp-analytics-authority",
      });
      onProgress({ stage: "complete", message: "C# Analytics 权威结果已返回", progress: 1 });
      return report;
    },
  };
}

/* ══ 本地规则引擎 provider ═══════════════════ */

function localProvider(cfg, rulesEngine) {
  const rules = resolveRulesEngine(cfg, rulesEngine);
  return {
    id: "server-rules",
    label: "后端规则引擎（无 AI）",
    capabilities: { ai: false, streaming: false, structuredOutput: true },

    /** 本地引擎永远可用，无需探活 */
    async probe() {
      return { ok: true, detail: "本地统计，无外部依赖" };
    },

    async analyze({ question, dataset, onProgress }) {
      const steps = [
        ["intent", "解析问题意图", 0.2],
        ["aggregate", "聚合与统计检验", 0.6],
        ["generate", "生成结论与建议", 0.9],
      ];
      for (const [stage, message, progress] of steps) {
        onProgress({ stage, message, progress });
        if (cfg.mockDelayMs > 0) await sleep(cfg.mockDelayMs);
      }
      const report = await rules.analyze(question, dataset.rows, { provenance: dataset.provenance || null });
      report.engine = "server-rules";
      return report;
    },
  };
}

/* ══ AI provider 的公共骨架 ══════════════════ */

/** 发给 LLM 的系统指令。约束的核心是「不要自己算数」。 */
const SYSTEM_PROMPT = [
  "你是增材制造（3D 打印）领域的资深数据分析师。",
  "下面会给你一份**已经算好的统计简报**——所有比例、置信区间、显著性检验都已由确定性统计程序计算并核验。",
  "",
  "你的职责是把这些事实组织成一份可读的分析报告，**不是重新计算**。硬性要求：",
  "1. 只使用简报中出现的数字。**不要自己做任何算术**（不要相加、相减、求平均、估算比例）。",
  "2. 简报标注「显著高于其余」的项，才可以说「显著」；未标注的必须写明「差异未达统计显著」。",
  "3. 报告比例时连同 95% 置信区间一起给出，不要只给点估计。",
  "4. 样本量不足的分组，只能提及其存在，不得据此下结论。",
  "5. 相关性只描述共变关系，**不得表述为因果**（不要写「调大层高会更快」这类因果主张）。",
  "6. 简报里没有的信息，一律回答不知道，不要推测。",
  "7. 中文回答，给出可执行的排查建议，但建议必须由简报中的事实支撑。",
].join("\n");

function userPrompt(question, brief, knowledge) {
  const parts = [];
  if (knowledge && knowledge.length) {
    parts.push("# 领域知识（供理解术语，不含数据）");
    parts.push(knowledge.map((d) => `## ${d.name}\n${d.text}`).join("\n\n"));
    parts.push("");
  }
  parts.push("# 统计简报（已核验，勿重算）");
  parts.push(brief);
  parts.push("");
  parts.push("# 用户问题");
  parts.push(question);
  parts.push("");
  parts.push("# 输出格式");
  parts.push("严格输出如下 JSON，不要输出 JSON 以外的任何文字：");
  parts.push('{"title":"报告标题(≤16字)","verdict":"一句话核心结论(≤120字，含关键数字与区间)",' +
    '"sections":[{"h":"小节标题","lines":["要点…"]}]}');
  return parts.join("\n");
}

/**
 * 合并：LLM 叙述 + 本地统计产物。
 * 图表 / highlight / evidence / provenance 一律以本地为准——
 * 这是「云端不再弱于本地」的实现点，也是数字可追溯的保证。
 */
function mergeWithLocal(narrative, localReport, meta) {
  const merged = Object.assign({}, localReport);
  if (narrative && narrative.title) merged.title = String(narrative.title).slice(0, 40);
  if (narrative && narrative.verdict) merged.verdict = String(narrative.verdict).slice(0, 400);
  if (narrative && Array.isArray(narrative.sections) && narrative.sections.length) {
    merged.sections = narrative.sections.slice(0, 10).map((s) => ({
      h: String(s.h || "").slice(0, 40),
      lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 14).map((l) => String(l).slice(0, 400)),
    }));
    // 统计明细始终保留在末尾：叙述可以概括，但依据不能被概括掉
    const detail = (localReport.sections || []).filter((s) => /排行|统计|口径|读数说明|相关性/.test(s.h));
    for (const d of detail) merged.sections.push(d);
  }
  merged.engine = meta.engine;
  merged.narrativeBy = meta.narrativeBy || null;
  merged.statsBy = "local-stats-kernel";      // 数字的出处，与叙述的出处分开标注
  if (meta.upstreamTaskId) merged.upstreamTaskId = meta.upstreamTaskId;
  if (meta.model) merged.model = meta.model;
  if (!narrative) {
    merged.sections = (merged.sections || []).concat([{
      h: "叙述降级说明",
      lines: ["AI 未返回可解析的结构化结果，以上为本地统计引擎的原始产物。数字不受影响。"],
    }]);
  }
  return merged;
}

/** 从可能带说明文字/代码围栏的文本中提取第一个完整 JSON 对象 */
function extractJson(text) {
  const start = String(text || "").indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
    }
  }
  return null;
}

/* ══ InfiniSynapse provider ══════════════════ */

function infiniProvider(cfg, log, infini, rulesEngine) {
  const rules = resolveRulesEngine(cfg, rulesEngine);
  return {
    id: "infinisynapse",
    label: "InfiniSynapse 云端 AI",
    capabilities: { ai: true, streaming: true, structuredOutput: false },

    /** 启动探活：只读一次 profile，失败即降级——不等到用户提问才发现密钥是错的 */
    async probe() {
      try {
        const out = await infini.profile();
        return { ok: true, detail: "userId=" + ((out && out.data && out.data.userId) || "?") };
      } catch (e) {
        return { ok: false, detail: e.message };
      }
    },

    async analyze({ question, dataset, knowledge, onProgress }) {
      onProgress({ stage: "stats", message: "本地统计核计算中（置信区间与显著性检验）", progress: 0.15 });
      const local = await rules.analyze(question, dataset.rows, { provenance: dataset.provenance || null });
      const brief = await rules.buildBrief(dataset.rows);

      onProgress({ stage: "submit", message: "提交 InfiniSynapse 分析任务", progress: 0.25 });
      let prog = 0.25;
      const out = await infini.runAnalysis({
        question,
        // 传统计简报而非整份 CSV：token 成本与数据量解耦
        briefText: brief.text,
        systemPrompt: SYSTEM_PROMPT,
        userText: userPrompt(question, brief.text, knowledge),
        datasourceName: dataset.name,
        onProgress: (p) => {
          prog = Math.min(0.9, prog + 0.08);
          onProgress({ stage: p.stage, message: p.message, progress: prog });
        },
      });

      onProgress({ stage: "merge", message: "合并 AI 叙述与本地统计产物", progress: 0.95 });
      const narrative = extractJson(out.resultText);
      if (!narrative) log.warn("provider narrative not parseable, falling back to local narrative", { provider: "infinisynapse" });
      const merged = mergeWithLocal(narrative, local, {
        engine: "infinisynapse",
        narrativeBy: "infinisynapse",
        upstreamTaskId: out.taskId,
      });
      if (out.workspace && Array.isArray(out.workspace.files) && out.workspace.files.length) {
        merged.sections.push({
          h: "云端产物文件",
          lines: out.workspace.files.map((f) => String(f.name || f.path || f)),
        });
      }
      return merged;
    },
  };
}

/* ══ OpenAI 兼容 provider ════════════════════ */

/**
 * 任何暴露 /chat/completions 的服务都能接：OpenAI、Azure OpenAI、
 * 本地 Ollama（/v1）、vLLM、以及各家国产兼容端点。
 * 配置见 server/.env.example 的 OPENAI_* 段。
 */
function openaiProvider(cfg, log, rulesEngine) {
  const rules = resolveRulesEngine(cfg, rulesEngine);
  return {
    id: "openai-compatible",
    label: "OpenAI 兼容 AI（" + (cfg.openaiModel || "未指定模型") + "）",
    capabilities: { ai: true, streaming: false, structuredOutput: true },

    /** 启动探活：列一次模型，验证 base URL 与 key 都对 */
    async probe() {
      try {
        const res = await fetch(cfg.openaiBaseUrl.replace(/\/$/, "") + "/models", {
          headers: { Authorization: "Bearer " + cfg.openaiKey },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, detail: "HTTP " + res.status };
        return { ok: true, detail: cfg.openaiModel };
      } catch (e) {
        return { ok: false, detail: e.message };
      }
    },

    async analyze({ question, dataset, knowledge, onProgress }) {
      onProgress({ stage: "stats", message: "本地统计核计算中（置信区间与显著性检验）", progress: 0.2 });
      const local = await rules.analyze(question, dataset.rows, { provenance: dataset.provenance || null });
      const brief = await rules.buildBrief(dataset.rows);

      onProgress({ stage: "submit", message: "请求 " + cfg.openaiModel, progress: 0.4 });
      const url = cfg.openaiBaseUrl.replace(/\/$/, "") + "/chat/completions";
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.openaiKey,
        },
        body: JSON.stringify({
          model: cfg.openaiModel,
          temperature: 0.2,                       // 叙述任务，低温更稳
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt(question, brief.text, knowledge) },
          ],
        }),
        signal: AbortSignal.timeout(cfg.openaiTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 上游报文可能含敏感细节：日志留全文，对外只给状态码
        log.error("openai upstream error", { status: res.status, body: body.slice(0, 500) });
        throw new Error("AI 服务响应异常（HTTP " + res.status + "）");
      }
      const j = await res.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;

      onProgress({ stage: "merge", message: "合并 AI 叙述与本地统计产物", progress: 0.9 });
      const narrative = extractJson(text);
      if (!narrative) log.warn("provider narrative not parseable, falling back to local narrative", { provider: "openai-compatible" });
      const merged = mergeWithLocal(narrative, local, {
        engine: "openai-compatible",
        narrativeBy: cfg.openaiModel,
        model: cfg.openaiModel,
      });
      if (j && j.usage) merged.tokenUsage = j.usage;
      return merged;
    },
  };
}

/* ══ 工厂 ════════════════════════════════════ */

/**
 * 按配置选出 provider。选择逻辑集中在此处，
 * routes / analysis 不需要知道有哪些 provider 存在。
 */
function createProvider(cfg, log, deps) {
  const rules = resolveRulesEngine(cfg, deps && deps.rulesEngine);
  if (cfg.provider === "infinisynapse") return infiniProvider(cfg, log, deps.infini, rules);
  if (cfg.provider === "openai") return openaiProvider(cfg, log, rules);
  if (
    !(deps && deps.forceLocal) &&
    !cfg.forceMock &&
    cfg.gcodeAuthorityUrl &&
    cfg.analyticsAuthorityEnabled &&
    cfg.serverRulesAuthority !== false
  ) {
    return csharpAnalyticsProvider(cfg);
  }
  return localProvider(cfg, rules);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  createProvider,
  localProvider,
  csharpAnalyticsProvider,
  infiniProvider,
  openaiProvider,
  mergeWithLocal,
  extractJson,
  SYSTEM_PROMPT,
  userPrompt,
};
