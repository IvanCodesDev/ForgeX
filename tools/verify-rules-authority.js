/* Stage 8.3 规则计算腿全语料双跑门禁。

   AnalyticsGate 里的 rules/* 断言是静态金样（期望值由 Node 实测后写死进 C# 源码），
   本工具是它的动态补集：同一份语料同时喂给
     - Node 权威侧：直接 require 经典 classic 模块（与 server/services/local-engine.js 同一加载方式），
     - C# 实测侧：启动真实 ForgeX.Api sidecar（与 tools/verify-openapi-runtime.js 同一模式），
       逐用例请求 Stage 8.3 的 5 个内部端点。
   对比口径（以 Node/classic 为权威）：
     - normalize：rows 语义级 deep-equal + errors 逐条逐字节 + csv 逐字节；
       rows 为空时豁免 csv——经典 toCsv([]) 返回仅表头行而 C# 返回 ""，但 Node 消费方
       （server/services/datasource.js）在 rows 为空时先抛 400、csv 根本不被消费，
       豁免在报告 waivers 里逐条注明。
     - farm：csv sha256 + 逐字节，rows 语义级，provenance 语义级 + JSON.stringify 逐字节
       （键序卷入数据源去重 cacheKey，是契约的一部分）。
     - meta：fields / minSample 逐项，provenance 目录语义级 + JSON.stringify 逐字节。
     - brief：text 逐字节 + facts 语义级。
     - calibration validate：ok 精确 + errors 逐条逐字节（错误文案与推入顺序都是契约）。
   数值语义级 = 精确相等，容差沿用分析金样口径 max(1e-9, |期望|×1e-9)。
   产物：backend/artifacts/rules-authority-dualrun.json（结构参照 analytics-golden-diff.json），
   有差异时打印明细并以非零码退出。 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const artifactPath = path.join(root, "backend", "artifacts", "rules-authority-dualrun.json");
const apiDll = process.env.FORGEX_API_DLL
  ? path.resolve(root, process.env.FORGEX_API_DLL)
  : path.join(root, "backend", "src", "ForgeX.Api", "bin", "Release", "net10.0", "ForgeX.Api.dll");

/* ── Node 权威侧：经典模块（加载方式与 server/services/local-engine.js 一致） ── */

const store = {};
globalThis.localStorage = {
  getItem: (key) => (key in store ? store[key] : null),
  setItem: (key, value) => {
    store[key] = value;
  },
  removeItem: (key) => {
    delete store[key];
  },
};
const JS = (p) => path.join(root, "frontend", "classic", "js", p);
require(JS("util.js"));
require(JS("farm-dataset.js"));
require(JS("insight-data.js"));
require(JS("stats-kernel.js"));
require(JS("insight-engine.js"));
require(JS("time-calibration.js"));
require(JS("calibration-registry.js"));
const D = globalThis.FXInsightData;
const E = globalThis.FXInsightEngine;
const FARM = globalThis.FXFarmDataset;
const Registry = globalThis.FXCalibrationRegistry;
// buildBrief 是简报的 Node 权威实现（其内部 require 的 local-engine 与上面共享 require 缓存）
const { buildBrief } = require(path.join(root, "server", "services", "brief.js"));

/* ── 对比基础设施 ─────────────────────────────────────────────── */

const NUMERIC_ABS = 1e-9; // 与 tests/golden/stage4-analytics-golden.json tolerance 同口径
const NUMERIC_REL = 1e-9;
const MAX_DIFFS_PER_CASE = 80;

const fields = [];
const waivers = [];

const jsonClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha256 = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function fmt(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "<undefined>";
  return text.length > 400 ? `${text.slice(0, 400)}…<${text.length} chars total>` : text;
}

