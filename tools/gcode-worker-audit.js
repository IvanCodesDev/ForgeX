/* Stage 10.3「Web Worker 收口核验」手动测量脚本（V1 §5.5 / V2 §4.4 工作项 3）。

   做什么：
   1. 在系统临时目录生成 16 MiB 与 64 MB 级（63.75 MiB，贴近解析器 MAX_BYTES 上限）合成 G-code——
      产物只落在 %TEMP%，绝不写进仓库；
   2. 照 E2E 的启动方式（tests/e2e/serve.js，含前端构建）起真实工作台；
   3. 用 Playwright 导入文件并测量主线程健康度：
      - PerformanceObserver longtask（条数 / 最大时长 / 合计，业界口径 50ms）
      - rAF 心跳间隔（解析期间 UI 是否可交互，最大间隔即冻结时长）
      - performance.memory 采样（注意：主线程被同步解析阻塞时定时器不会触发，
        采样空洞本身就是阻塞证据；峰值以能采到的样本为准并在报告里注明口径）
      - 导入总时长（file input change → bus "sliced" source=gcode-import）
   4. 结果打印成表并写入 optimization/stage10-worker-audit/measurements/（本地归档，不入库）。

   用法：
     node tools/gcode-worker-audit.js --label=baseline
     node tools/gcode-worker-audit.js --label=after --sizes=16,64
     node tools/gcode-worker-audit.js --generate-only

   为什么不做成 CI 用例：64 MB 级文件的生成与解析在免费 runner 上要花数分钟，
   回归卡口由 tests/e2e/gcode-worker.spec.js 用小文件 + 比例断言承担，本脚本只负责全量复核。 */
/* global window, document, performance, PerformanceObserver, requestAnimationFrame */
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE_URL = "http://127.0.0.1:8899";
const TMP_DIR = path.join(os.tmpdir(), "forgex-gcode-worker-audit");
const REPORT_DIR = path.join(ROOT, "optimization", "stage10-worker-audit", "measurements");

/** 尺寸档位。64 MB 级取 63.75 MiB：既贴近引擎 MAX_BYTES（64 MiB）又留出安全余量不触发拒绝。 */
const SIZE_PRESETS = {
  16: { label: "16MiB", bytes: 16 * 1024 * 1024 },
  64: { label: "64MB-level", bytes: 63.75 * 1024 * 1024 },
};

function parseArgs(argv) {
  const args = { sizes: [16, 64], label: "", generateOnly: false, noRender: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--generate-only") args.generateOnly = true;
    else if (raw === "--no-render") args.noRender = true;
    else if (raw.startsWith("--label=")) args.label = raw.slice("--label=".length);
    else if (raw.startsWith("--sizes=")) {
      args.sizes = raw
        .slice("--sizes=".length)
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => SIZE_PRESETS[n]);
    }
  }
  if (!args.label) args.label = new Date().toISOString().replace(/[:.]/g, "-");
  return args;
}

