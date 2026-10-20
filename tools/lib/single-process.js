/* Stage 8.6d-2：E2E 与部署演练共用真实 C# 单进程宿主；没有 Node HTTP 代理。 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "../..");
const apiDll = path.join(root, "backend/src/ForgeX.Api/bin/Release/net10.0/ForgeX.Api.dll");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startSingleProcess({ port, storageRoot, postgresUrl, apiKeys = "", reviewKeys = "", extraEnv = {} }) {
  if (!postgresUrl) throw new Error("C# 单进程需要 POSTGRES_URL；先执行 npm run postgres:migrate -- --require。");
  if (!fs.existsSync(apiDll)) throw new Error("缺少 Release 构建，请先执行 npm run dotnet:build。");
  const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: "Production",
    Kestrel__Endpoints__Http__Url: baseUrl,
    AllowedHosts: "localhost;127.0.0.1",
    Storage__Root: storageRoot,
    Persistence__Provider: "file", // G-code 作业保留单机文件仓库；业务资源使用 PostgreSQL。
    POSTGRES_URL: postgresUrl,
    StaticHosting__Enabled: "true",
    StaticHosting__Root: root,
    PublicFacade__Enabled: "true",
    PublicFacade__RateLimitMs: "0",
    PublicFacade__TrustProxy: "false",
    PublicFacade__PublicBase: baseUrl,
    DirectAuth__ApiKeys: apiKeys,
    DirectAuth__CalibrationReviewKeys: reviewKeys,
    DirectAuth__RequireAuth: "false",
    Analysis__Provider: "rules",
    Analysis__ProbeProvider: "0",
    InternalAuth__SharedSecret: "",
    InternalAuth__PreviousSharedSecret: "",
    Logging__LogLevel__Default: "Warning",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    ...extraEnv,
  };
  for (const section of ["AnalysisTasks", "Datasources", "Knowledge", "Shares", "Calibrations"]) {
    env[`${section}__Provider`] = "postgres";
    env[`${section}__PostgresUrl`] = postgresUrl;
  }
  let output = "";
  const child = spawn(fs.existsSync(local) ? local : "dotnet", [apiDll], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-16000);
    });
  }
  const stop = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`ForgeX.Api exited ${child.exitCode}`);
      try {
        const response = await fetch(baseUrl + "/healthz", { signal: AbortSignal.timeout(1500) });
        if (response.ok) return { child, baseUrl, stop };
      } catch {
        /* 启动竞态，限期重试。 */
      }
      await sleep(150);
    }
    throw new Error("ForgeX.Api /healthz 未就绪（请检查数据库连接与迁移）");
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${output}`, { cause: error });
  }
}

module.exports = { startSingleProcess };
