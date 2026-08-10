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
      builtin: true, owner: "system:public", createdAt: Date.now(),
      contentSha256: crypto.createHash("sha256").update(engine.farmCsv()).digest("hex"),
      provenance: engine.PROVENANCE.farm,
    });
  }

  /**
   * 客户端声明的数据来源。
   *
   * 为什么要接受它：前端把「机群仿真」数据集上传给后端分析时，
   * 后端只看到一份 CSV，无从判断它是仿真产物还是真实产线数据——
   * 一律标成 user-upload 的结果是**合成数据经过后端一趟就变成了「真实数据」**，
   * 报告里的合成标记随之消失。这正是 provenance 契约要防的事。
   *
   * 安全方向：客户端只能让标记**更谨慎**，不能更宽松。
   * 声明 synthetic:true 一律采信（多标一次无害）；
   * 声明 synthetic:false 不采信——后端无法验证，默认按上传数据处理即可。
   */
  static sanitizeProvenance(claim) {
    const base = engine.PROVENANCE.upload;
    if (!claim || typeof claim !== "object") return base;
    const known = engine.PROVENANCE[claim.source] || null;
    if (known && known.synthetic) return known;              // 已知的合成来源，原样采用
    if (claim.synthetic === true) {
      // 未知来源但自称合成：保守起见照样标出来，只是措辞泛化
      return {
        source: "client-declared-synthetic",
        synthetic: true,
        badge: String(claim.badge || "合成").slice(0, 8),
        note: "客户端声明为合成/仿真数据，非真实产线数据。",
        generator: null,
      };
    }
    return base;
  }

  create(name, csvText, provenanceClaim, owner) {
    const out = engine.parseCsv(csvText);
    if (!out.rows.length) {
      throw new HttpError(400, "CSV 解析失败：" + (out.errors[0] || "无有效数据"));
    }
    const csv = engine.toCsv(out.rows);   // 规范化后再摘要，换行/空白差异不制造重复数据源
    const contentSha256 = crypto.createHash("sha256").update(csv).digest("hex");
    const ownerKey = String(owner || "legacy:unowned");
    const provenance = DatasourceStore.sanitizeProvenance(provenanceClaim);
    const cacheKey = crypto.createHash("sha256")
      .update(contentSha256).update("\0").update(JSON.stringify(provenance)).digest("hex");
    const id = "ds_" + crypto.createHash("sha256")
      .update(ownerKey).update("\0").update(cacheKey).digest("hex").slice(0, 24);
    const existing = this.map.get(id);
    if (existing && existing.owner === ownerKey && existing.cacheKey === cacheKey) {
      return Object.assign({}, existing, { deduplicated: true });
    }
    const ds = {
      id,
      name: String(name || "print_jobs.csv").slice(0, 80),
      rows: out.rows,
      csv,
      contentSha256,
      cacheKey,
      owner: ownerKey,
      builtin: false,
      createdAt: Date.now(),
      warnings: out.errors,
      provenance,
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
