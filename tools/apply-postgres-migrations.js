/* 用 Node + pg 按顺序执行 backend/database/postgresql/migrations/*.sql（Stage 8.6a）。

   为什么不用 psql：CI runner 与开发机未必装 PostgreSQL 客户端，而 `pg` 已在 dependencies 里；
   同一段脚本本地有库的人也能直接跑。每个迁移文件自带 BEGIN/COMMIT 且幂等（IF NOT EXISTS /
   ON CONFLICT DO NOTHING），重复执行安全。文件顺序 = 文件名顺序 = manifest 版本顺序
   （manifest 与文件内容的一致性由 tools/validate-postgres-migrations.js 单独把关）。

   用法：POSTGRES_URL=postgres://forgex:forgex@localhost:5432/forgex node tools/apply-postgres-migrations.js [--require]
     - 未提供 POSTGRES_URL：打印 skip 并以 0 退出；带 --require（CI）时以 1 退出。 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const migrationsDir = path.join(root, "backend", "database", "postgresql", "migrations");

async function main() {
  const require_ = process.argv.includes("--require");
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
  if (!url) {
    if (require_) {
      console.error(
        "postgres migrate FAILED: 传入了 --require 但 POSTGRES_URL 未设置（CI 的 postgres service 未注入？）"
      );
      process.exitCode = 1;
      return;
    }
    console.log("postgres migrate: POSTGRES_URL 未设置，跳过（CI 用 --require 强制要求数据库）");
    return;
  }

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch (error) {
    throw new Error("pg 模块不可用（先 npm ci / npm install）：" + error.message, { cause: error });
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error("未找到迁移文件：" + migrationsDir);

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.POSTGRES_SSL === "1" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const started = Date.now();
      await client.query(sql);
      console.log(`  applied  ${file} (${Date.now() - started} ms)`);
    }
    const applied = await client.query(
      "SELECT version, name, applied_at_utc FROM forgex.schema_migrations ORDER BY version"
    );
    console.log(
      "postgres migrate OK: " +
        applied.rows.map((row) => `${row.version}=${row.name}`).join(", ") +
        ` (${applied.rowCount} versions)`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("postgres migrate FAILED:", error.message);
  process.exitCode = 1;
});
