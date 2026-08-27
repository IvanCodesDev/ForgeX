/* 分享路由：为已完成任务生成公开分享页（服务端渲染，零脚本零依赖）。
   POST /api/share/:taskId → {publicUrl}；GET /share/:token → HTML。

   Stage 8.1（V2.0 手册 §4.2）：SHARES_AUTHORITY=csharp 时本文件退化为
   ForgeX.Api 的迁移代理——任务归属校验仍在 Node（任务尚未迁移），
   分享的存储、撤销与页面渲染改由 C#/PostgreSQL 权威承担；
   SHARES_AUTHORITY=node（默认）保持既有行为，作为回滚开关。 */
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { HttpError, readJson, sendJson, escapeHtml } = require("../lib/http");
const { resolveIdentity, requireOwner } = require("../lib/identity");

/* 与 gcode-authority.js 一致的匿名化上下文：C# 只见哈希后的 tenant/owner。 */
function opaqueContextId(prefix, value) {
  return prefix + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/* 小体量 JSON 调用（分享创建/撤销都在 KB 级），不做流式。 */
function authorityRequest(cfg, identity, method, pathname, payload) {
  const target = new URL(pathname, cfg.gcodeAuthorityUrl);
  const transport = target.protocol === "https:" ? https : http;
  const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
  const headers = { accept: "application/json" };
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(body.length);
  }
  if (cfg.gcodeAuthorityInternalSecret && identity) {
    headers["x-forgex-internal-token"] = cfg.gcodeAuthorityInternalSecret;
    headers["x-forgex-tenant-id"] = opaqueContextId("tn_", identity.tenantId);
    headers["x-forgex-owner-id"] = opaqueContextId("ow_", identity.caller);
  }
  return new Promise((resolve, reject) => {
    const upstream = transport.request(target, { method, headers, timeout: cfg.sharesAuthorityTimeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode || 502,
        contentType: res.headers["content-type"] || "application/json",
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("shares authority timeout")));
    upstream.on("error", reject);
    if (body) upstream.write(body);
    upstream.end();
  });
}

function parseAuthorityJson(response) {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return null;
  }
}

