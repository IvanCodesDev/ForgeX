"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const canonicalPath = path.join(root, "backend", "src", "ForgeX.Api", "openapi", "v1.json");
const apiDll = process.env.FORGEX_API_DLL
  ? path.resolve(root, process.env.FORGEX_API_DLL)
  : path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");

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

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validatePackedToolpath(result, label) {
  const visualization = result?.visualization;
  if (
    visualization?.encoding !== "forgex-toolpath-f32le-v1" ||
    visualization.recordStrideBytes !== 20 ||
    visualization.layers?.length !== result.layers?.length
  ) {
    throw new Error(`${label} packed toolpath contract mismatch`);
  }
  const payload = Buffer.from(visualization.dataBase64, "base64");
  if (
    payload.length !== visualization.segmentCount * visualization.recordStrideBytes ||
    visualization.layers.reduce((total, layer) => total + layer.segmentCount, 0) !== visualization.segmentCount ||
    visualization.layers.reduce((total, layer) => total + layer.sourceSegmentCount, 0) !==
      visualization.sourceSegmentCount
  ) {
    throw new Error(`${label} packed toolpath counts mismatch`);
  }
  for (let index = 0; index < visualization.segmentCount; index += 1) {
    const offset = index * visualization.recordStrideBytes;
    const coordinates = [0, 4, 8, 12].map((coordinate) => payload.readFloatLE(offset + coordinate));
    const pathTypeIndex = payload.readInt32LE(offset + 16);
    if (coordinates.some((value) => !Number.isFinite(value)) || !visualization.pathTypes[pathTypeIndex]) {
      throw new Error(`${label} packed toolpath record ${index} mismatch`);
    }
  }
}

function validateMaterialRisk(result, label) {
  const material = result?.material;
  const risk = result?.risk;
  const expectedCost = (material?.filamentMassG * material?.priceCnyPerKg) / 1000;
  const findingCodes = new Set(risk?.findings?.map((finding) => finding.code));
  if (
    material?.materialProfileId !== "PLA" ||
    material.priceCnyPerKg !== 100 ||
    Math.abs(material.materialCostCny - expectedCost) > 1e-9 ||
    risk?.level !== "high" ||
    !Number.isInteger(risk.score) ||
    risk.score < 0 ||
    risk.score > 100 ||
    !findingCodes.has("GCODE_RISK_NOZZLE_TEMP_OUTSIDE_PROFILE") ||
    !findingCodes.has("GCODE_RISK_BED_TEMP_BELOW_PROFILE") ||
    !findingCodes.has("GCODE_RISK_SPEED_EXCEEDS_PROFILE") ||
    !findingCodes.has("GCODE_RISK_FLOW_EXCEEDS_PROFILE")
  ) {
    throw new Error(`${label} material/risk contract mismatch: ${JSON.stringify({ material, risk })}`);
  }
}

