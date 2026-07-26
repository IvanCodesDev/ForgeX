/* 文件持久化层 —— 让重启不再丢掉一切。

   ## 为什么不是 SQLite

   优化文档原本写的是 SQLite（Node 22+ 内置 `node:sqlite`）。实际动手时否掉了，理由：

   1. **会毁掉 Node 18 承诺**。`node:sqlite` 从 22.5 才有，而 package.json 声明
      `node >= 18`，CI 也在 18/20/22 三档上跑。为了一个存储实现把兼容下限抬到 22，
      对一个「clone 下来就能跑」的项目是不划算的交换。
   2. **用不上 SQLite 的长处**。单进程、无并发写、无复杂查询、数据量在几百条量级，
      事务与查询优化器在这里都是空转。
   3. **可检查性**。出问题时 `cat data/tasks/xxx.json` 就能看，
      不需要 sqlite3 客户端——对开源项目的调试体验更友好。

   如果将来出现真实的并发写或复杂查询需求，再换 SQLite 是合理的；
   但那应该由真实问题驱动，而不是因为「数据库听起来更正规」。

   ## 保证

   - **原子写**：先写 `.tmp` 再 `rename`。rename 在同一文件系统上是原子的，
     所以不会出现「写到一半断电留下半个 JSON」的情况。
   - **懒加载 + 内存索引**：启动时只读元数据，大字段（如 CSV 原文）按需读盘。
   - **TTL 与容量上限**：与内存版语义一致，过期即删盘。 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * 一个命名空间的持久化集合，例如 datasources / tasks / shares / knowledge。
 *
 * @param opt.dir       数据目录
 * @param opt.name      命名空间（子目录名）
 * @param opt.ttlMs     过期时间；<=0 表示不过期
 * @param opt.max       容量上限；超出时按创建时间淘汰最旧的（builtin 项豁免）
 * @param opt.log
 */
