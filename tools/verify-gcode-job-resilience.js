"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const apiDll = path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");

function dotnetExecutable() {
  const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  return fs.existsSync(local) ? local : "dotnet";
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-resilience-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function requestJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitForReady(baseUrl, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`ForgeX.Api exited ${child.exitCode}: ${stderr.join("")}`);
    try {
      const ready = await requestJson(`${baseUrl}/health/ready`);
      if (ready.status === "ready") return ready;
    } catch {
      // Startup race: retry within the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`ForgeX.Api readiness timed out: ${stderr.join("")}`);
}

async function waitForDeadLetter(baseUrl, jobId) {
  let latest;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    latest = await requestJson(`${baseUrl}/api/v1/jobs/${jobId}`);
    if (latest.status === "failed") return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job did not reach dead-letter state: ${JSON.stringify(latest)}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  if (!fs.existsSync(apiDll)) throw new Error(`Release API build missing: ${apiDll}`);
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-resilience-"));
  const storageRoot = path.join(runtimeRoot, "data");
  const jobsRoot = path.join(storageRoot, "jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });

  const jobId = "6a000000000000000000000000000001";
  const createdAtUtc = new Date(Date.now() - 1000).toISOString();
  const startedAtUtc = new Date(Date.now() - 500).toISOString();
  const record = {
    id: jobId,
    idempotencyKey: null,
    fingerprint: "f".repeat(64),
    inputSha256: "0".repeat(64),
    inputBytes: 1,
    options: {
      bedSizeMm: 256,
      coordinateOrigin: "corner",
      materialDensityGPerCm3: 1.24,
      maxInputBytes: 67108864,
      maxLines: 4000000,
      maxLineLength: 1048576,
      machineProfileId: "unspecified-machine",
      materialProfileId: "unspecified-material",
      maxLayers: 20000,
      maxVisualizationSegments: 100000,
      materialPriceCnyPerKg: 0,
      nozzleTemperatureMinC: 0,
      nozzleTemperatureMaxC: 500,
      bedTemperatureMinC: 0,
      materialMaxSpeedMmPerSecond: 1000,
      materialMaxFlowMm3PerSecond: 100,
    },
    status: "running",
    progress: 0.1,
    phase: "parse",
    createdAtUtc,
    startedAtUtc,
    finishedAtUtc: null,
    engineVersion: "1.4.0",
    result: null,
    errorCode: null,
    errorMessage: null,
    traceId: null,
    events: [{ sequence: 1, type: "progress", atUtc: startedAtUtc, status: "running", progress: 0.1, phase: "parse" }],
    tenantId: "tn_local",
    ownerId: "ow_local",
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAtUtc: null,
    deadLetteredAtUtc: null,
  };
  fs.writeFileSync(path.join(jobsRoot, `${jobId}.json`), `${JSON.stringify(record, null, 2)}\n`);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const stdout = [];
  const stderr = [];
  let child;
  try {
    child = spawn(dotnetExecutable(), [apiDll], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Production",
        Kestrel__Endpoints__Http__Url: baseUrl,
        Storage__Root: storageRoot,
        GCodeJobs__QueueCapacity: "4",
        GCodeJobs__Retry__MaxAttempts: "3",
        GCodeJobs__Retry__BaseDelayMilliseconds: "10",
        GCodeJobs__Retry__MaxDelayMilliseconds: "20",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

    const readiness = await waitForReady(baseUrl, child, stderr);
    const snapshot = await waitForDeadLetter(baseUrl, jobId);
    const persisted = JSON.parse(fs.readFileSync(path.join(jobsRoot, `${jobId}.json`), "utf8"));
    const metrics = await (await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(2000) })).text();
    const eventTypes = persisted.events.map((event) => event.type);

    const checks = {
      readinessQueueCapacity: readiness.checks?.jobQueueCapacity === "4",
      terminalDeadLetter: snapshot.status === "failed" && snapshot.phase === "dead-letter",
      exhaustedCode: snapshot.error?.code === "gcode_retry_exhausted",
      retryContract:
        snapshot.retry?.attemptCount === 3 &&
        snapshot.retry?.maxAttempts === 3 &&
        typeof snapshot.retry?.deadLetteredAtUtc === "string" &&
        snapshot.retry?.nextAttemptAtUtc === undefined,
      durableEventOrder:
        JSON.stringify(eventTypes) ===
        JSON.stringify(["progress", "recovery", "progress", "retry", "progress", "terminal"]),
      metrics:
        metrics.includes("forgex_gcode_job_queue_capacity 4") &&
        metrics.includes("forgex_gcode_job_retries_total 1") &&
        metrics.includes("forgex_gcode_job_recoveries_total 1") &&
        metrics.includes("forgex_gcode_job_dead_letters_total 1"),
    };
    const failed = Object.entries(checks).filter(([, pass]) => !pass);
    if (failed.length > 0) {
      throw new Error(
        `resilience checks failed: ${failed.map(([name]) => name).join(", ")}\n${JSON.stringify({ snapshot, eventTypes, metrics }, null, 2)}`
      );
    }

    const artifact = path.join(root, "backend", "artifacts", "gcode-job-resilience-gate.json");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(
      artifact,
      `${JSON.stringify(
        {
          schemaVersion: "1.0",
          generatedAtUtc: new Date().toISOString(),
          result: "pass",
          jobId,
          eventTypes,
          retry: snapshot.retry,
          checks,
        },
        null,
        2
      )}\n`
    );
    process.stdout.write(
      `G-code job resilience gate PASS: ${Object.keys(checks).length}/${Object.keys(checks).length}\n`
    );
    process.stdout.write(`${artifact}\n`);
    process.stdout.write(
      `jobId=${jobId} attempts=${snapshot.retry.attemptCount}/${snapshot.retry.maxAttempts} events=${eventTypes.join(",")}\n`
    );
  } finally {
    await stop(child);
    safeCleanup(runtimeRoot);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
