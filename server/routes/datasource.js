/* 数据源路由：上传 CSV（JSON 携带文本，与前端 frontend/classic/js/api-client.js 契约一致）。 */
"use strict";
const { HttpError, readJson, sendJson } = require("../lib/http");
const { resolveIdentity } = require("../lib/identity");

function register(router, ctx) {
  const { datasources } = ctx;

  router.add("POST", /^\/api\/datasource$/, async (req, res, m, rc) => {
    const identity = resolveIdentity(req, rc, ctx);
    const body = await readJson(req, 4 * 1024 * 1024 + 64 * 1024);   // CSV 4MB + JSON 包装余量
    if (typeof body.csv !== "string" || !body.csv.trim()) throw new HttpError(400, "csv 字段不能为空");
    const ds = datasources.create(body.name, body.csv, body.provenance, identity.tenantId);
    sendJson(res, 201, {
      datasourceId: ds.id,
      name: ds.name,
      rows: ds.rows.length,
      sha256: ds.contentSha256,
      deduplicated: !!ds.deduplicated,
      provenance: ds.provenance,
      warnings: ds.warnings && ds.warnings.length ? ds.warnings : undefined,
    });
  });
}

module.exports = { register };