/* ── 合成 G-code 生成 ─────────────────────────────────────────────
   Cura 风格：头部声明 + 每层 ;LAYER / ;TYPE:WALL-OUTER 周界环 + ;TYPE:FILL 之字填充，
   绝对 E（M82）+ 每层 G92 E0 + 回抽/空驶，坐标落在 256 床内。确定性伪随机保证可复现。 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const E_PER_MM = (0.2 * 0.4) / (Math.PI * 0.875 * 0.875); // 层高×线宽 / ⌀1.75 截面积

function layerBlock(layerIndex, rand) {
  const z = (0.2 * (layerIndex + 1)).toFixed(2);
  const lines = [];
  let e = 0;
  const push = (line) => lines.push(line);
  const g1 = (x, y, f) => push(`G1${f ? " F" + f : ""} X${x.toFixed(3)} Y${y.toFixed(3)} E${e.toFixed(5)}`);

  push(`;LAYER:${layerIndex}`);
  push("G92 E0");
  push(`G0 F9000 X25.000 Y25.000 Z${z}`);

  /* 周界：围绕床中心的方环，130 个点，带确定性抖动 */
  push(";TYPE:WALL-OUTER");
  const half = 100 + rand() * 4;
  const cx = 128;
  const cy = 128;
  let px = cx + half * (1 + 0.015 * Math.sin(layerIndex));
  let py = cy;
  push(`G0 F9000 X${px.toFixed(3)} Y${py.toFixed(3)}`);
  const perimeterPoints = 130;
  for (let i = 1; i <= perimeterPoints; i++) {
    const t = i / perimeterPoints;
    const angle = t * Math.PI * 2;
    const wobble = 1 + 0.015 * Math.sin(angle * 7 + layerIndex);
    const nx = cx + half * wobble * Math.cos(angle);
    const ny = cy + half * wobble * Math.sin(angle);
    e += Math.hypot(nx - px, ny - py) * E_PER_MM;
    g1(nx, ny, i === 1 ? 1350 : 0);
    px = nx;
    py = ny;
  }

  /* 填充：之字条带，条带间空驶 + 回抽，条带内切成 12 段模拟真实切片器的细分 */
  push(";TYPE:FILL");
  const strips = 178;
  const segmentsPerStrip = 12;
  const xMin = 30;
  const xMax = 226;
  for (let s = 0; s < strips; s++) {
    const y = 30 + s * 1.1 + rand() * 0.05;
    const leftToRight = s % 2 === 0;
    const from = leftToRight ? xMin : xMax;
    const to = leftToRight ? xMax : xMin;
    e -= 0.8; // 回抽
    push(`G1 F2700 E${e.toFixed(5)}`);
    push(`G0 F9000 X${from.toFixed(3)} Y${y.toFixed(3)}`);
    e += 0.8;
    push(`G1 F2700 E${e.toFixed(5)}`);
    let sx = from;
    for (let seg = 1; seg <= segmentsPerStrip; seg++) {
      const nx = from + ((to - from) * seg) / segmentsPerStrip;
      e += Math.abs(nx - sx) * E_PER_MM;
      g1(nx, y, seg === 1 ? 2400 : 0);
      sx = nx;
    }
  }
  push(`M117 Layer ${layerIndex}`);
  return lines.join("\n") + "\n";
}

