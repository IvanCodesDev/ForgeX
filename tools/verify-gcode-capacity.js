"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const apiDll = path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");
const secret = "capacity-gate-internal-secret-32-bytes";

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
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function caller(tenant, owner) {
  return {
    "X-ForgeX-Internal-Token": secret,
    "X-ForgeX-Tenant-Id": `tn_${tenant.repeat(32)}`,
    "X-ForgeX-Owner-Id": `ow_${owner.repeat(32)}`,
  };
}

function seedJob(id, owner, key) {
  const now = new Date().toISOString();
  return {
    id,
    idempotencyKey: key,
    fingerprint: "f".repeat(64),
    inputSha256: id[0].repeat(64),
    inputBytes: 1,
    options: {},
    status: "queued",
    progress: 0,
    phase: "retry-wait",
    createdAtUtc: now,
    events: [
      {
        sequence: 1,
        type: "retry",
        atUtc: now,
        status: "queued",
        progress: 0,
        phase: "retry-wait",
      },
    ],
    tenantId: `tn_${"a".repeat(32)}`,
    ownerId: `ow_${owner.repeat(32)}`,
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAtUtc: new Date(Date.now() + 600000).toISOString(),
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function waitReady(base, child, stderr) {
  for (let index = 0; index < 100; index += 1) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}: ${stderr.join("")}`);
    try {
      const response = await fetch(`${base}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("capacity API readiness timeout");
}

async function waitTerminal(base, accepted, headers) {
  for (let index = 0; index < 200; index += 1) {
    const response = await fetch(base + accepted.links.status, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    const snapshot = await response.json();
    if (["succeeded", "degraded", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("capacity async job timeout");
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("forgex-capacity-")) {
    throw new Error(`unsafe capacity cleanup: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-capacity-"));
  const jobsRoot = path.join(runtimeRoot, "data", "jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });
  const seeds = [
    seedJob("a1000000000000000000000000000001", "1", "seed-1"),
    seedJob("a2000000000000000000000000000002", "1", "seed-2"),
    seedJob("a3000000000000000000000000000003", "2", "seed-3"),
  ];
  for (const job of seeds) fs.writeFileSync(path.join(jobsRoot, `${job.id}.json`), JSON.stringify(job));

  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const stderr = [];
  let child;
  try {
    child = spawn(dotnetExecutable(), [apiDll], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Production",
        Kestrel__Endpoints__Http__Url: base,
        Storage__Root: path.join(runtimeRoot, "data"),
        InternalAuth__SharedSecret: secret,
        GCodeJobs__QueueCapacity: "4",
        GCodeJobs__Admission__MaxActivePerOwner: "2",
        GCodeJobs__Admission__MaxActivePerTenant: "3",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    const readiness = await waitReady(base, child, stderr);
    const gcode = Buffer.from("G90\nM82\nG28\nG1 X0 Y0 Z0.2 F1200\nG1 X10 Y10 E1 F600\n", "utf8");
    const create = (headers, key) =>
      fetch(`${base}/api/v1/gcode/analyses`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-gcode",
          "Idempotency-Key": key,
        },
        body: gcode,
        signal: AbortSignal.timeout(5000),
      });
    const ownerRejected = await create(caller("a", "1"), "owner-rejected");
    const ownerProblem = await ownerRejected.json();
    const tenantRejected = await create(caller("a", "3"), "tenant-rejected");
    const tenantProblem = await tenantRejected.json();
    const admittedHeaders = caller("b", "4");
    const admittedResponse = await create(admittedHeaders, "admitted-job");
    const accepted = await admittedResponse.json();
    const replayResponse = await create(admittedHeaders, "admitted-job");
    const replay = await replayResponse.json();
    const terminal = await waitTerminal(base, accepted, admittedHeaders);

    const lines = ["G90", "M82", "G28", "G1 X0 Y0 Z0.2 F1200"];
    for (let index = 1; index <= 4000; index += 1)
      lines.push(`G1 X${index % 200} Y${(index * 7) % 200} E${index / 100} F1200`);
    const loadBody = Buffer.from(`${lines.join("\n")}\n`);
    const started = performance.now();
    const timings = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const at = performance.now();
        const response = await fetch(`${base}/api/v1/gcode/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/x-gcode" },
          body: loadBody,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`capacity sync response ${response.status}`);
        await response.arrayBuffer();
        return performance.now() - at;
      })
    );
    const elapsedMs = performance.now() - started;
    const metrics = await (await fetch(`${base}/metrics`)).text();
    const checks = {
      readinessLimits:
        readiness.checks?.jobQueueCapacity === "4" &&
        readiness.checks?.jobMaxActivePerOwner === "2" &&
        readiness.checks?.jobMaxActivePerTenant === "3",
      ownerQuota: ownerRejected.status === 429 && ownerProblem.code === "gcode_owner_active_quota_exceeded",
      tenantQuota: tenantRejected.status === 429 && tenantProblem.code === "gcode_tenant_active_quota_exceeded",
      idempotentReplay:
        admittedResponse.status === 202 && replayResponse.status === 202 && replay.jobId === accepted.jobId,
      terminal: terminal.status === "succeeded",
      metricChanges:
        metrics.includes("forgex_gcode_job_owner_quota_rejections_total 1") &&
        metrics.includes("forgex_gcode_job_tenant_quota_rejections_total 1") &&
        metrics.includes("forgex_gcode_job_submissions_total 1"),
      loadBudget: timings.length === 16 && percentile(timings, 0.95) < 10000,
    };
    const failed = Object.entries(checks).filter(([, pass]) => !pass);
    if (failed.length) throw new Error(`capacity checks failed: ${failed.map(([name]) => name).join(", ")}`);
    const report = {
      schemaVersion: "1.0",
      generatedAtUtc: new Date().toISOString(),
      result: "pass",
      input: { concurrentRequests: 16, bytesPerRequest: loadBody.length },
      observed: {
        elapsedMs,
        throughputRequestsPerSecond: (timings.length * 1000) / elapsedMs,
        p50Ms: percentile(timings, 0.5),
        p95Ms: percentile(timings, 0.95),
        p99Ms: percentile(timings, 0.99),
      },
      checks,
    };
    const artifact = path.join(root, "backend", "artifacts", "gcode-capacity-gate.json");
    fs.writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`G-code capacity gate PASS: ${Object.keys(checks).length}/${Object.keys(checks).length}`);
    console.log(`${artifact}`);
    console.log(
      `concurrency=16 bytes=${loadBody.length} p50=${report.observed.p50Ms.toFixed(1)}ms p95=${report.observed.p95Ms.toFixed(1)}ms throughput=${report.observed.throughputRequestsPerSecond.toFixed(2)}/s`
    );
  } finally {
    if (child?.exitCode === null) child.kill();
    await new Promise((resolve) => setTimeout(resolve, 250));
    safeCleanup(runtimeRoot);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
