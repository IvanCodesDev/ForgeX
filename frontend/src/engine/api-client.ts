/* FORGE·X 智造洞察 — 后端 API 客户端（对接自有薄后端：规则引擎 / 自带 OpenAI 兼容端点）。
   自 js/api-client.js 机械迁移：行为逐行保留，仅换模块壳并加类型。
   当前后端未部署时 available=false，
   insight 面板自动落到浏览器内的本地规则引擎（FXInsightEngine），后端上线后零改动切换。 */
import { aiOverrideBodyFields } from "./ai-endpoint";

export interface ApiCapabilities {
  ai: boolean;
  streaming: boolean;
  structuredOutput: boolean;
}

export interface CalibrationSyncState {
  status: "idle" | "syncing" | "ready" | "offline";
  count: number;
  error: string;
}

export interface AnalyzeTask {
  taskId: string;
}

export interface StreamEvent {
  stage?: string;
  message?: string;
  progress?: number;
  done?: boolean;
}

interface ApiClientState {
  base: string;
  available: boolean;
  engineMode: string;
  providerLabel: string;
  capabilities: ApiCapabilities | null;
  calibrationSync: CalibrationSyncState;
  _probed: boolean;
  _probePromise: Promise<boolean> | null;
}

/** 后端地址：同源部署留空；分离部署在 window.FX_API_BASE 配置 */
const state: ApiClientState = {
  base: (typeof window !== "undefined" && (window as { FX_API_BASE?: string }).FX_API_BASE) || "",
  available: false, // healthz 探测结果
  engineMode: "", // 后端引擎 id（server-rules / openai-compatible）
  providerLabel: "", // 人类可读的 provider 名称
  capabilities: null,
  calibrationSync: { status: "idle", count: 0, error: "" },
  _probed: false,
  _probePromise: null,
};

function join(p: string): string {
  return state.base + p;
}

/** 探测后端可用性（file:// 直开 / 后端未部署时静默失败） */
export function probe(): Promise<boolean> {
  if (state._probePromise) return state._probePromise;
  if (typeof fetch === "undefined" || (location.protocol === "file:" && !state.base)) {
    state._probed = true;
    return Promise.resolve(false);
  }
  state._probePromise = fetch(join("/healthz"), { method: "GET" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { ok?: boolean; engine?: string; label?: string; capabilities?: ApiCapabilities } | null) => {
      state.available = !!(j && j.ok);
      state.engineMode = (j && j.engine) || "";
      state.providerLabel = (j && j.label) || "";
      // 能力标记决定前端展示哪些入口：知识库只对 AI provider 有意义
      state.capabilities = (j && j.capabilities) || { ai: false, streaming: false, structuredOutput: false };
      state._probed = true;
      return state.available;
    })
    .catch(() => {
      state.available = false;
      state._probed = true;
      return false;
    })
    .then((available) => {
      state._probePromise = null;
      return available;
    });
  return state._probePromise;
}

/** 拉取服务端已审核的 active 校准包；file:// 或服务不可用时由调用方保留本地注册表。 */
export function pullCalibrations(): Promise<unknown[]> {
  state.calibrationSync = { status: "syncing", count: 0, error: "" };
  return fetch(join("/api/calibrations"), { method: "GET" })
    .then((r) => {
      if (!r.ok) throw new Error("校准目录同步失败（HTTP " + r.status + "）");
      return r.json() as Promise<{ items?: Array<{ bundle: unknown }> }>;
    })
    .then((catalog) => {
      const items = catalog && Array.isArray(catalog.items) ? catalog.items : [];
      state.calibrationSync = { status: "ready", count: items.length, error: "" };
      return items.map((item) => item.bundle);
    })
    .catch((err: unknown) => {
      state.calibrationSync = {
        status: "offline",
        count: 0,
        error: String((err as Error)?.message || err),
      };
      throw err;
    });
}

/** 发起分析任务：POST /api/analyze → {taskId}
    若用户在「AI 设置」里配置了自带端点，则随请求携带 aiBaseUrl / aiApiKey / aiModel，
    该次分析由后端直连用户端点做叙述（数字仍由统计核算出）。 */
export function analyze(question: string, datasourceId: string): Promise<AnalyzeTask> {
  return fetch(join("/api/analyze"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, datasourceId, ...aiOverrideBodyFields() }),
  }).then((r) => {
    if (!r.ok) throw new Error("分析请求失败（HTTP " + r.status + "）");
    return r.json() as Promise<AnalyzeTask>;
  });
}

