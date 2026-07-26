/* E2E 专用服务器：规则引擎 + 临时数据目录。

   为什么不直接 `node server/index.js`：
   E2E 不该依赖任何外部密钥（否则别人 clone 下来跑不了），
   也不该把测试数据写进仓库的 data/（P4 已经因为这个踩过一次坑）。 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../../server/index");

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