function pushField(caseId, field, expected, actual, pass, extra = {}) {
  fields.push({
    caseId,
    field,
    expected: fmt(expected),
    actual: fmt(actual),
    absDelta: extra.absDelta ?? null,
    relDelta: extra.relDelta ?? null,
    limit: extra.limit ?? 0,
    pass,
  });
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 语义级 deep-equal：键集合无序比较、数组按序、数值走金样容差。返回叶子比较数。 */
function deepDiff(expected, actual, at, diffs) {
  if (typeof expected === "number" && typeof actual === "number") {
    const absDelta = Math.abs(expected - actual);
    const limit = Math.max(NUMERIC_ABS, Math.abs(expected) * NUMERIC_REL);
    if (!(expected === actual || absDelta <= limit)) {
      diffs.push({
        path: at,
        expected,
        actual,
        absDelta,
        relDelta: expected !== 0 ? absDelta / Math.abs(expected) : null,
        limit,
      });
    }
    return 1;
  }
  if (typeName(expected) !== typeName(actual)) {
    diffs.push({
      path: at,
      expected: `<${typeName(expected)}> ${fmt(expected)}`,
      actual: `<${typeName(actual)}> ${fmt(actual)}`,
    });
    return 1;
  }
  if (Array.isArray(expected)) {
    let leaves = 1;
    if (expected.length !== actual.length) {
      diffs.push({ path: `${at}.length`, expected: expected.length, actual: actual.length });
    }
    const shared = Math.min(expected.length, actual.length);
    for (let i = 0; i < shared; i += 1) leaves += deepDiff(expected[i], actual[i], `${at}[${i}]`, diffs);
    return leaves;
  }
  if (expected !== null && typeof expected === "object") {
    let leaves = 0;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const nextAt = `${at}.${key}`;
      if (!(key in expected)) {
        diffs.push({ path: nextAt, expected: "<absent>", actual: fmt(actual[key]) });
        leaves += 1;
      } else if (!(key in actual)) {
        diffs.push({ path: nextAt, expected: fmt(expected[key]), actual: "<absent>" });
        leaves += 1;
      } else {
        leaves += deepDiff(expected[key], actual[key], nextAt, diffs);
      }
    }
    return leaves;
  }
  if (expected !== actual) diffs.push({ path: at, expected, actual });
  return 1;
}

function compareDeep(caseId, field, expected, actual) {
  const diffs = [];
  const leaves = deepDiff(expected, actual, "", diffs);
  if (diffs.length === 0) {
    pushField(caseId, field, `<deep-equal:${leaves} leaves>`, `<deep-equal:${leaves} leaves>`, true);
    return;
  }
  for (const diff of diffs.slice(0, MAX_DIFFS_PER_CASE)) {
    pushField(caseId, `${field}${diff.path}`, diff.expected, diff.actual, false, diff);
  }
  if (diffs.length > MAX_DIFFS_PER_CASE) {
    pushField(
      caseId,
      `${field}(+${diffs.length - MAX_DIFFS_PER_CASE} more diffs)`,
      "<see rerun>",
      "<truncated>",
      false
    );
  }
}

function compareBytes(caseId, field, expected, actual) {
  if (expected === actual) {
    pushField(caseId, field, `<byte-equal:${Buffer.byteLength(expected, "utf8")} bytes>`, "<byte-equal>", true);
    return;
  }
  let index = 0;
  const limit = Math.min(expected.length, actual.length);
  while (index < limit && expected[index] === actual[index]) index += 1;
  const window = (text) => JSON.stringify(text.slice(Math.max(0, index - 40), index + 40));
  pushField(
    caseId,
    `${field}(first diff at char ${index}, lengths ${expected.length}/${actual.length})`,
    window(expected),
    window(actual),
    false
  );
}

function compareErrors(caseId, field, expected, actual) {
  if (expected.length !== actual.length) {
    pushField(caseId, `${field}.length`, expected.length, actual.length, false);
  } else {
    pushField(caseId, `${field}.length`, expected.length, actual.length, true);
  }
  const shared = Math.min(expected.length, actual.length);
  for (let i = 0; i < shared; i += 1) {
    if (expected[i] === actual[i]) pushField(caseId, `${field}[${i}]`, expected[i], actual[i], true);
    else compareBytes(caseId, `${field}[${i}]`, expected[i], actual[i]);
  }
}

/* ── sidecar 启停（与 tools/verify-openapi-runtime.js 同模式） ──────────── */

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

