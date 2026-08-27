/* 用户自带 OpenAI 兼容端点（请求级覆盖）的解析与校验。

   分析请求体可选携带 aiBaseUrl / aiApiKey / aiModel 三个字段：
   校验通过后，该次请求用 openaiProvider 直连用户端点，优先级为
   请求级 > 环境变量（OPENAI_*）> 本地规则引擎回退。

   安全约定（与 doc 安全基线一致）：
   - aiBaseUrl 仅接受 http(s)，禁止内嵌凭据 / 查询参数 / 片段——
     查询与片段会破坏 "/chat/completions" 的路径拼接，凭据则可能进日志；
   - aiApiKey 只活在本次请求的 provider 闭包里：不落日志、不回显、不持久化，
     校验错误信息也只描述规则，绝不引用字段内容。 */
"use strict";

const { HttpError } = require("./http");

const MAX_BASE_URL_CHARS = 1024;
const MAX_API_KEY_CHARS = 512;
const MAX_MODEL_CHARS = 128;

function fieldAsString(value, name) {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(400, name + " 必须是字符串");
  return value.trim();
}

/**
 * 从请求体解析用户自带端点。
 * @returns {null | { baseUrl: string, apiKey: string, model: string }}
 *   三个字段全部缺省/空白时返回 null（走进程级配置）；非法时抛 400。
 */
function parseAiOverride(body) {
  const source = body || {};
  const baseUrl = fieldAsString(source.aiBaseUrl, "aiBaseUrl");
  const apiKey = fieldAsString(source.aiApiKey, "aiApiKey");
  const model = fieldAsString(source.aiModel, "aiModel");
  if (!baseUrl && !apiKey && !model) return null;

  if (!baseUrl || !model) {
    throw new HttpError(400, "自带 AI 端点需要同时提供 aiBaseUrl 与 aiModel（aiApiKey 按端点要求可选）");
  }
  if (baseUrl.length > MAX_BASE_URL_CHARS) throw new HttpError(400, "aiBaseUrl 超过 " + MAX_BASE_URL_CHARS + " 字符上限");
  if (apiKey.length > MAX_API_KEY_CHARS) throw new HttpError(400, "aiApiKey 超过 " + MAX_API_KEY_CHARS + " 字符上限");
  if (model.length > MAX_MODEL_CHARS) throw new HttpError(400, "aiModel 超过 " + MAX_MODEL_CHARS + " 字符上限");

  let target;
  try {
    target = new URL(baseUrl);
  } catch (e) {
    void e; // URL 解析失败的细节不外传，避免把用户输入拼进错误信息
    throw new HttpError(400, "aiBaseUrl 必须是合法的 http(s) URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new HttpError(400, "aiBaseUrl 只允许 http(s)");
  }
  if (target.username || target.password) throw new HttpError(400, "aiBaseUrl 禁止内嵌凭据");
  if (target.hash) throw new HttpError(400, "aiBaseUrl 禁止携带片段");
  if (target.search) throw new HttpError(400, "aiBaseUrl 禁止携带查询参数");

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

module.exports = { parseAiOverride, MAX_BASE_URL_CHARS, MAX_API_KEY_CHARS, MAX_MODEL_CHARS };
