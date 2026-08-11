"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/index");
const { ANALYTICS_AUTHORITY_HARD_MAX_BYTES } = require("../server/config");

const tempRoots = [];
const apps = [];

function tempDataDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-analytics-authority-"));
  tempRoots.push(directory);
  return directory;
}

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function listenApp(overrides) {
  const app = createApp({
    logLevel: "error",
    forceMock: true,
    rateLimitMs: 0,
    dataDir: tempDataDir(),
    ...overrides,
  });
  apps.push(app);
  return `http://127.0.0.1:${await listenServer(app.server)}`;
}

async function request(base, body, headers = {}) {
  const response = await fetch(base + "/api/v1/analytics/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Assertions below retain the literal response when JSON is malformed.
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function main() {
  const observed = [];
  const authority = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      observed.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Trace-Id": "analytics-sidecar-trace",
      });
      res.end('{"schemaVersion":"1.0","engine":{"name":"forgex-analytics-csharp","version":"1.3.0"},"report":{}}');
    });
  });
  const authorityPort = await listenServer(authority);
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;

  try {
    const payload = Buffer.from('{"schemaVersion":"1.0","question":"成本趋势","rows":[{"status":"success"}],"provenance":null}');
    const base = await listenApp({ gcodeAuthorityUrl: authorityOrigin });
    const success = await request(base, payload, {
      Accept: "application/json",
      Authorization: "Bearer browser-secret",
      Cookie: "session=browser-secret",
      "X-API-Key": "browser-secret",
      "X-Request-ID": "browser-controlled",
    });
    assert.strictEqual(success.status, 200);
    assert.strictEqual(success.headers.get("x-trace-id"), "analytics-sidecar-trace");
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].url, "/api/v1/analytics/reports");
    assert.ok(observed[0].body.equals(payload), "proxy must preserve analytics JSON bytes");
    assert.ok(!observed[0].headers.cookie);
    assert.ok(!observed[0].headers.authorization);
    assert.ok(!observed[0].headers["x-api-key"]);
    assert.notStrictEqual(observed[0].headers["x-request-id"], "browser-controlled");
    assert.strictEqual(apps[0].cfg.analyticsAuthorityMaxBytes, ANALYTICS_AUTHORITY_HARD_MAX_BYTES);

    const beforeProtected = observed.length;
    const protectedBase = await listenApp({
      gcodeAuthorityUrl: authorityOrigin,
      apiKeys: "analytics-key",
      requireAuth: true,
    });
    const anonymous = await request(protectedBase, payload);
    assert.strictEqual(anonymous.status, 401);
    assert.strictEqual(observed.length, beforeProtected, "authentication rejection must not connect to sidecar");
    const authenticated = await request(protectedBase, payload, { "X-API-Key": "analytics-key" });
    assert.strictEqual(authenticated.status, 200);
    assert.ok(!observed.at(-1).headers["x-api-key"], "Node API key must not reach sidecar");

    const beforeDisabled = observed.length;
    const disabledBase = await listenApp({
      gcodeAuthorityUrl: authorityOrigin,
      analyticsAuthorityEnabled: false,
    });
    const disabled = await request(disabledBase, payload);
    assert.strictEqual(disabled.status, 503);
    assert.strictEqual(disabled.json.code, "analytics_authority_disabled");
    assert.strictEqual(observed.length, beforeDisabled);

    const beforeLimited = observed.length;
    const limitedBase = await listenApp({
      gcodeAuthorityUrl: authorityOrigin,
      analyticsAuthorityMaxBytes: 8,
    });
    const limited = await request(limitedBase, payload);
    assert.strictEqual(limited.status, 413);
    assert.strictEqual(limited.json.code, "payload_too_large");
    assert.strictEqual(observed.length, beforeLimited);

    console.log("Analytics authority proxy PASS: 16/16");
  } finally {
    for (const app of apps.reverse()) await app.close();
    await new Promise((resolve) => authority.close(resolve));
    for (const directory of tempRoots) {
      const resolved = path.resolve(directory);
      const tempPrefix = path.resolve(os.tmpdir()) + path.sep;
      if (!resolved.startsWith(tempPrefix) || !path.basename(resolved).startsWith("forgex-analytics-authority-")) {
        console.error(`Refusing unsafe test cleanup: ${resolved}`);
        process.exitCode = 1;
        continue;
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
