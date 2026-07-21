/* 数据源路由：上传 CSV（JSON 携带文本，与前端 js/api-client.js 契约一致）。 */
"use strict";
const { HttpError, readJson, sendJson } = require("../lib/http");

function register(router, ctx) {
  const { datasources } = ctx;

  router.add("POST", /^\/api\/datasource$/, async (req, res) => {
    const body = await readJson(req, 4 * 1024 * 1024 + 64 * 1024);   // CSV 4MB + JSON 包装余量
    if (typeof body.csv !== "string" || !body.csv.trim()) throw new HttpError(400, "csv 字段不能为空");
    const ds = datasources.create(body.name, body.csv);
    sendJson(res, 201, {
      datasourceId: ds.id,
      name: ds.name,
      rows: ds.rows.length,
      warnings: ds.warnings && ds.warnings.length ? ds.warnings : undefined,
    });
  });
}

module.exports = { register };
