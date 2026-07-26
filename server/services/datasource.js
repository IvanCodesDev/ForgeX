/* 数据源存储（内存态）：内置 sample 常驻，用户上传带 TTL 与容量上限。
   行数据与 CSV 原文都存：规则引擎吃 rows，InfiniSynapse 通道吃 csv。
   每个数据源都带 provenance——内置 sample 是合成数据，必须一路标到报告里。 */
"use strict";
const crypto = require("crypto");
const engine = require("./local-engine");
const { HttpError } = require("../lib/http");
const { FileStore } = require("../lib/store");

const MAX_SETS = 200;

class DatasourceStore {
  constructor(cfg, log) {
    this.cfg = cfg;
    // 落盘：重启后用户上传的数据源仍在（此前重启即全丢，分享出去的链接也就废了）
    this.map = new FileStore({
      dir: cfg.dataDir, name: "datasources", ttlMs: cfg.taskTtlMs, max: MAX_SETS, log: log,
    });
    // 内置数据源是**物理仿真产出**的机群数据，不是概率合成——
    // 开箱即用的那份数据，其结论必须是能被证伪的。
    const rows = engine.farmRows();
    // 内置数据集每次启动都重建（它由代码决定，不该被旧盘数据固化）
    this.map.set({
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
    this.map.set(ds);          // FileStore 自带容量淘汰
    return ds;
  }

  get(id) {
    return this.map.get(id);
  }

  sweep(now) {
    this.map.sweep(now);
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { DatasourceStore };
