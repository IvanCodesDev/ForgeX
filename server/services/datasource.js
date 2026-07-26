/* 数据源存储（内存态）：内置 sample 常驻，用户上传带 TTL 与容量上限。
   行数据与 CSV 原文都存：规则引擎吃 rows，InfiniSynapse 通道吃 csv。
   每个数据源都带 provenance——内置 sample 是合成数据，必须一路标到报告里。 */
"use strict";
const crypto = require("crypto");
const engine = require("./local-engine");
const { HttpError } = require("../lib/http");

const MAX_SETS = 200;

class DatasourceStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map();
    // 内置数据源是**物理仿真产出**的机群数据，不是概率合成——
    // 开箱即用的那份数据，其结论必须是能被证伪的。
    const rows = engine.farmRows();
    this.map.set("sample", {
      id: "sample", name: "内置机群仿真数据", rows, csv: engine.farmCsv(),
      builtin: true, createdAt: Date.now(),
      provenance: engine.PROVENANCE.farm,
    });
  }

  create(name, csvText) {
    const out = engine.parseCsv(csvText);
    if (!out.rows.length) {
      throw new HttpError(400, "CSV 解析失败：" + (out.errors[0] || "无有效数据"));
    }
    if (this.map.size >= MAX_SETS) {
      let oldest = null;
      for (const ds of this.map.values()) {
        if (!ds.builtin && (!oldest || ds.createdAt < oldest.createdAt)) oldest = ds;
      }
      if (oldest) this.map.delete(oldest.id);
    }
    const id = "ds_" + crypto.randomBytes(8).toString("hex");
    const ds = {
      id,
      name: String(name || "print_jobs.csv").slice(0, 80),
      rows: out.rows,
      csv: engine.toCsv(out.rows),   // 重导出规范化后的 CSV，喂给上游时口径统一
      builtin: false,
      createdAt: Date.now(),
      warnings: out.errors,
      provenance: engine.PROVENANCE.upload,
    };
    this.map.set(id, ds);
    return ds;
  }

  get(id) {
    return this.map.get(String(id || "")) || null;
  }

  sweep(now) {
    for (const [id, ds] of this.map) {
      if (!ds.builtin && now - ds.createdAt > this.cfg.taskTtlMs) this.map.delete(id);
    }
  }
}

module.exports = { DatasourceStore };
