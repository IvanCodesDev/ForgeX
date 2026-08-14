"use strict";

/* The default file/memory provider must start without node_modules.
   PostgreSQL is optional and must not load while server/index.js is imported. */
const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
let pgLoaded = false;
Module._load = function guardedLoad(request) {
  if (request === "pg") {
    pgLoaded = true;
    throw new Error("optional PostgreSQL dependency loaded by the default provider");
  }
  return originalLoad.apply(this, arguments);
};

async function main() {
  try {
    const { createApp } = require("../server/index");
    const app = createApp({ forceMock: true, probeProvider: false, rateLimitMs: 0, logLevel: "error" });
    await app.close();
    assert.strictEqual(pgLoaded, false, "default provider must not load pg");
    console.log("Zero-runtime provider PASS: default file provider does not load pg");
  } finally {
    Module._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
