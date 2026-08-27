/* 用户自带 OpenAI 兼容端点（BYO-AI）的浏览器侧存取。

   三个字段只保存在本浏览器 localStorage：不上传服务器保存，
   仅随每次分析请求作为 aiBaseUrl / aiApiKey / aiModel 字段发往自有薄后端，
   由后端在该次请求内直连用户端点（服务端承诺不落日志、不回显、不持久化，
   见 server/lib/ai-endpoint.js）。优先级：请求级 > 服务端环境变量 > 本地规则引擎。 */

const STORAGE_KEY = "fx-ai-endpoint";

export interface AiEndpointSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const EMPTY: AiEndpointSettings = { baseUrl: "", apiKey: "", model: "" };

function normalize(raw: unknown): AiEndpointSettings {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const source = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { baseUrl: text(source.baseUrl), apiKey: text(source.apiKey), model: text(source.model) };
}

export function loadAiEndpoint(): AiEndpointSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    return normalize(JSON.parse(raw));
  } catch {
    // file:// 直开的隐私模式等场景 localStorage 可能不可用；按未配置处理
    return { ...EMPTY };
  }
}

export function saveAiEndpoint(next: AiEndpointSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(next)));
  } catch {
    /* 存储不可用时静默：设置只影响当前会话内存中的表单 */
  }
}

export function clearAiEndpoint(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

/** 与服务端校验同口径：Base URL 与模型名成对出现才视为已配置（Key 按端点要求可选）。 */
export function isAiEndpointConfigured(settings: AiEndpointSettings = loadAiEndpoint()): boolean {
  return Boolean(settings.baseUrl && settings.model);
}

/** 拼进分析请求体的可选字段；未配置时返回空对象（走服务端配置或本地规则）。 */
export function aiOverrideBodyFields(): { aiBaseUrl?: string; aiApiKey?: string; aiModel?: string } {
  const settings = loadAiEndpoint();
  if (!isAiEndpointConfigured(settings)) return {};
  const fields: { aiBaseUrl: string; aiApiKey?: string; aiModel: string } = {
    aiBaseUrl: settings.baseUrl,
    aiModel: settings.model,
  };
  if (settings.apiKey) fields.aiApiKey = settings.apiKey;
  return fields;
}
