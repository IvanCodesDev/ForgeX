"use strict";

const assert = require("assert");
const { getConfig } = require("../server/config");
const { createApp } = require("../server/index");

let passed = 0;
function check(name, value) {
  assert(value, name);
  passed++;
  console.log(`  PASS  ${name}`);
}

async function main() {
  assert.throws(
    () => getConfig({ persistenceProvider: "postgres", postgresUrl: "" }),
    /POSTGRES_URL is required/
  );
  check("PostgreSQL provider 缺少连接串时 fail-fast", true);

  const app = createApp({
    persistenceProvider: "postgres",
    postgresUrl: "postgres://forgex.invalid/forgex",
    postgresPool: {
      async connect() {
        throw new Error("database offline");
      },
    },
    dataDir: "",
    forceMock: true,
    probeProvider: false,
    rateLimitMs: 0,
    logLevel: "error",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = app.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await response.json();
  check("共享持久化不可用时 healthz 返回 503", response.status === 503);
  check("healthz 如实标注 postgres 而不回退成 memory", body.persistence === "postgres");
  await app.close();

  console.log(`PostgreSQL persistence boundary PASS: ${passed}/3`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
