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
  // 3D 场景初始化比纯 DOM 慢，给足超时；但也别太长，否则挂起的用例会拖垮 CI。
  // CI 的免费 runner 只有 2 核且走 SwiftShader 软渲染，重 3D 用例实测贴着 60s 上限，预算翻倍。
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: process.env.CI ? 20_000 : 10_000 },
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
      use: {
        ...devices["Desktop Firefox"],
        // 无 GPU 的 Linux CI 上 headless Firefox 拿不到 WebGL context（本机 Windows 无此问题），
        // 应用会落入 webgl-fallback，启动等待必超时。CI 改走 Xvfb 有头模式（官方推荐），
        // 由 Mesa 软渲染提供 GL；工作流的 E2E 步骤已用 xvfb-run 包裹。
        ...(process.env.CI ? { headless: false } : {}),
        launchOptions: {
          firefoxUserPrefs: {
            "webgl.force-enabled": true,
            "gfx.webrender.software": true,
          },
        },
      },
    },
    {
      name: "webkit",
      testMatch: "**/cross-browser.spec.js",
      use: { ...devices["Desktop Safari"] },
    },
  ],

  webServer: {
    // serve.js 默认以 browser authority 构建；G-code / Analytics 专项门禁可显式切到 dotnet，
    // 再由调用方启动 loopback sidecar。临时 Node 数据目录不会污染仓库数据。
    command: "node tests/e2e/serve.js",
    cwd: path.resolve(__dirname, ".."),
    url: "http://127.0.0.1:8899/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