async function request(url, init = {}, timeoutMs = 30_000) {
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

function safeCleanup(directory) {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("forgex-rules-authority-")
  ) {
    throw new Error(`refusing cleanup outside the dedicated runtime directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function getJson(baseUrl, pathname) {
  const response = await request(baseUrl + pathname);
  if (response.status !== 200) throw new Error(`GET ${pathname} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postRaw(baseUrl, pathname, bodyText) {
  const response = await request(baseUrl + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
  if (response.status !== 200)
    throw new Error(`POST ${pathname} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

const postJson = (baseUrl, pathname, body) => postRaw(baseUrl, pathname, JSON.stringify(body));

function checkEnvelope(caseId, payload) {
  pushField(caseId, "schemaVersion", "1.0", payload.schemaVersion, payload.schemaVersion === "1.0");
  pushField(
    caseId,
    "engine.name",
    "forgex-analytics-csharp",
    payload.engine?.name,
    payload.engine?.name === "forgex-analytics-csharp"
  );
}

/* ── 语料：CSV 规范化 ─────────────────────────────────────────── */

function buildCsvCases() {
  const cases = [];
  const add = (id, csvText) => cases.push({ id, csvText });

  add("farm-full", FARM.csv);

  add(
    "header-chinese-aliases",
    [
      "任务编号,打印日期,机台,模型名称,耗材类型,层高,耗时分钟,克重,成本分,结果,故障类型,电量",
      "J-001,2026-07-01,FX-01,行星齿轮,PLA,0.2,95,34,300,成功,,0.4",
      "J-002,2026-07-02,FX-02,涡轮叶轮,ABS,0.28,150,52,520,失败,翘边,0.7",
      "J-003,2026-07-03,FX-01,传感器支架,PETG,0.12,120,41,410,完成,悬垂塌陷,0.5",
    ].join("\n")
  );

  add(
    "header-english-aliases",
    [
      "job,date,machine,model,material,layer_height,duration,耗材,cost,状态,故障,能耗",
      "J1,2026-07-01,M-1,Gear,PLA,0.2,95,34,123,success,,0.4",
      "J2,2026-07-02,M-2,Vane,TPU,0.28,150,52.5,456,failed,断料,0.7",
    ].join("\n")
  );

  add("header-quoted-and-spaced", ['"machine_id", Status ,"成本"', "M1,success,1.23", "M2,fail,0"].join("\n"));

  add(
    "header-duplicate-columns",
    ["status,status,machine_id,machine_id", "fail,success,M1,M2", "success,fail,M3,M4"].join("\n")
  );

  add(
    "header-cost-both-columns",
    ["material,status,cost_fen,成本", "PLA,success,55,1.23", "ABS,fail,12.7,", "PETG,ok,,2.675"].join("\n")
  );

  add(
    "quoted-cells",
    [
      "machine_id,status,fail_reason",
      '"M,1",fail,"含""引号""与,逗号"',
      'M2,success,"ignored,reason"',
      'M"3,fail,普通',
      '"M4",fail,"跨行开始',
      '继续"',
    ].join("\n")
  );

  add(
    "cost-cny-rounding",
    [
      "material,status,成本",
      "PLA,success,1.155",
      "PLA,success,1.005",
      "PLA,success,0.615",
      "PLA,success,2.675",
      "PLA,success,0.005",
      "PLA,success,-1.005",
      "PLA,success,12",
      "PLA,success,.5",
      "PLA,success,12.",
      "PLA,success,1e2",
      "PLA,success,+3.5",
      "PLA,success,-0.125",
      "PLA,success,",
    ].join("\n")
  );

  add(
    "numeric-validity",
    [
      "machine_id,status,duration_min",
      "M1,success,abc",
      "M2,success,NaN",
      "M3,success,Infinity",
      "M4,success,-Infinity",
      "M5,success,0x10",
      "M6,success,1e999",
      "M7,success,-1e999",
      "M8,success,",
      "M9,success,  12  ",
      "M10,success,1_000",
      "M11,success,12e",
      "M12,success,.e3",
      "M13,success,5.5e-1",
      "M14,success,１２３",
      "M15,success,--5",
      "M16,success,.",
      "M17,success,-.5",
      "M18,success,+4e1",
    ].join("\n")
  );

  add(
    "js-number-roundtrip",
    [
      "machine_id,status,duration_min,layer_height_mm,energy_kwh",
      "M1,success,1e21,1.5e-7,0.000001",
      "M2,success,1e-7,5e-324,1.7976931348623157e308",
      "M3,success,123456789012345680000,123.456e3,-0",
      "M4,success,0.1,204.5,100.6",
    ].join("\n")
  );

  add(
    "status-normalization",
    [
      "machine_id,status",
      "M1,Success",
      "M2,SUCCEEDED",
      "M3,ok",
      "M4,Complete",
      "M5,COMPLETED",
      "M6,成功",
      "M7,完成",
      "M8,fail",
      "M9,FAILED",
      "M10,Failure",
      "M11,ERROR",
      "M12,失败",
      "M13,故障",
      "M14,weird",
      "M15,",
      "M16,  success  ",
    ].join("\n")
  );

  add(
    "fail-reason-clearing",
    [
      "machine_id,status,fail_reason",
      "M1,success,翘边",
      "M2,fail,堵料",
      "M3,ok,悬垂塌陷",
      "M4,fail,",
      "M5,完成,热失控",
    ].join("\n")
  );

  add(
    "row-shape-and-line-endings",
    "machine_id,status,duration_min\r\nM1,success\rM2,fail,3,EXTRA,9\n\n   \nM3,ok,5\r\n"
  );

  add("bom-prefix", "\uFEFFmachine_id,status\nM1,success");
  add("bom-double", "\uFEFF\uFEFFmachine_id,status\nM1,success");

  {
    const bulk = ["machine_id,status"];
    for (let i = 0; i < 5010; i += 1) bulk.push(`M-${i % 7},${i % 3 === 0 ? "fail" : "success"}`);
    add("truncate-over-5000", bulk.join("\n"));
  }

  add("zero-rows-all-invalid", ["machine_id,status", "M1,weird", "M2,unknown"].join("\n"));
  add("missing-status-column", ["machine_id,material", "M1,PLA"].join("\n"));
  add("missing-machine-and-material", ["status,duration_min", "success,5"].join("\n"));
  add("missing-all-required", ["foo,bar", "1,2"].join("\n"));
  add("header-only", "machine_id,status");
  add("empty-text", "");
  add("whitespace-only-lines", "\n  \n\t\n");

  add(
    "unicode-values",
    [
      "machine_id,model_name,status,fail_reason",
      'M🖨️-01,"模型,带逗号",fail,"故障：📉""引号"""',
      "Ｍ全角-02,支架Ω,success,忽略我",
    ].join("\n")
  );

  add(
    "cells-with-spaces",
    ["machine_id,status,material", " M1 , success , PLA ", "\tM2\t,\tfail\t,\tABS\t"].join("\n")
  );

  return cases;
}

/* ── 语料：统计简报 ───────────────────────────────────────────── */

function buildBriefCases() {
  const farmRows = jsonClone(FARM.rows());
  const cases = [];
  const add = (id, rows) => cases.push({ id, rows });

  add("farm-full", farmRows);
  add("farm-head-50", farmRows.slice(0, 50));
  add("farm-tail-4", farmRows.slice(-4));
  add("farm-single-row", farmRows.slice(0, 1));
  add(
    "farm-machine-01",
    farmRows.filter((row) => row.machine_id === "FX-256-01")
  );
  add(
    "farm-success-only",
    farmRows.filter((row) => row.status === "success")
  );
  add(
    "farm-fail-only",
    farmRows.filter((row) => row.status === "fail")
  );
  add(
    "farm-material-pla",
    farmRows.filter((row) => row.material === "PLA")
  );

  const fromCsv = (csvText) => jsonClone(D.parseCsv(csvText).rows);
  add(
    "csv-no-date-column",
    fromCsv(
      [
        "machine_id,status,duration_min,layer_height_mm,filament_g,cost_fen,energy_kwh",
        "M1,success,100,0.2,30,300,0.4",
        "M1,success,110,0.2,31,310,0.45",
        "M2,success,220,0.12,60,600,0.9",
        "M2,fail,40,0.12,10,90,0.1",
        "M3,success,95,0.28,28,280,0.35",
        "M3,success,90,0.28,27,270,0.33",
      ].join("\n")
    )
  );
  add(
    "csv-sparse-fields",
    fromCsv(["material,status", "PLA,success", "PLA,fail", "ABS,success", "ABS,success", "PETG,fail"].join("\n"))
  );
  add(
    "csv-unknown-groups",
    fromCsv(
      [
        "machine_id,material,status,date",
        ",PLA,success,2026-07-01",
        ",PLA,fail,2026-07-02",
        "M2,ABS,success,2026-07-03",
        "M2,,fail,2026-07-04",
        "M2,PETG,success,2026-07-05",
      ].join("\n")
    )
  );

  return cases;
}

/* ── 语料：校准包验证 ─────────────────────────────────────────── */

const SHA_A = "a".repeat(64);

function validModel(overrides) {
  return {
    id: "model-valid",
    status: "candidate",
    scope: { machineId: "FX-01", firmware: "Klipper 0.12", material: "PLA" },
    algorithm: "theil-sen",
    trainedAt: "2026-07-27T00:00:00Z",
    coefficients: { motionScale: 1.2, fixedOverheadSec: 90, sampleCount: 12 },
    validation: {
      holdoutSamples: 6,
      mape: 0.08,
      maxApe: 0.18,
      medianBias: 0.02,
      evaluatedAt: "2026-07-28T00:00:00Z",
    },
    thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
    trainingSetSha256: SHA_A,
    ...overrides,
  };
}

function validBundle(overrides) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id: "dualrun-bundle",
    revision: 1,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized paired production observations collected with authorization.",
    },
    models: [validModel({ id: "model-valid", status: "active" })],
    ...overrides,
  };
}

function buildValidateCases() {
  const examplePath = path.join(root, "contracts", "calibration", "example-bundle.json");
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const cases = [];
  const add = (id, bundle) => cases.push({ id, bundle });
  // raw：以原始 JSON 文本发送，保住文档键序（JS 对象字面量会先把整数样键重排，
  // 无法构造"10 在 0 之前"的文档来考验 C# 的 JsValue.OrderKeys）
  const addRaw = (id, raw) => cases.push({ id, raw });
  const model = validModel;

  add("example-bundle", example);
  add("active-valid", validBundle());
  add("gate-bad1", {
    format: "x",
    version: 2,
    id: "ab",
    revision: 0,
    createdAt: "not-a-date",
    provenance: "weird",
    source: { license: "", note: "short", extra: 1 },
    models: [],
  });
  add(
    "gate-bad2",
    validBundle({
      id: "bundle.one",
      revision: 2,
      createdAt: "2026-08-01T00:00:00Z",
      source: { license: "CC0", note: "一份用于门禁断言的真实来源说明文字，超过二十个字符。" },
      models: [
        model({
          id: "model-a",
          status: "active",
          trainedAt: "2026-08-01",
          scope: { machineId: "FX-1", firmware: "Marlin", material: null },
          coefficients: { motionScale: 20, fixedOverheadSec: -1, sampleCount: 2 },
          validation: { holdoutSamples: null, mape: 2, maxApe: 9, medianBias: -3, evaluatedAt: "2026-08-02" },
          thresholds: { maxMape: 0.9, maxBias: 0.005, minDriftSamples: 1 },
        }),
        {
          id: "model-a",
          status: "demonstration-only",
          algorithm: "other",
          trainedAt: "bad",
          trainingSetSha256: "ZZ",
          scope: { machineId: " ", firmware: "" },
          coefficients: { motionScale: 1, fixedOverheadSec: 10, sampleCount: 3 },
          validation: {
            holdoutSamples: 5,
            mape: 0.1,
            maxApe: 0.2,
            medianBias: 0,
            evaluatedAt: "2026-08-02T10:00:00+08:00",
          },
          thresholds: { maxMape: 0.2, maxBias: 0.2, minDriftSamples: 3 },
          unknownField: true,
        },
      ],
    })
  );
  add("gate-bad3", "not-an-object");
  add("bundle-null", null);
  add("bundle-array", [1, 2]);
  add("bundle-number", 123);
  add("bundle-missing", undefined);
  addRaw("unknown-key-order", '{"10":1,"zz":3,"2":2,"0":4,' + JSON.stringify(validBundle()).slice(1));
  add(
    "dates-valid-exotic",
    validBundle({
      createdAt: " 2026-08-01 ",
      models: [
        model({
          id: "date-m0",
          trainedAt: "2026-08",
          validation: { ...model({}).validation, evaluatedAt: "2026-08-01T24:00:00Z" },
        }),
        model({
          id: "date-m1",
          trainedAt: "8/24/2026",
          validation: { ...model({}).validation, evaluatedAt: "Aug 24 2026" },
        }),
        model({
          id: "date-m2",
          trainedAt: "24 August 2026",
          validation: { ...model({}).validation, evaluatedAt: "2026/8/4" },
        }),
      ],
    })
  );
  add(
    "dates-invalid",
    // "2026-02-30" 这类 V8 遗留解析器会做日期滚动的形态在 JsDate 的承诺范围之外
    //（见 JsDate.cs 头注释），语料只用两侧口径一致的非法日期。
    validBundle({
      createdAt: "not-a-date",
      models: [
        model({
          id: "bad-date-m0",
          trainedAt: "2026-08-32",
          validation: { ...model({}).validation, evaluatedAt: "2026-13-01" },
        }),
        model({
          id: "bad-date-m1",
          trainedAt: "2026-08-01T25:00:00Z",
          validation: { ...model({}).validation, evaluatedAt: 20260801 },
        }),
        model({
          id: "bad-date-m2",
          trainedAt: "32 August 2026",
          validation: { ...model({}).validation, evaluatedAt: "13/45/2026" },
        }),
      ],
    })
  );
  add(
    "js-value-coercions",
    validBundle({
      models: [
        model({
          id: "coerce-m0",
          coefficients: { motionScale: "5", fixedOverheadSec: null, sampleCount: "3" },
        }),
        model({
          id: "coerce-m1",
          coefficients: { motionScale: true, fixedOverheadSec: false, sampleCount: 3 },
        }),
        model({
          id: "coerce-m2",
          coefficients: { motionScale: null, fixedOverheadSec: 90, sampleCount: 12 },
          validation: {
            holdoutSamples: 4.5,
            mape: "0.5",
            maxApe: 0.2,
            medianBias: true,
            evaluatedAt: "2026-08-02",
          },
        }),
        model({
          id: "coerce-m3",
          status: "active",
          validation: { ...model({}).validation, holdoutSamples: null },
        }),
      ],
    })
  );
  add(
    "id-edges",
    validBundle({
      models: [
        model({ id: "ab" }),
        model({ id: "a".repeat(64) }),
        model({ id: "a".repeat(65) }),
        model({ id: "UPPER.Ok_-1" }),
        model({ id: "-lead" }),
        model({ id: "has space" }),
        model({ id: "日本語id" }),
        model({ id: "dup-a" }),
        model({ id: "dup-a" }),
        model({ id: "dup-a" }),
      ].map((entry) => ({ ...entry, status: "candidate" })),
    })
  );
  add(
    "scope-material-variants",
    validBundle({
      models: [
        model({ id: "mat-null", scope: { machineId: "FX-1", firmware: "fw", material: null } }),
        model({ id: "mat-empty", scope: { machineId: "FX-1", firmware: "fw", material: "" } }),
        model({ id: "mat-blank", scope: { machineId: "FX-1", firmware: "fw", material: "   " } }),
        model({ id: "mat-star", scope: { machineId: "FX-1", firmware: "fw", material: "*" } }),
        model({ id: "mat-missing", scope: { machineId: "FX-1", firmware: "fw" } }),
      ],
    })
  );
  add(
    "range-boundaries",
    validBundle({
      models: [
        model({ id: "rng-ok-low", coefficients: { motionScale: 0.1, fixedOverheadSec: 0, sampleCount: 3 } }),
        model({ id: "rng-ok-high", coefficients: { motionScale: 10, fixedOverheadSec: 7200, sampleCount: 3 } }),
        model({
          id: "rng-bad-low",
          coefficients: { motionScale: 0.09999999, fixedOverheadSec: -0.001, sampleCount: 2 },
        }),
        model({
          id: "rng-bad-high",
          coefficients: { motionScale: 10.000001, fixedOverheadSec: 7200.01, sampleCount: 3.5 },
        }),
        model({
          id: "rng-validation",
          validation: { holdoutSamples: 0, mape: 1.0000001, maxApe: 5.1, medianBias: -1.01, evaluatedAt: "2026-08-02" },
          thresholds: { maxMape: 0.009, maxBias: 0.500001, minDriftSamples: 2 },
        }),
        model({
          id: "rng-validation-ok",
          validation: { holdoutSamples: 0, mape: 1, maxApe: 5, medianBias: -1, evaluatedAt: "2026-08-02" },
          thresholds: { maxMape: 0.01, maxBias: 0.5, minDriftSamples: 3 },
        }),
      ],
    })
  );
  add(
    "sha-edges",
    validBundle({
      models: [
        model({ id: "sha-upper", trainingSetSha256: "A".repeat(64) }),
        model({ id: "sha-short", trainingSetSha256: "a".repeat(63) }),
        model({ id: "sha-bad-char", trainingSetSha256: `${"a".repeat(63)}g` }),
        model({ id: "sha-ok", trainingSetSha256: "0123456789abcdef".repeat(4) }),
      ],
    })
  );
  add(
    "active-gates",
    validBundle({
      models: [
        model({
          id: "act-mape",
          status: "active",
          validation: { ...model({}).validation, mape: 0.3 },
        }),
        model({
          id: "act-bias",
          status: "active",
          validation: { ...model({}).validation, medianBias: -0.2 },
        }),
        model({ id: "act-demo", status: "demonstration-only" }),
      ],
    })
  );
  add(
    "synthetic-provenance-gates",
    validBundle({
      provenance: "synthetic-conformance",
      models: [model({ id: "syn-active", status: "active" }), model({ id: "syn-demo", status: "demonstration-only" })],
    })
  );
  add("model-not-object", validBundle({ models: ["str", 42, null, [1], model({ id: "still-ok" })] }));
  add("models-not-array", validBundle({ models: { 0: model({}) } }));
  {
    const noSource = validBundle();
    delete noSource.source;
    add("source-missing", noSource);
  }
  add("source-null", validBundle({ source: null }));
  add(
    "source-note-boundary",
    validBundle({ source: { license: "MIT", note: "一二三四五六七八九十一二三四五六七八九" } })
  );
  add(
    "source-note-exact-20",
    validBundle({ source: { license: "MIT", note: "一二三四五六七八九十一二三四五六七八九十" } })
  );
  add("revision-float", validBundle({ revision: 1.5 }));
  add("revision-string", validBundle({ revision: "3" }));
  add("revision-zero", validBundle({ revision: 0 }));
  add("revision-1e2", validBundle({ revision: 1e2 }));

  return cases;
}

/* ── 各端点执行 ───────────────────────────────────────────────── */

async function runMeta(baseUrl) {
  const meta = await getJson(baseUrl, "/api/v1/analytics/datasets/meta");
  checkEnvelope("meta/contract", meta);
  compareDeep("meta/contract", "fields", jsonClone(D.FIELDS), meta.fields);
  pushField("meta/contract", "minSample", E.MIN_SAMPLE, meta.minSample, meta.minSample === E.MIN_SAMPLE);
  compareDeep("meta/contract", "provenance", jsonClone(D.PROVENANCE), meta.provenance);
  compareBytes("meta/contract", "provenance.stringify", JSON.stringify(D.PROVENANCE), JSON.stringify(meta.provenance));
  return meta.engine?.version ?? "unknown";
}

async function runFarm(baseUrl) {
  const farm = await getJson(baseUrl, "/api/v1/analytics/datasets/farm");
  checkEnvelope("farm/dataset", farm);
  const expectedCsv = FARM.csv;
  pushField(
    "farm/dataset",
    "csv.sha256",
    sha256(expectedCsv),
    sha256(farm.csv),
    sha256(expectedCsv) === sha256(farm.csv)
  );
  compareBytes("farm/dataset", "csv", expectedCsv, farm.csv);
  compareDeep("farm/dataset", "rows", jsonClone(FARM.rows()), farm.rows);
  compareDeep("farm/dataset", "provenance", jsonClone(D.PROVENANCE.farm), farm.provenance);
  compareBytes(
    "farm/dataset",
    "provenance.stringify",
    JSON.stringify(D.PROVENANCE.farm),
    JSON.stringify(farm.provenance)
  );
}

async function runNormalize(baseUrl, cases) {
  let first = true;
  for (const { id, csvText } of cases) {
    const caseId = `normalize/${id}`;
    const actual = await postJson(baseUrl, "/api/v1/analytics/datasets/normalize", {
      schemaVersion: "1.0",
      csvText,
    });
    if (first) {
      checkEnvelope(caseId, actual);
      first = false;
    }
    const parsed = D.parseCsv(csvText);
    compareDeep(caseId, "rows", jsonClone(parsed.rows), actual.rows);
    compareErrors(caseId, "errors", parsed.errors, actual.errors);
    if (parsed.rows.length === 0) {
      // 零行豁免：经典 toCsv([]) 给仅表头行，C# 契约为 ""；Node 消费方在 rows 为空时
      // 先抛 400、csv 不被消费。此处只断言 C# 侧恒为 ""。
      pushField(caseId, "csv(waived: zero-row)", "", actual.csv, actual.csv === "");
      waivers.push({
        caseId,
        field: "csv",
        reason: 'rows 为空：classic toCsv([]) 为仅表头行，C# 返回 ""；Node 消费方先抛 400，csv 不被消费',
      });
    } else {
      compareBytes(caseId, "csv", D.toCsv(parsed.rows), actual.csv);
    }
  }
}

async function runBriefs(baseUrl, cases) {
  let first = true;
  for (const { id, rows } of cases) {
    const caseId = `brief/${id}`;
    const actual = await postJson(baseUrl, "/api/v1/analytics/briefs", { schemaVersion: "1.0", rows });
    if (first) {
      checkEnvelope(caseId, actual);
      first = false;
    }
    const expected = buildBrief(jsonClone(rows));
    compareBytes(caseId, "text", expected.text, actual.text);
    compareDeep(caseId, "facts", jsonClone(expected.facts), actual.facts);
  }
}

async function runValidates(baseUrl, cases) {
  let first = true;
  for (const entry of cases) {
    const caseId = `validate/${entry.id}`;
    let actual;
    let expected;
    if (entry.raw) {
      actual = await postRaw(baseUrl, "/api/v1/calibration/validate", `{"schemaVersion":"1.0","bundle":${entry.raw}}`);
      expected = Registry.validateBundle(JSON.parse(entry.raw));
    } else {
      // bundle 为 undefined 时 JSON.stringify 会自动丢键——经典侧即 validateBundle(undefined)
      actual = await postJson(baseUrl, "/api/v1/calibration/validate", { schemaVersion: "1.0", bundle: entry.bundle });
      expected = Registry.validateBundle(entry.bundle === undefined ? undefined : jsonClone(entry.bundle));
    }
    if (first) {
      checkEnvelope(caseId, actual);
      first = false;
    }
    pushField(caseId, "ok", expected.ok, actual.ok, expected.ok === actual.ok);
    compareErrors(caseId, "errors", expected.errors, actual.errors);
  }
}

/* ── 主流程 ───────────────────────────────────────────────────── */

async function main() {
  if (!fs.existsSync(apiDll)) {
    throw new Error(`Release API build missing: ${apiDll} — run \`npm run dotnet:build\` first`);
  }
  const csvCases = buildCsvCases();
  const briefCases = buildBriefCases();
  const validateCases = buildValidateCases();

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-rules-authority-"));
  const stdout = [];
  const stderr = [];
  let child;
  let engineVersion; // runMeta 失败即整体抛错，报告不会在未赋值时被写出

  try {
    child = spawn(dotnetExecutable(), [apiDll], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Production",
        Kestrel__Endpoints__Http__Url: baseUrl,
        Storage__Root: path.join(runtimeRoot, "data"),
        InternalAuth__SharedSecret: "rules-authority-internal-secret-32-bytes",
        InternalAuth__PreviousSharedSecret: "rules-authority-previous-secret-32-bytes",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    await waitForReady(baseUrl, child, stdout, stderr);

    engineVersion = await runMeta(baseUrl);
    await runFarm(baseUrl);
    await runNormalize(baseUrl, csvCases);
    await runBriefs(baseUrl, briefCases);
    await runValidates(baseUrl, validateCases);
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

  const passed = fields.filter((field) => field.pass).length;
  const report = {
    format: "forgex-rules-authority-dualrun",
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    engineVersion,
    nodeVersion: process.version,
    corpus: {
      normalize: csvCases.length,
      farm: 1,
      meta: 1,
      brief: briefCases.length,
      validate: validateCases.length,
      farmRows: FARM.rows().length,
    },
    fieldCount: fields.length,
    passedFieldCount: passed,
    failedFieldCount: fields.length - passed,
    pass: passed === fields.length,
    waivers,
    fields,
  };
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`);

  const byEndpoint = new Map();
  for (const field of fields) {
    const endpoint = field.caseId.split("/")[0];
    const tally = byEndpoint.get(endpoint) || { pass: 0, total: 0 };
    tally.total += 1;
    if (field.pass) tally.pass += 1;
    byEndpoint.set(endpoint, tally);
  }
  for (const [endpoint, tally] of byEndpoint) {
    console.log(`  ${endpoint}: ${tally.pass}/${tally.total}`);
  }
  console.log(`report=${path.relative(root, artifactPath)} waivers=${waivers.length} engine=${engineVersion}`);

  if (passed !== fields.length) {
    for (const field of fields.filter((entry) => !entry.pass).slice(0, 60)) {
      console.error(
        `  FAIL ${field.caseId} ${field.field}\n    expected=${field.expected}\n    actual  =${field.actual}`
      );
    }
    throw new Error(`rules authority dual-run FAILED: ${fields.length - passed}/${fields.length} fields differ`);
  }
  console.log(`rules authority dual-run PASS: ${passed}/${fields.length} fields`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