async function generateGcode(filePath, targetBytes) {
  const header =
    [
      ";FLAVOR:Marlin",
      ";TIME:43200",
      ";Filament used: 41.2m",
      ";Layer height: 0.2",
      ";Generated with Cura_SteamEngine 5.10.0 (forgex synthetic audit fixture)",
      "M140 S60",
      "M190 S60",
      "M104 S210",
      "M109 S210",
      "G28",
      "G90",
      "M82",
      "M106 S255",
    ].join("\n") + "\n";
  const footer = ["M107", "M104 S0", "M140 S0", "G28 X0 Y0", "M84", ";End of Gcode"].join("\n") + "\n";

  const rand = mulberry32(0x5eed_f00d);
  const stream = fs.createWriteStream(filePath);
  const write = (chunk) =>
    new Promise((resolve, reject) => {
      stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  let bytes = Buffer.byteLength(header);
  await write(header);
  const budget = targetBytes - Buffer.byteLength(footer);
  let layerIndex = 0;
  while (bytes < budget) {
    let block = layerBlock(layerIndex, rand);
    let blockBytes = Buffer.byteLength(block);
    if (bytes + blockBytes > budget) {
      /* 末层放不下整块：截到最后一个完整行，保证文件语法完好 */
      const room = budget - bytes;
      block = block.slice(0, block.lastIndexOf("\n", room - 1) + 1);
      blockBytes = Buffer.byteLength(block);
      if (!blockBytes) break;
    }
    await write(block);
    bytes += blockBytes;
    layerIndex += 1;
  }
  await write(footer);
  bytes += Buffer.byteLength(footer);
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
  return { bytes, layers: layerIndex };
}

async function ensureFixture(sizeKey) {
  const preset = SIZE_PRESETS[sizeKey];
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, `forgex-audit-${preset.label}.gcode`);
  const expected = Math.floor(preset.bytes);
  if (fs.existsSync(filePath)) {
    const actual = fs.statSync(filePath).size;
    if (Math.abs(actual - expected) < 4096) {
      console.log(`[fixture] 复用 ${filePath}（${actual} 字节）`);
      return { path: filePath, bytes: actual, label: preset.label };
    }
  }
  console.log(`[fixture] 生成 ${preset.label} → ${filePath} …`);
  const t0 = Date.now();
  const { bytes, layers } = await generateGcode(filePath, expected);
  console.log(`[fixture] 完成：${bytes} 字节 · ${layers} 层 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { path: filePath, bytes, label: preset.label };
}

/* ── 服务与浏览器 ───────────────────────────────────────────── */

async function waitForHealthz(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.__exited) throw new Error("serve.js 提前退出（构建失败？见上方输出）");
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      /* 服务器尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("等待 " + BASE_URL + "/healthz 超时（构建或端口冲突？端口 8899 被占用时请先停掉旧进程再重跑）");
}

/** serve.js 直跑时 npm_execpath 为空，会退回 spawn npm.cmd —— Node ≥22.12 在 Windows 上 EINVAL。补上再启动。 */
function resolveNpmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const candidate = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(candidate) ? candidate : "";
}

function startServer() {
  const npmCli = resolveNpmCli();
  const child = childProcess.spawn(process.execPath, ["tests/e2e/serve.js"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...(npmCli ? { npm_execpath: npmCli } : {}) },
  });
  child.on("exit", (code) => {
    child.__exited = true;
    if (code && !child.__expected) {
      console.error(`[serve] 提前退出，code=${code}`);
      process.exitCode = 1;
    }
  });
  return child;
}

function requirePlaywright() {
  try {
    return require("playwright");
  } catch {
    return require("@playwright/test");
  }
}

/** 页面内埋点：longtask 观察者 + rAF 心跳 + 内存采样 + 导入起止时刻。 */
function instrumentPage() {
  const audit = {
    t0: 0,
    t1: 0,
    done: false,
    longtasks: [],
    rafT: [],
    memSamples: [],
    errors: [],
    memBefore: performance.memory ? performance.memory.usedJSHeapSize : null,
    memAtDone: null,
  };
  window.__gcodeAudit = audit;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        audit.longtasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch (error) {
    audit.errors.push("longtask observer unavailable: " + error);
  }
  document.getElementById("gcode-input").addEventListener(
    "change",
    () => {
      audit.t0 = performance.now();
    },
    { once: true, capture: true }
  );
  window.FX.bus.on("sliced", (info) => {
    if (info && info.source === "gcode-import" && !audit.t1) {
      audit.t1 = performance.now();
      audit.memAtDone = performance.memory ? performance.memory.usedJSHeapSize : null;
    }
  });
  window.FX.bus.on("toast", (payload) => {
    if (payload && payload.type === "err") audit.errors.push(String(payload.msg));
  });
  const beat = (t) => {
    audit.rafT.push(t);
    if (!audit.done) requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  const sampleMemory = () => {
    if (performance.memory) audit.memSamples.push([performance.now(), performance.memory.usedJSHeapSize]);
    if (!audit.done) setTimeout(sampleMemory, 120);
  };
  sampleMemory();
}

/** 汇总埋点数据（页面内执行）。窗口 = [t0, t1 + 200ms]，容纳解析完成后的收尾渲染。 */
function collectAudit() {
  const audit = window.__gcodeAudit;
  audit.done = true;
  const t0 = audit.t0;
  const t1 = audit.t1;
  const windowEnd = t1 + 200;
  const inWindow = audit.longtasks.filter((e) => e.start + e.duration > t0 && e.start < windowEnd);
  const gapsIn = [];
  const gapsOut = [];
  for (let i = 1; i < audit.rafT.length; i++) {
    const gap = audit.rafT[i] - audit.rafT[i - 1];
    if (audit.rafT[i] > t0 && audit.rafT[i - 1] < windowEnd) gapsIn.push(gap);
    else gapsOut.push(gap);
  }
  const median = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const slice = window.FX.sim.slice;
  const memPeak = audit.memSamples.reduce((max, s) => Math.max(max, s[1]), 0);
  return {
    importMs: t1 - t0,
    longtaskCount: inWindow.length,
    longtaskMaxMs: inWindow.reduce((max, e) => Math.max(max, e.duration), 0),
    longtaskTotalMs: inWindow.reduce((sum, e) => sum + e.duration, 0),
    longtasksTop: [...inWindow].sort((a, b) => b.duration - a.duration).slice(0, 10),
    rafGapMaxMs: gapsIn.reduce((max, g) => Math.max(max, g), 0),
    rafGapMedianMs: median(gapsIn),
    rafGapBaselineMedianMs: median(gapsOut),
    rafGapsOver50: gapsIn.filter((g) => g > 50).length,
    rafGapsOver200: gapsIn.filter((g) => g > 200).length,
    rafBeatsInWindow: gapsIn.length,
    memBeforeMB: audit.memBefore == null ? null : audit.memBefore / 1048576,
    memAtDoneMB: audit.memAtDone == null ? null : audit.memAtDone / 1048576,
    memPeakSampledMB: memPeak ? memPeak / 1048576 : null,
    memSampleCount: audit.memSamples.length,
    totalLayers: slice.totalLayers,
    filamentM: slice.stats ? slice.stats.filamentM : null,
    parserWarnings: slice.warnings ? slice.warnings.length : 0,
    errors: audit.errors,
  };
}

async function measureImport(browser, fixture, noRender) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(300_000);
  await page.goto(`${BASE_URL}/react`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.FX && window.FX.sim && window.FX.sim.slice, null, { timeout: 60_000 });
  await page.locator("#flow-pills .flow-pill").first().click();
  if (noRender) {
    /* 无头机是 SwiftShader 软渲染：空闲时每帧就 >50ms，长任务计数被渲染帧灌满。
       此模式停掉绘制调用（保留 rAF 节拍、DOM 与 React），只度量导入链路自身的 JS。 */
    await page.evaluate(() => {
      window.FX.fx.renderer.render = () => {};
    });
  }
  await page.evaluate(instrumentPage);
  await page.locator("#gcode-input").setInputFiles(fixture.path);
  await page.waitForFunction(() => window.__gcodeAudit && window.__gcodeAudit.t1 > 0, null, {
    timeout: 300_000,
    polling: 250,
  });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(collectAudit);
  await context.close();
  if (result.errors.length) throw new Error("导入过程报错：" + result.errors.join("; "));
  return result;
}

function formatRow(fixture, r) {
  const mem = (v) => (v == null ? "n/a" : v.toFixed(0) + "MB");
  return [
    fixture.label.padEnd(12),
    (fixture.bytes / 1048576).toFixed(1).padStart(7) + "MiB",
    String(r.totalLayers).padStart(5) + "层",
    (r.importMs / 1000).toFixed(2).padStart(8) + "s",
    String(r.longtaskCount).padStart(4) + "条",
    r.longtaskMaxMs.toFixed(0).padStart(8) + "ms",
    r.longtaskTotalMs.toFixed(0).padStart(8) + "ms",
    r.rafGapMaxMs.toFixed(0).padStart(8) + "ms",
    String(r.rafGapsOver200).padStart(4),
    mem(r.memBeforeMB).padStart(7),
    mem(r.memAtDoneMB).padStart(7),
    mem(r.memPeakSampledMB).padStart(7),
  ].join(" | ");
}

async function main() {
  const args = parseArgs(process.argv);
  const fixtures = [];
  for (const size of args.sizes) fixtures.push(await ensureFixture(size));
  if (args.generateOnly) return;

  let gitHead = "unknown";
  try {
    gitHead = childProcess.execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    /* git 不可用时报告里标 unknown */
  }

  console.log("[serve] 启动 E2E 服务器（含前端构建，约 1 分钟）…");
  const server = startServer();
  const results = [];
  try {
    await waitForHealthz(server, 300_000);
    const { chromium } = requirePlaywright();
    const browser = await chromium.launch({
      args: [
        "--use-gl=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-gpu-sandbox",
        "--enable-precise-memory-info",
      ],
    });
    try {
      for (const fixture of fixtures) {
        console.log(`[measure] 导入 ${fixture.label}（${fixture.bytes} 字节）${args.noRender ? " · 渲染隔离" : ""}…`);
        const result = await measureImport(browser, fixture, args.noRender);
        results.push({ fixture: { label: fixture.label, bytes: fixture.bytes }, result });
        console.log(formatRow(fixture, result));
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.__expected = true;
    server.kill();
  }

  console.log("");
  console.log(
    "档位          |     大小 |   层数 |   导入时长 | 长任务 |   最大 |    合计 | rAF最大 | >200ms | 导入前 | 完成时 | 采样峰值"
  );
  for (let i = 0; i < results.length; i++) {
    console.log(formatRow(fixtures[i], results[i].result));
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${args.label}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        label: args.label,
        gitHead,
        renderIsolated: args.noRender,
        timestamp: new Date().toISOString(),
        longtaskThresholdNote: "V1 §10.4 无硬数字（要求“长任务显著下降、UI 可响应”）；本报告采用业界 50ms 长任务口径",
        environment: { platform: process.platform, node: process.version },
        results,
      },
      null,
      2
    )
  );
  console.log(`\n[report] 已写入 ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