async function request(url, init = {}, timeoutMs = 10_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForReady(baseUrl, child, stdout, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`ForgeX.Api exited ${child.exitCode}: ${stdout.join("")}${stderr.join("")}`);
    try {
      const response = await request(`${baseUrl}/health/ready`, {}, 1_000);
      if (response.ok) return;
    } catch {
      // Startup race: retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`ForgeX.Api readiness timed out: ${stdout.join("")}${stderr.join("")}`);
}

async function waitForTerminal(baseUrl, statusPath, headers) {
  let lastSnapshot;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await request(baseUrl + statusPath, { headers });
    if (!response.ok) throw new Error(`job snapshot returned ${response.status}`);
    const snapshot = await response.json();
    lastSnapshot = snapshot;
    if (["succeeded", "degraded", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`async job did not reach a terminal state: ${JSON.stringify(lastSnapshot)}`);
}

async function readTerminalSse(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("SSE terminal replay timed out")), 10_000);
  let reader;
  try {
    const response = await fetch(url, {
      headers: { ...headers, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) throw new Error(`SSE replay returned ${response.status}`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.length <= 1_048_576) {
      const chunk = await reader.read();
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (text.includes("event: terminal") && text.includes("id:")) return text;
      if (chunk.done) break;
    }
    throw new Error("SSE terminal replay contract mismatch");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => undefined);
  }
}

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-openapi-runtime-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  if (!fs.existsSync(apiDll)) throw new Error(`Release API build missing: ${apiDll}`);
  const canonical = fs.readFileSync(canonicalPath);
  const document = JSON.parse(canonical.toString("utf8"));
  const operationPaths = new Map();
  for (const [route, pathItem] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (pathItem[method]?.operationId) operationPaths.set(pathItem[method].operationId, route);
    }
  }
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-openapi-runtime-"));
  const stdout = [];
  const stderr = [];
  const internalSecret = "openapi-runtime-internal-secret-32-bytes";
  const previousInternalSecret = "openapi-runtime-previous-secret-32-bytes";
  const callerA = {
    "X-ForgeX-Internal-Token": internalSecret,
    "X-ForgeX-Tenant-Id": "tn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "X-ForgeX-Owner-Id": "ow_11111111111111111111111111111111",
  };
  const callerB = {
    "X-ForgeX-Internal-Token": internalSecret,
    "X-ForgeX-Tenant-Id": "tn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "X-ForgeX-Owner-Id": "ow_22222222222222222222222222222222",
  };
  const previousCallerA = {
    ...callerA,
    "X-ForgeX-Internal-Token": previousInternalSecret,
  };
  let child;

  try {
    child = spawn(dotnetExecutable(), [apiDll], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Production",
        Kestrel__Endpoints__Http__Url: baseUrl,
        Storage__Root: path.join(runtimeRoot, "data"),
        InternalAuth__SharedSecret: internalSecret,
        InternalAuth__PreviousSharedSecret: previousInternalSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    await waitForReady(baseUrl, child, stdout, stderr);

    const openApiResponse = await request(`${baseUrl}/openapi/v1.json`);
    const served = Buffer.from(await openApiResponse.arrayBuffer());
    if (openApiResponse.status !== 200) throw new Error(`OpenAPI returned ${openApiResponse.status}`);
    if (sha256(served) !== sha256(canonical)) throw new Error("served OpenAPI differs from canonical bytes");

    for (const route of ["/health/live", "/health/ready", "/healthz"]) {
      const response = await request(baseUrl + route);
      if (response.status !== 200) throw new Error(`${route} returned ${response.status}`);
    }
    const readiness = await (await request(`${baseUrl}/health/ready`)).json();
    if (
      readiness?.status !== "ready" ||
      readiness?.checks?.jobRepository !== "file-json" ||
      readiness?.checks?.jobRepositorySchema !== "1" ||
      !/^\d+$/.test(readiness?.checks?.jobRepositoryRecords ?? "")
    ) {
      throw new Error(`readiness persistence evidence invalid: ${JSON.stringify(readiness)}`);
    }

    const gcode = Buffer.from("G90\nM82\nG28\nM104 S250\nM140 S40\nG1 X0 Y0 Z0.2 F1200\nG1 X10 Y0 E1 F600\n", "utf8");
    const query =
      "bedSizeMm=256&coordinateOrigin=corner&filamentDensityGPerCm3=1.24" +
      "&machineProfileId=corexy&materialProfileId=PLA&materialPriceCnyPerKg=100" +
      "&nozzleTemperatureMinC=195&nozzleTemperatureMaxC=225&bedTemperatureMinC=55" +
      "&materialMaxSpeedMmPerSecond=5&materialMaxFlowMm3PerSecond=1";
    const syncResponse = await request(`${baseUrl}${operationPaths.get("analyzeGCode")}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode" },
      body: gcode,
    });
    if (syncResponse.status !== 200)
      throw new Error(`sync analysis returned ${syncResponse.status}: ${await syncResponse.text()}`);
    const syncResult = await syncResponse.json();
    if (syncResult.input.sha256 !== sha256(gcode)) throw new Error("sync analysis raw-byte SHA mismatch");
    validatePackedToolpath(syncResult, "sync analysis");
    validateMaterialRisk(syncResult, "sync analysis");

    const createUrl = `${baseUrl}${operationPaths.get("createGCodeAnalysisJob")}?${query}`;
    const untrustedCreate = await request(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-gcode" },
      body: gcode,
    });
    if (untrustedCreate.status !== 401) throw new Error(`untrusted create returned ${untrustedCreate.status}`);

    const wrongTokenCreate = await request(createUrl, {
      method: "POST",
      headers: {
        ...callerA,
        "X-ForgeX-Internal-Token": "wrong-internal-token-that-is-long-enough",
        "Content-Type": "application/x-gcode",
      },
      body: gcode,
    });
    if (wrongTokenCreate.status !== 401) throw new Error(`wrong internal token returned ${wrongTokenCreate.status}`);

    const invalidContextCreate = await request(createUrl, {
      method: "POST",
      headers: {
        ...callerA,
        "X-ForgeX-Tenant-Id": "browser-controlled",
        "Content-Type": "application/x-gcode",
      },
      body: gcode,
    });
    if (invalidContextCreate.status !== 400)
      throw new Error(`invalid caller context returned ${invalidContextCreate.status}`);

    const createResponse = await request(createUrl, {
      method: "POST",
      headers: { ...callerA, "Content-Type": "application/x-gcode", "Idempotency-Key": "openapi-runtime-gate" },
      body: gcode,
    });
    if (createResponse.status !== 202)
      throw new Error(`async create returned ${createResponse.status}: ${await createResponse.text()}`);
    const accepted = await createResponse.json();
    const previousSecretStatus = await request(baseUrl + accepted.links.status, { headers: previousCallerA });
    if (previousSecretStatus.status !== 200) {
      throw new Error(`previous rotation secret returned ${previousSecretStatus.status}`);
    }
    const crossTenantStatus = await request(baseUrl + accepted.links.status, { headers: callerB });
    if (crossTenantStatus.status !== 404) throw new Error(`cross-tenant status returned ${crossTenantStatus.status}`);
    const crossTenantEvents = await request(baseUrl + accepted.links.events, { headers: callerB });
    if (crossTenantEvents.status !== 404) throw new Error(`cross-tenant events returned ${crossTenantEvents.status}`);
    const crossTenantCancel = await request(baseUrl + accepted.links.cancel, { method: "POST", headers: callerB });
    if (crossTenantCancel.status !== 404) throw new Error(`cross-tenant cancel returned ${crossTenantCancel.status}`);

    const tenantBCreate = await request(createUrl, {
      method: "POST",
      headers: { ...callerB, "Content-Type": "application/x-gcode", "Idempotency-Key": "openapi-runtime-gate" },
      body: gcode,
    });
    if (tenantBCreate.status !== 202) throw new Error(`tenant B create returned ${tenantBCreate.status}`);
    const acceptedB = await tenantBCreate.json();
    if (acceptedB.jobId === accepted.jobId) throw new Error("idempotency key crossed the tenant boundary");

    const snapshot = await waitForTerminal(baseUrl, accepted.links.status, callerA);
    if (snapshot.status !== "succeeded" || snapshot.result?.input?.sha256 !== sha256(gcode)) {
      throw new Error(
        `async terminal contract mismatch: ${JSON.stringify(snapshot.error || snapshot.status)}\n` +
          `stdout=${stdout.join("")}\nstderr=${stderr.join("")}`
      );
    }
    validatePackedToolpath(snapshot.result, "async analysis");
    validateMaterialRisk(snapshot.result, "async analysis");

    await waitForTerminal(baseUrl, acceptedB.links.status, callerB);
    await readTerminalSse(baseUrl + accepted.links.events, callerA);
    const cancelResponse = await request(baseUrl + accepted.links.cancel, { method: "POST", headers: callerA });
    if (cancelResponse.status !== 200) throw new Error(`terminal cancel returned ${cancelResponse.status}`);

    const metricsResponse = await request(`${baseUrl}/metrics`);
    const metrics = await metricsResponse.text();
    if (
      metricsResponse.status !== 200 ||
      !String(metricsResponse.headers.get("content-type")).startsWith("text/plain; version=0.0.4")
    ) {
      throw new Error(`metrics endpoint contract mismatch: ${metricsResponse.status}`);
    }
    for (const required of [
      "# TYPE forgex_build_info gauge",
      "forgex_job_repository_ready 1",
      'forgex_http_requests_total{method="POST",route="/api/v1/gcode/analyses",status="202"} 2',
      'forgex_http_request_duration_seconds_count{method="POST",route="/api/v1/gcode/analyses"}',
    ]) {
      if (!metrics.includes(required)) throw new Error(`metrics missing: ${required}`);
    }
    if (metrics.includes(accepted.jobId) || metrics.includes(acceptedB.jobId)) {
      throw new Error("metrics leaked a concrete job id into labels");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    const jsonLogs = stdout
      .join("")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const requestLog = jsonLogs.find(
      (line) => line.Category === "ForgeX.Api.Request" && line.State?.StatusCode === 202 && line.State?.TraceId
    );
    if (!requestLog) throw new Error(`structured request log missing: ${stdout.join("")}`);

    console.log(`OpenAPI runtime gate PASS: ${Object.keys(document.paths).length} paths`);
    console.log(`canonicalSha256=${sha256(canonical)}`);
    console.log(
      `engine=${syncResult.engine.version} toolpath=${syncResult.visualization.segmentCount}/${syncResult.visualization.sourceSegmentCount} ` +
        `stride=${syncResult.visualization.samplingStride} payloadBytes=${Buffer.from(syncResult.visualization.dataBase64, "base64").length} ` +
        `layers=${syncResult.visualization.layers.length} encoding=${syncResult.visualization.encoding} ` +
        `materialCostCny=${syncResult.material.materialCostCny} risk=${syncResult.risk.level}/${syncResult.risk.score}`
    );
    console.log(
      `jobId=${accepted.jobId} status=${snapshot.status} sse=terminal tenantIsolation=pass metrics=pass jsonLogs=pass`
    );
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(resolve, 2_000);
      });
    }
    safeCleanup(runtimeRoot);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
