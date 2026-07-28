/* Playwright 配置 —— 补上仓库最大的测试盲区。

   `js/ui.js`（1000+ 行）与 `js/insight.js`（700+ 行）此前零覆盖：
   纯逻辑模块有完整断言护着，而用户实际点到的那一层仍需浏览器验证。
   这里覆盖的是「打不开 / 点了没反应 / 界面说了假话」这三类，
   它们恰恰是纯逻辑测试永远抓不到的。

   两条运行路径都要测：
     - file:// 直开（本项目的零依赖承诺，坏了等于核心卖点没了）
     - 带后端（provider / 配额 / 持久化的前端联动）

   WebGL：无头 Chromium 默认用 SwiftShader 软渲染，够跑通 three.js。 */
"use strict";

const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

module.exports = defineConfig({
  testDir: path.resolve(__dirname, "../tests/e2e"),
  outputDir: path.resolve(__dirname, "../test-results"),
  // 3D 场景初始化比纯 DOM 慢，给足超时；但也别太长，否则挂起的用例会拖垮 CI
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // 用例会起后端实例，串行更好排查
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],

  use: {
    baseURL: "http://127.0.0.1:8899",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
        },
      },
    },
    {
      name: "firefox",
      testMatch: "**/cross-browser.spec.js",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testMatch: "**/cross-browser.spec.js",
      use: { ...devices["Desktop Safari"] },
    },
  ],

  webServer: {
    // 用规则引擎 + 临时数据目录：E2E 不该依赖任何外部密钥，也不该污染仓库
    command: "node tests/e2e/serve.js",
    cwd: path.resolve(__dirname, ".."),
    url: "http://127.0.0.1:8899/healthz",
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
