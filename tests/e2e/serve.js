/* E2E 专用服务器：规则引擎 + 临时数据目录。

   为什么不直接 `node server/index.js`：
   E2E 不该依赖任何外部密钥（否则别人 clone 下来跑不了），
   也不该把测试数据写进仓库的 data/（P4 已经因为这个踩过一次坑）。 */
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../../server/index");

const rootDir = path.resolve(__dirname, "../..");

/**
 * E2E 不复用开发者磁盘上可能过期的 dist/react。环境值显式锁定，
 * 避免 .env.local 或 CI 机器密钥把回归测试偶然切到 C# / SSO / 客户端凭据路径。
 */
function buildReactFixture() {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "run", "frontend:build"] : ["run", "frontend:build"];
  const result = childProcess.spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_API_BASE: "",
      VITE_NODE_API_KEY: "",
      VITE_NODE_BEARER: "",
      VITE_GCODE_AUTHORITY: "browser",
      VITE_REACT_SIMULATOR_ENABLED: "1",
      VITE_REACT_GCODE_ENABLED: "1",
      VITE_REACT_PROFILE_SELECTOR_ENABLED: "1",
      VITE_REACT_MACHINE_LOG_ENABLED: "1",
      VITE_REACT_ANALYTICS_ENABLED: "1",
      VITE_REACT_GOVERNANCE_ENABLED: "1",
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  const entry = path.join(rootDir, "dist", "react", "index.html");
  if (!fs.existsSync(entry)) throw new Error("React E2E build missing: " + entry);
}

buildReactFixture();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-e2e-"));

const app = createApp({
  host: "127.0.0.1",
  port: 8899,
  dataDir,
  forceMock: true, // 规则引擎：确定性、零外部计费
  rateLimitMs: 0, // 测试会连续提问，冷却会误伤
  mockDelayMs: 0,
  logLevel: "error",
  probeProvider: false,
  apiKeys: "e2e-calibration-submitter,e2e-calibration-reviewer",
  calibrationReviewKeys: "e2e-calibration-reviewer",
  requireAuth: false,
  infiniPartnerClientId: "",
  infiniPartnerClientSecret: "",
  gcodeAuthorityUrl: "",
});

app.server.listen(8899, "127.0.0.1", () => {
  process.stdout.write("e2e server on http://127.0.0.1:8899 (data: " + dataDir + ")\n");
});

function shutdown() {
  app.close().then(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (e) {
      /* 清不掉就留在系统临时目录，由 OS 回收 */
    }
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
