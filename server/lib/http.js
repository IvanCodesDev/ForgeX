/* HTTP 基础件：限长请求体读取、JSON 应答、SSE、静态文件（allowlist + 防穿越）。 */
"use strict";
const fs = require("fs");
const path = require("path");

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/** 读取请求体（限长）。超限不 destroy 连接——排空剩余数据后由上层回 413，客户端才能收到响应。 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;                       // 已超限：静默排空
      size += c.length;
      if (size > maxBytes) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => over ? reject(new HttpError(413, "请求体过大")) : resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(e));
  });
}

async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) throw new HttpError(400, "请求体为空");
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",   // Nginx 反代下禁用缓冲，进度事件才是实时的
  });
  res.write(": connected\n\n");
}

function sseSend(res, obj) {
  try {
    res.write("data: " + JSON.stringify(obj) + "\n\n");
    return true;
  } catch (e) {
    return false;
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".map": "application/json",
};

/** 静态托管默认拒绝（deny-by-default）：只放行前端资产，server/ 与 .env 永远不可达 */
const STATIC_ALLOW = [
  /^\/index\.html$/,
  /^\/README\.md$/,
  /^\/css\//,
  /^\/js\//,
  /^\/doc\/samples\//,
  /^\/profiles\/(?:example-bundle|profile-bundle\.schema)\.json$/,
  /^\/calibration\/(?:example-bundle|calibration-bundle\.schema)\.json$/,
  /^\/validation\/(?:fixture-manifest|time-calibration-report)\.json$/,
];

function serveStatic(req, res, root) {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch (e) {
    return sendJson(res, 400, { error: "路径不合法" });
  }
  p = path.posix.normalize(p);
  if (p === "/") p = "/index.html";
  // 归一化后仍含 ..、反斜杠或控制符的一律拒绝（防 ../ 与 %5C 编码穿越）
  if (!p.startsWith("/") || p.includes("..") || p.includes("\\") || p.includes("\0")) {
    return sendJson(res, 404, { error: "资源不存在" });
  }
  if (!STATIC_ALLOW.some((re) => re.test(p))) return sendJson(res, 404, { error: "资源不存在" });
  const abs = path.normalize(path.join(root, p));
  if (!abs.startsWith(root + path.sep)) return sendJson(res, 404, { error: "资源不存在" });

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: "资源不存在" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

module.exports = { HttpError, readBody, readJson, sendJson, sseStart, sseSend, escapeHtml, serveStatic, clientIp };
