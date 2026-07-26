/* FORGE·X 智造洞察 — 后端 API 客户端（对接自有薄后端 → InfiniSynapse Server API）
   设计见 doc/开发文档.md §8.3。当前后端未部署时 available=false，
   insight 面板自动落到浏览器内的本地规则引擎（FXInsightEngine），后端上线后零改动切换。 */
(function (root) {
  "use strict";

  var C = {
    /** 后端地址：同源部署留空；分离部署在此处或 window.FX_API_BASE 配置 */
    base: (typeof window !== "undefined" && window.FX_API_BASE) || "",
    available: false,       // healthz 探测结果
    engineMode: "",         // 后端引擎 id（server-rules / infinisynapse / openai-compatible）
    providerLabel: "",      // 人类可读的 provider 名称
    capabilities: null,     // {ai, streaming, structuredOutput}
    _probed: false,
  };

  function join(p) { return C.base + p; }

  /** 探测后端可用性（file:// 直开 / 后端未部署时静默失败） */
  C.probe = function () {
    if (typeof fetch === "undefined" || (location.protocol === "file:" && !C.base)) {
      C._probed = true;
      return Promise.resolve(false);
    }
    return fetch(join("/healthz"), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        C.available = !!(j && j.ok);
        C.engineMode = (j && j.engine) || "";
        C.providerLabel = (j && j.label) || "";
        // 能力标记决定前端展示哪些入口：知识库只对 AI provider 有意义
        C.capabilities = (j && j.capabilities) || { ai: false, streaming: false, structuredOutput: false };
        C._probed = true;
        return C.available;
      })
      .catch(function () { C.available = false; C._probed = true; return false; });
  };

  /** 发起分析任务：POST /api/analyze → {taskId} */
  C.analyze = function (question, datasourceId) {
    return fetch(join("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, datasourceId: datasourceId }),
    }).then(function (r) {
      if (!r.ok) throw new Error("分析请求失败（HTTP " + r.status + "）");
      return r.json();
    });
  };

  /** 订阅任务进度 SSE：/api/analyze/:taskId/stream
      onEvent({stage, message, progress}) / onDone() / onError(err)；返回 close() */
  C.stream = function (taskId, onEvent, onDone, onError) {
    if (typeof EventSource === "undefined") { onError(new Error("浏览器不支持 SSE")); return function () {}; }
    var es = new EventSource(join("/api/analyze/" + encodeURIComponent(taskId) + "/stream"));
    es.onmessage = function (ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data.done) { es.close(); onDone(); return; }
        onEvent(data);
      } catch (e) { /* 忽略无法解析的心跳行 */ }
    };
    es.onerror = function () { es.close(); onError(new Error("进度流中断")); };
    return function () { es.close(); };
  };

  /** 拉取任务结果：GET /api/analyze/:taskId/result → 报告（与 FXInsightEngine.analyze 同构） */
  C.result = function (taskId) {
    return fetch(join("/api/analyze/" + encodeURIComponent(taskId) + "/result"))
      .then(function (r) {
        if (!r.ok) throw new Error("结果获取失败（HTTP " + r.status + "）");
        return r.json();
      });
  };

  /** 上传数据源（CSV 文本）：POST /api/datasource → {datasourceId} */
  C.uploadDatasource = function (csvText, name, provenance) {
    return fetch(join("/api/datasource"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 带上来源：否则合成数据经后端一趟就会被标成真实上传数据，报告里的合成标记消失
      body: JSON.stringify({ name: name || "print_jobs.csv", csv: csvText, provenance: provenance || null }),
    }).then(function (r) {
      if (!r.ok) throw new Error("数据源上传失败（HTTP " + r.status + "）");
      return r.json();
    });
  };

  /** 生成公开分享页：POST /api/share/:taskId → {publicUrl} */
  C.share = function (taskId) {
    return fetch(join("/api/share/" + encodeURIComponent(taskId)), { method: "POST" })
      .then(function (r) {
        if (!r.ok) throw new Error("分享生成失败（HTTP " + r.status + "）");
        return r.json();
      });
  };

  /** 上传知识文档（工艺术语表 / 材料参数 / 设备手册）：POST /api/knowledge */
  C.uploadKnowledge = function (name, text) {
    return fetch(join("/api/knowledge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, text: text }),
    }).then(function (r) {
      if (!r.ok) throw new Error("知识文档上传失败（HTTP " + r.status + "）");
      return r.json();
    });
  };

  /** 检索预览：让用户自己验证「问这个问题会检索到什么」，而不是盲信 */
  C.searchKnowledge = function (question) {
    return fetch(join("/api/knowledge/search"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question }),
    }).then(function (r) {
      if (!r.ok) throw new Error("检索失败（HTTP " + r.status + "）");
      return r.json();
    });
  };

  root.FXApiClient = C;
})(typeof window !== "undefined" ? window : globalThis);