/** 订阅任务进度 SSE：/api/analyze/:taskId/stream
    onEvent({stage, message, progress}) / onDone() / onError(err)；返回 close() */
export function stream(
  taskId: string,
  onEvent: (ev: StreamEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void
): () => void {
  if (typeof EventSource === "undefined") {
    onError(new Error("浏览器不支持 SSE"));
    return function () {};
  }
  const es = new EventSource(join("/api/analyze/" + encodeURIComponent(taskId) + "/stream"));
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string) as StreamEvent;
      if (data.done) {
        es.close();
        onDone();
        return;
      }
      onEvent(data);
    } catch {
      /* 忽略无法解析的心跳行 */
    }
  };
  es.onerror = () => {
    es.close();
    onError(new Error("进度流中断"));
  };
  return () => {
    es.close();
  };
}

/** 拉取任务结果：GET /api/analyze/:taskId/result → 报告（与 FXInsightEngine.analyze 同构） */
export function result(taskId: string): Promise<unknown> {
  return fetch(join("/api/analyze/" + encodeURIComponent(taskId) + "/result")).then((r) => {
    if (!r.ok) throw new Error("结果获取失败（HTTP " + r.status + "）");
    return r.json();
  });
}

/** 上传数据源（CSV 文本）：POST /api/datasource → {datasourceId} */
export function uploadDatasource(
  csvText: string,
  name?: string,
  provenance?: string | null
): Promise<{ datasourceId: string }> {
  return fetch(join("/api/datasource"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 带上来源：否则合成数据经后端一趟就会被标成真实上传数据，报告里的合成标记消失
    body: JSON.stringify({ name: name || "print_jobs.csv", csv: csvText, provenance: provenance || null }),
  }).then((r) => {
    if (!r.ok) throw new Error("数据源上传失败（HTTP " + r.status + "）");
    return r.json() as Promise<{ datasourceId: string }>;
  });
}

/** 生成公开分享页：POST /api/share/:taskId → {publicUrl} */
export function share(taskId: string): Promise<{ publicUrl: string }> {
  return fetch(join("/api/share/" + encodeURIComponent(taskId)), { method: "POST" }).then((r) => {
    if (!r.ok) throw new Error("分享生成失败（HTTP " + r.status + "）");
    return r.json() as Promise<{ publicUrl: string }>;
  });
}

/** 上传知识文档（工艺术语表 / 材料参数 / 设备手册）：POST /api/knowledge */
export function uploadKnowledge(name: string, text: string): Promise<unknown> {
  return fetch(join("/api/knowledge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text }),
  }).then((r) => {
    if (!r.ok) throw new Error("知识文档上传失败（HTTP " + r.status + "）");
    return r.json();
  });
}

/** 检索预览：让用户自己验证「问这个问题会检索到什么」，而不是盲信 */
export function searchKnowledge(question: string): Promise<unknown> {
  return fetch(join("/api/knowledge/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  }).then((r) => {
    if (!r.ok) throw new Error("检索失败（HTTP " + r.status + "）");
    return r.json();
  });
}

/* 与 js/api-client.js 相同的可变单例视图：状态字段直接读写这里。 */
export const url = join;
export { state as clientState };

/** 兼容 FXApiClient 形状的聚合对象（含可变状态字段的 getter/setter 透传）。 */
export const FXApiClientCompat = {
  get base() {
    return state.base;
  },
  set base(v: string) {
    state.base = v;
  },
  get available() {
    return state.available;
  },
  set available(v: boolean) {
    state.available = v;
  },
  get engineMode() {
    return state.engineMode;
  },
  set engineMode(v: string) {
    state.engineMode = v;
  },
  get providerLabel() {
    return state.providerLabel;
  },
  set providerLabel(v: string) {
    state.providerLabel = v;
  },
  get capabilities() {
    return state.capabilities;
  },
  set capabilities(v: ApiCapabilities | null) {
    state.capabilities = v;
  },
  get calibrationSync() {
    return state.calibrationSync;
  },
  set calibrationSync(v: CalibrationSyncState) {
    state.calibrationSync = v;
  },
  url: join,
  probe,
  pullCalibrations,
  analyze,
  stream,
  result,
  uploadDatasource,
  share,
  uploadKnowledge,
  searchKnowledge,
};
