/* FORGE·X 智造洞察 — 后端 API 客户端（对接自有薄后端 → InfiniSynapse Server API）
   设计见 doc/开发文档.md §8.3。当前后端未部署时 available=false，
   insight 面板自动落到本地演示引擎（FXInsightEngine），后端上线后零改动切换。 */
(function (root) {
  "use strict";

  var C = {
    /** 后端地址：同源部署留空；分离部署在此处或 window.FX_API_BASE 配置 */
    base: (typeof window !== "undefined" && window.FX_API_BASE) || "",
    available: false,       // healthz 探测结果
    engineMode: "",         // 后端引擎："mock"（演示）| "infinisynapse"（真实云端）
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
  C.uploadDatasource = function (csvText, name) {
    return fetch(join("/api/datasource"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || "print_jobs.csv", csv: csvText }),
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

  root.FXApiClient = C;
})(typeof window !== "undefined" ? window : globalThis);