function register(router, ctx) {
  const { tasks, shares, cfg, log } = ctx;
  const csharp = cfg.sharesAuthority === "csharp";

  router.add("POST", /^\/api\/share\/([A-Za-z0-9_]+)$/, async (req, res, m, rc) => {
    const identity = await resolveIdentity(req, rc, ctx);
    if (typeof tasks.ready === "function") await tasks.ready(identity.tenantId);
    const task = tasks.get(m[1]);
    if (!task) throw new HttpError(404, "任务不存在或已过期");
    requireOwner({ owner: task.caller, ownerId: task.ownerId }, identity, ctx, "analysis-task", task.id);
    if (task.status !== "done") throw new HttpError(409, "任务尚未完成，无法分享");

    let out;
    if (csharp) {
      let response;
      try {
        response = await authorityRequest(cfg, identity, "POST", "/api/v1/shares", {
          report: task.report,
          question: task.question,
          engine: task.engine,
          upstreamTaskId: task.upstreamTaskId,
        });
      } catch (error) {
        log.warn("shares authority create failed", { reqId: rc.reqId, error: error.message });
        throw new HttpError(502, "分享服务暂不可用，请稍后再试");
      }
      const parsed = parseAuthorityJson(response);
      if (response.status !== 201 || !parsed || !parsed.token) {
        log.warn("shares authority create rejected", { reqId: rc.reqId, status: response.status });
        throw new HttpError(502, "分享服务暂不可用，请稍后再试");
      }
      out = { token: parsed.token, revokeKey: parsed.revokeKey, expiresAt: parsed.expiresAt };
    } else {
      out = await shares.create(task);
    }

    const base = cfg.publicBase || rc.origin || "";
    if (!base) {
      // 没有可用的公网前缀时给相对路径，并明确告知——
      // 悄悄拼出一个打不开的链接比报错更糟
      log.warn("share created without PUBLIC_BASE or Origin", { token: out.token });
    }
    sendJson(res, 201, {
      publicUrl: base + "/share/" + out.token,
      token: out.token,
      // 撤销密钥只在创建时返回这一次，服务端只存哈希
      revokeKey: out.revokeKey,
      expiresAt: out.expiresAt,
      note: base
        ? undefined
        : "未配置 PUBLIC_BASE 且请求无 Origin，返回的是相对路径；部署时请设置 PUBLIC_BASE。",
    });
  });

  /* 撤销分享。分享出去的东西必须能收回来，这是分享功能的基本义务。
     csharp 模式下归属校验由 RLS 承担：他人租户的 token 一律 not_found，
     不再像 node 模式那样用 403 暴露「存在但不属于你」。 */
  router.add("POST", /^\/api\/share\/([a-f0-9]+)\/revoke$/, async (req, res, m, rc) => {
    const identity = await resolveIdentity(req, rc, ctx);
    const body = await readJson(req, 4 * 1024);
    if (csharp) {
      let response;
      try {
        response = await authorityRequest(cfg, identity, "POST", "/api/v1/shares/" + m[1] + "/revoke", {
          revokeKey: body.revokeKey,
        });
      } catch (error) {
        log.warn("shares authority revoke failed", { reqId: rc.reqId, error: error.message });
        throw new HttpError(502, "分享服务暂不可用，请稍后再试");
      }
      if (response.status === 200) {
        sendJson(res, 200, { revoked: true });
        return;
      }
      if (response.status === 404) throw new HttpError(404, "分享不存在或已过期");
      if (response.status === 403) throw new HttpError(403, "撤销密钥不正确");
      log.warn("shares authority revoke rejected", { reqId: rc.reqId, status: response.status });
      throw new HttpError(502, "分享服务暂不可用，请稍后再试");
    }

    const share = await shares.get(m[1]);
    if (!share) throw new HttpError(404, "分享不存在或已过期");
    requireOwner(share, identity, ctx, "share", m[1]);
    const out = await shares.revoke(m[1], body.revokeKey, identity.tenantId);
    if (!out.ok) {
      throw new HttpError(out.reason === "not_found" ? 404 : 403,
        out.reason === "not_found" ? "分享不存在或已过期" : "撤销密钥不正确");
    }
    sendJson(res, 200, { revoked: true });
  });

  router.add("GET", /^\/share\/([a-f0-9]+)$/, async (req, res, m, rc) => {
    if (csharp) {
      let response;
      try {
        // 公开页：不注入任何身份上下文，C# 侧以 share_public 通道读取。
        response = await authorityRequest(cfg, null, "GET", "/share/" + m[1], null);
      } catch (error) {
        log.warn("shares authority page failed", { reqId: rc && rc.reqId, error: error.message });
        throw new HttpError(502, "分享服务暂不可用，请稍后再试");
      }
      if (response.status === 404) throw new HttpError(404, "分享页不存在、已过期或已被撤销");
      if (response.status !== 200) {
        throw new HttpError(502, "分享服务暂不可用，请稍后再试");
      }
      res.writeHead(200, { "Content-Type": response.contentType, "Cache-Control": "no-cache" });
      res.end(response.body);
      return;
    }

    const s = await shares.get(m[1]);
    if (!s) throw new HttpError(404, "分享页不存在、已过期或已被撤销");
    const html = renderShareHtml(s);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(html);
  });
}

/* ── 服务端渲染（全部文本经 escapeHtml，杜绝注入） ── */

function chartHtml(chart) {
  if (!chart || !chart.items || !chart.items.length) return "";
  const isRate = chart.kind === "bar-rate";
  let maxV = 0;
  for (const it of chart.items) maxV = Math.max(maxV, it.value);
  if (maxV <= 0) maxV = 1;
  const rows = chart.items.map((it) => {
    const frac = isRate ? Math.min(1, it.value) : it.value / maxV;
    const valText = isRate ? (it.value * 100).toFixed(1) + "%" : String(Math.round(it.value * 100) / 100);
    const hot = isRate ? it.value >= 0.15 : false;
    return '<div class="row"><span class="lab">' + escapeHtml(it.label) + '</span>' +
      '<span class="track"><i style="width:' + (frac * 100).toFixed(1) + '%" class="' + (hot ? "hot" : "") + '"></i></span>' +
      '<span class="val">' + escapeHtml(valText) + "</span></div>";
  }).join("");
  return '<div class="chart"><div class="ch-title">' + escapeHtml(chart.title || "") + "</div>" + rows + "</div>";
}