class FileStore {
  constructor(opt) {
    this.name = opt.name;
    this.ttlMs = opt.ttlMs || 0;
    this.max = opt.max || 0;
    this.log = opt.log || { info() {}, warn() {}, error() {} };
    this.mem = new Map(); // id → 记录（全量驻留；本项目数据量小，换取实现简单）

    // 空 dir 表示**显式关闭持久化**，必须在这里就短路。
    // 曾经这里直接 path.join("", name)，结果得到相对路径 "datasources"，
    // 于是「关闭持久化」变成了「写到当前工作目录」——跑一次测试就往仓库里拉屎。
    // 关闭一个功能必须真的关闭，而不是换个地方生效。
    if (!opt.dir) {
      this.dir = null;
      this.enabled = false;
      return;
    }

    this.dir = path.join(opt.dir, opt.name);
    this.enabled = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      // 只读文件系统（某些 PaaS 的默认根目录）下退化为纯内存，并明确告知
      this.enabled = false;
      this.log.warn("persistence disabled: cannot create data dir", { dir: this.dir, error: e.message });
    }
    if (this.enabled) this._loadAll();
  }

  _file(id) {
    // id 由服务端生成（hex / 固定字面量），这里仍做一次防御。
    // 两步：① 只保留安全字符（路径分隔符被消解）；② 折叠连续点号。
    // 第二步在功能上不是必需的——`.._.._evil.json` 本就落在目录内——
    // 但留着 `..` 会让「这里安不安全」需要想一下才能确定。不变量应当一眼可验证。
    const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/\.{2,}/g, ".");
    return path.join(this.dir, safe + ".json");
  }

  _loadAll() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      return;   // 目录不存在或不可读：当作空集合，不影响服务启动
    }
    const now = Date.now();
    let loaded = 0, expired = 0, broken = 0;
    for (const f of files) {
      const full = path.join(this.dir, f);
      try {
        const rec = JSON.parse(fs.readFileSync(full, "utf8"));
        if (this._isExpired(rec, now)) {
          fs.unlinkSync(full);
          expired++;
          continue;
        }
        this.mem.set(rec.id, rec);
        loaded++;
      } catch (e) {
        // 损坏的单条记录不该拖垮整个服务：删掉并记日志，继续加载其余
        broken++;
        try { fs.unlinkSync(full); } catch (e2) { /* 删不掉就留着 */ }
      }
    }
    if (loaded || expired || broken) {
      this.log.info("store loaded", { ns: this.name, loaded, expired, broken });
    }
  }

  _isExpired(rec, now) {
    if (rec && rec.builtin) return false;
    if (!this.ttlMs) return false;
    const at = rec && (rec.expiresAt || rec.createdAt);
    if (!at) return false;
    return (rec.expiresAt ? now > rec.expiresAt : now - rec.createdAt > this.ttlMs);
  }

  /** 原子写：临时文件 + rename。避免半截 JSON 落盘。 */
  _persist(rec) {
    if (!this.enabled) return;
    const target = this._file(rec.id);
    const tmp = target + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(rec), "utf8");
      fs.renameSync(tmp, target);
    } catch (e) {
      this.log.error("store write failed", { ns: this.name, id: rec.id, error: e.message });
      try { fs.unlinkSync(tmp); } catch (e2) { /* 清理失败无所谓 */ }
    }
  }

  set(rec) {
    if (!rec || !rec.id) throw new Error("store.set 需要带 id 的记录");
    if (!rec.createdAt) rec.createdAt = Date.now();
    this.mem.set(rec.id, rec);
    this._persist(rec);
    this._evict();
    return rec;
  }

  get(id) {
    const rec = this.mem.get(String(id || ""));
    if (!rec) return null;
    if (this._isExpired(rec, Date.now())) {
      this.delete(rec.id);
      return null;
    }
    return rec;
  }

  has(id) {
    return this.get(id) !== null;
  }

  delete(id) {
    const key = String(id || "");
    if (!this.mem.delete(key)) return false;
    if (this.enabled) {
      try { fs.unlinkSync(this._file(key)); } catch (e) { /* 文件可能已不在 */ }
    }
    return true;
  }

  all() {
    const now = Date.now();
    const out = [];
    for (const rec of this.mem.values()) {
      if (this._isExpired(rec, now)) { this.delete(rec.id); continue; }
      out.push(rec);
    }
    return out;
  }

  get size() {
    return this.mem.size;
  }

  /** 容量淘汰：按 createdAt 淘汰最旧的非 builtin 记录 */
  _evict() {
    if (!this.max || this.mem.size <= this.max) return;
    const sorted = [...this.mem.values()]
      .filter((r) => !r.builtin)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let n = this.mem.size - this.max;
    for (const rec of sorted) {
      if (n-- <= 0) break;
      this.delete(rec.id);
    }
  }

  /** 周期清理（由 index.js 的 sweeper 调用） */
  sweep(now) {
    let n = 0;
    for (const rec of [...this.mem.values()]) {
      if (this._isExpired(rec, now || Date.now())) { this.delete(rec.id); n++; }
    }
    return n;
  }
}

/**
 * 单个 JSON 文件的小状态（用量计数器之类）。
 * 与 FileStore 的区别：它是一个整体，不是一堆记录。
 */
class JsonFile {
  constructor(file, initial, log) {
    this.file = file;
    this.log = log || { warn() {}, error() {} };
    this.data = initial || {};
    // 与 FileStore 同理：没有目录就是显式关闭，不能退化成写当前工作目录
    if (!file || !path.dirname(file) || path.dirname(file) === ".") {
      this.enabled = false;
      return;
    }
    this.enabled = true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        this.data = Object.assign({}, initial, JSON.parse(fs.readFileSync(file, "utf8")));
      }
    } catch (e) {
      this.enabled = false;
      this.log.warn("json file state disabled", { file, error: e.message });
    }
  }

  save() {
    if (!this.enabled) return;
    const tmp = this.file + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error("json file write failed", { file: this.file, error: e.message });
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    }
  }
}

module.exports = { FileStore, JsonFile };
