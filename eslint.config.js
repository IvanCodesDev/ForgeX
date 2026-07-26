/* ESLint 扁平配置（v9）。
   本项目有三类源码，运行环境与语法基线各不相同，必须分开配置：
     1. js/*.js       浏览器经典脚本（非 module），ES2017 基线，全局命名空间
     2. server/, tests/  Node CommonJS，可用现代语法
     3. js/vendor/    第三方 vendored 产物，不检查 */
"use strict";

const js = require("@eslint/js");

/** 前端模块通过 window 互相引用（经典脚本，无 import）。
    这份清单必须与各模块底部的 `root.FXxxx = ...` 一一对应——
    写错名字 eslint 只会报 no-undef，不会告诉你真实的导出名。 */
const FRONTEND_GLOBALS = {
  FXU: "readonly", // js/util.js
  FXOrbit: "readonly", // js/orbit.js
  FXSlicer: "readonly", // js/slicer.js
  FXModels: "readonly", // js/models.js
  FXPrinterBase: "readonly", // js/printer3d.js
  FXPrinter: "readonly", // js/printer3d.js（CoreXY，兼容旧引用）
  FXPrinters: "readonly", // js/printer3d.js（注册表）
  FXPrinterI3: "readonly", // js/printers.js
  FXPrinterDelta: "readonly", // js/printers.js
  FXPrinterGantry: "readonly", // js/printers.js
  FXScene: "readonly", // js/scene.js
  FXSim: "readonly", // js/sim.js
  FXExport: "readonly", // js/exporter.js（注意不是 FXExporter）
  FXMachineProfile: "readonly", // js/machine-profile.js
  FXFarmDataset: "readonly", // js/farm-dataset.js（自动生成）
  FXInsightData: "readonly", // js/insight-data.js
  FXInsightEngine: "readonly", // js/insight-engine.js
  FXApiClient: "readonly", // js/api-client.js
  FXInsight: "readonly", // js/insight.js
  FXUI: "readonly", // js/ui.js
  THREE: "readonly",
  FX: "writable", // 控制台调试句柄，由 main.js 挂载
  FX_COMPAT: "writable",
  FX_API_BASE: "readonly",
};

const BROWSER_GLOBALS = {
  window: "readonly",
  document: "readonly",
  console: "readonly",
  location: "readonly",
  navigator: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  fetch: "readonly",
  EventSource: "readonly",
  FileReader: "readonly",
  Image: "readonly",
  Blob: "readonly",
  URL: "readonly",
  performance: "readonly",
  devicePixelRatio: "readonly",
  globalThis: "readonly",
};

const NODE_GLOBALS = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  Buffer: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  fetch: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  globalThis: "readonly",
};

const COMMON_RULES = {
  // 未使用变量：catch 的错误参数常按约定写成 e 并注释忽略，放行
  "no-unused-vars": [
    "error",
    {
      args: "after-used",
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "none",
    },
  ],
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "off", // 前端经典脚本刻意用 var 保 ES5 解析
  "prefer-const": "off",
  "no-console": "off", // 日志与测试都靠它
  curly: "off", // 单行 if 在本项目中很常见且可读
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-prototype-builtins": "off",
  // 中文文案里的全角空格（U+3000）是排版手段，不是错误。
  // 默认 skipTemplates:false 会把模板字面量里的中文排版全部报错。
  "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipComments: true }],
};

module.exports = [
  {
    ignores: [
      "js/vendor/**",
      // 自动生成（node tools/farm-sim.js --emit-js），内嵌大段 CSV，不手工维护
      "js/farm-dataset.js",
      "node_modules/**",
      "coverage/**",
      "**/.tmp-*",
    ],
  },

  js.configs.recommended,

  // ── 前端：浏览器经典脚本 ──
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2017, // 与 index.html 的兼容性守卫基线一致
      sourceType: "script",
      globals: { ...BROWSER_GLOBALS, ...FRONTEND_GLOBALS },
    },
    rules: {
      ...COMMON_RULES,
      // 经典脚本靠 IIFE + window 挂载，不存在 import/export
      "no-undef": "error",
    },
  },

  // ── 后端 / 测试 / 工具：Node CommonJS ──
  {
    files: ["server/**/*.js", "tests/**/*.js", "tools/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: NODE_GLOBALS,
    },
    rules: COMMON_RULES,
  },

  // 测试与工具会 require 前端模块并从 globalThis 取，放行这些全局
  {
    files: ["tests/**/*.js", "tools/**/*.js", "server/services/local-engine.js"],
    languageOptions: {
      globals: { ...NODE_GLOBALS, ...FRONTEND_GLOBALS },
    },
  },
];