function renderShareHtml(s) {
  const r = s.report || {};
  const sections = (r.sections || []).map((sec) =>
    '<div class="sec"><h3>' + escapeHtml(sec.h) + "</h3>" +
    (sec.lines || []).map((l) => "<p>" + escapeHtml(l) + "</p>").join("") + "</div>").join("");
  const engineLabel = r.engine === "infinisynapse" ? "InfiniSynapse 云端 AI"
    : r.engine === "openai-compatible" ? "OpenAI 兼容 AI"
    : "规则引擎（统计，无 AI）";
  const upstream = s.upstreamTaskId
    ? '<p class="meta">InfiniSynapse taskId：<code>' + escapeHtml(s.upstreamTaskId) + "</code></p>" : "";
  return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">" +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    "<title>" + escapeHtml(r.title || "分析报告") + " — FORGE·X 智造洞察</title><style>" +
    "body{margin:0;background:#e8ebf0;font:15px/1.7 'Segoe UI','Microsoft YaHei UI',sans-serif;color:#1d222b}" +
    ".wrap{max-width:720px;margin:32px auto;padding:0 16px}" +
    ".card{background:rgba(255,255,255,.82);border:1px solid rgba(29,34,43,.08);border-radius:14px;padding:28px;box-shadow:0 8px 32px rgba(29,34,43,.08)}" +
    ".brand{font-weight:700;letter-spacing:.12em;color:#f0561a;font-size:12px;margin-bottom:6px}" +
    "h1{font-size:22px;margin:0 0 4px}h3{font-size:14px;margin:18px 0 6px;color:#3a4150}" +
    ".verdict{background:rgba(240,86,26,.08);border-left:3px solid #f0561a;padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0}" +
    ".meta{color:#5a6270;font-size:12px}p{margin:4px 0}code{background:rgba(29,34,43,.06);padding:1px 6px;border-radius:4px}" +
    ".chart{margin:16px 0}.ch-title{font-size:12px;color:#5a6270;margin-bottom:8px}" +
    ".row{display:flex;align-items:center;gap:10px;margin:6px 0}.lab{width:96px;font-size:12px;text-align:right;flex:none}" +
    ".track{flex:1;height:12px;background:rgba(29,34,43,.08);border-radius:6px;overflow:hidden}" +
    ".track i{display:block;height:100%;background:rgba(79,131,224,.65);border-radius:6px}" +
    ".track i.hot{background:#f0561a}.val{width:64px;font-size:12px;color:#5a6270;flex:none}" +
    ".meta.warn{color:#8a5214;background:rgba(217,131,36,.12);padding:6px 10px;border-radius:6px}" +
    ".foot{text-align:center;color:#8a93a2;font-size:12px;margin:18px 0}" +
    "</style></head><body><div class=\"wrap\"><div class=\"card\">" +
    '<div class="brand">FORGE·X 智造洞察</div>' +
    "<h1>" + escapeHtml(r.title || "分析报告") + "</h1>" +
    '<p class="meta">提问：' + escapeHtml(s.question || "—") + " · 引擎：" + engineLabel +
    " · 样本 " + escapeHtml(String(r.rowCount || 0)) + " 行</p>" + upstream +
    '<div class="verdict">' + escapeHtml(r.verdict || "") + "</div>" +
    (r.confidence ? '<p class="meta">可信度：' + escapeHtml(r.confidence) + "</p>" : "") +
    (r.provenance && r.provenance.synthetic
      ? '<p class="meta warn">⚠ 本报告基于' + escapeHtml(r.provenance.badge || "合成") +
        "数据，非真实产线数据。</p>" : "") +
    chartHtml(r.chart) + sections +
    "</div><div class=\"foot\">由 FORGE·X 智造洞察生成 · 工业 3D 打印仿真 × 数据分析</div></div></body></html>";
}

module.exports = { register };
