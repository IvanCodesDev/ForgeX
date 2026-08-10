/* 使用仓库内锁定 SDK（若存在），CI 则回退到 PATH 上的 dotnet。 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const executable = fs.existsSync(local) ? local : "dotnet";
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node tools/run-dotnet.js <dotnet arguments>");
  process.exit(2);
}

const result = spawnSync(executable, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    DOTNET_CLI_HOME: path.join(root, ".dotnet-home"),
    NUGET_PACKAGES: path.join(root, ".nuget-packages"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    MSBuildEnableWorkloadResolver: "false",
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
