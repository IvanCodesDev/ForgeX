"use strict";

/* Stage 8.6a：Node 是 JS 语义的真源。本脚本用 Node 侧实现生成夹具，C# 门禁
   （backend/tests/ForgeX.ResourceGate）逐条比对 JsJson / DatasetProvenanceSanitizer /
   Bm25Retrieval / 校准 digest 与 file 状态格式。`--check` 重新生成并与磁盘逐字节比较，
   与 openapi:check 同语义：Node 侧实现改了而夹具没更新 → CI 失败。 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { tokenize, chunk, retrieve } = require("../server/services/retrieval");
const { CalibrationStore, digest, stable } = require("../server/services/calibration");
const { DatasourceStore } = require("../server/services/datasource");

const root = path.resolve(__dirname, "..");
const fixtureDir = path.join(root, "backend", "tests", "ForgeX.ResourceGate", "fixtures");
const parityPath = path.join(fixtureDir, "resource-parity.json");
const calibrationsPath = path.join(fixtureDir, "node-calibrations.json");
const checkOnly = process.argv.includes("--check");

const quiet = { info() {}, warn() {}, error() {} };

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/* ── JSON.stringify / stable() ─────────────────────────────────────────── */

const stringifyCases = [
  { name: "chinese-raw", input: { note: "客户端声明为合成/仿真数据，非真实产线数据。", badge: "合成" } },
  { name: "control-chars", input: { s: "a\u0001b\u001fc\bd\fe\nf\rg\th" } },
  { name: "quotes-backslash", input: { s: 'say "hi" \\ done' } },
  { name: "html-sensitive", input: { s: "<tag> & 'quote' + plus" } },
  // 孤立代理项（"\ud800"）不进夹具：System.Text.Json 拒绝解析含孤立代理项的 JSON 文本，
  // C# 端点对这类请求体回 400 invalid_json（设计文档 §13 记为 waiver）；
  // JsJson.EscapeString 对孤立代理项的转义在门禁里用 C# 字面量直接断言。
  { name: "surrogate-pair", input: { s: "😀 emoji" } },
  { name: "number-1e21", input: [1e21, 1e-7, 123456789012345680000] },
  { name: "number-float", input: [0.1 + 0.2, 1 / 3, 100, 1.5, -2.25] },
  { name: "number-negative-zero", input: [-0, 0] },
  { name: "nested", input: { a: [1, { b: null, c: true, d: false }], e: {}, f: [] } },
  { name: "int-like-keys-insertion", input: { b: 1, 10: 2, a: 3, 9: 4 } },
];

const stableCases = [
  { name: "sorted-keys", input: { zeta: 1, alpha: 2, Beta: 3, _under: 4 } },
  { name: "nested-sorted", input: { models: [{ status: "candidate", id: "m" }], id: "x", revision: 2 } },
  { name: "int-like-keys", input: { 10: 1, 9: 2, a: 3 } },
  { name: "chinese-keys", input: { 中: 1, 一: 2, a: 3 } },
  { name: "numbers-strings", input: { n: [1.5, 1e21, 0.30000000000000004], s: "ü\u0007" } },
];

/* ── sanitizeProvenance ─────────────────────────────────────────────────── */

const provenanceCases = [
  { name: "null-claim", claim: null },
  { name: "string-claim", claim: "farm" },
  { name: "known-synthetic-farm", claim: { source: "farm" } },
  { name: "known-synthetic-sim-farm", claim: { source: "sim-farm" } },
  { name: "known-non-synthetic-upload", claim: { source: "upload" } },
  { name: "unknown-source", claim: { source: "constructor" } },
  { name: "declared-synthetic-default-badge", claim: { synthetic: true } },
  { name: "declared-synthetic-long-badge", claim: { synthetic: true, badge: "很长的徽章文本超过八个字" } },
  { name: "declared-synthetic-falsy-badge", claim: { synthetic: true, badge: 0 } },
  { name: "declared-synthetic-numeric-badge", claim: { synthetic: true, badge: 12345678901 } },
  { name: "declared-synthetic-control-badge", claim: { synthetic: true, badge: "a\u0001b" } },
  { name: "declared-synthetic-string-true", claim: { synthetic: "true" } },
  { name: "declared-synthetic-false", claim: { synthetic: false, source: "made-up" } },
];

/* ── BM25 ───────────────────────────────────────────────────────────────── */

const tokenizeCases = [
  { name: "mixed", input: "Hello World_x.y-z 3D打印失败率 K" },
  { name: "kelvin-sign", input: "\u212Aelvin \u0130stanbul" },
  { name: "cjk-only", input: "翘边回抽" },
  { name: "cjk-single", input: "翘 边" },
  { name: "empty", input: "" },
  { name: "punctuation", input: "a,b;c。d！e" },
];

const longParagraph =
  "喷嘴温度过高会导致拉丝。降低温度可缓解，但过低会造成层间粘接不足。" +
  "回抽距离与速度需要联动调整；Bowden 挤出机通常需要更长的回抽。" +
  "PETG 材料尤其容易拉丝。建议先做温度塔测试，再做回抽塔测试。" +
  "This sentence is here to push the paragraph well beyond the 400 character limit so that the " +
  "sentence splitter has to accumulate across several sentences before flushing a chunk. " +
  "Another sentence follows! And a question? Then a semicolon; and finally the end.";

const chunkCases = [
  { name: "blank-line-paragraphs", input: "第一段\n\n第二段\n   \n第三段", maxLen: 400 },
  { name: "heading-split", input: "intro line\n# Heading\nbody\n## Sub\nmore", maxLen: 400 },
  { name: "long-paragraph-sentence-split", input: longParagraph, maxLen: 400 },
  { name: "short-limit", input: "一句。两句。三句！四句？五句；六句;seven.eight!nine?", maxLen: 8 },
  { name: "empty", input: "\n\n  \n", maxLen: 400 },
];

const retrievalDocs = [
  {
    id: "kb_ops",
    name: "ops.md",
    text: "# 拉丝问题\n喷嘴温度过高会导致拉丝，PETG 尤其明显。\n\n# 回抽\n回抽距离 6mm、速度 40mm/s 是 Bowden 挤出机的常见起点。",
  },
  {
    id: "kb_material",
    name: "materials.csv.md",
    text: "PLA 打印温度 200-215C，热床 60C。\n\nABS 打印温度 240-260C，需要封闭腔体，否则翘边。",
  },
  {
    id: "kb_machine",
    name: "machine-03.md",
    text: "03 号机 X 轴皮带松动，层移风险高。定期检查 belt tension。",
  },
];

const retrieveCases = [
  { name: "chinese-hit", question: "拉丝 温度", topK: 4 },
  { name: "english-hit", question: "belt tension layer shift", topK: 4 },
  { name: "mixed-topk-1", question: "PETG 回抽", topK: 1 },
  { name: "no-hit", question: "量子计算", topK: 4 },
  { name: "default-topk-warping", question: "翘边 ABS", topK: undefined },
];

function buildParity() {
  return {
    schemaVersion: "1.0",
    stringify: stringifyCases.map((c) => ({ name: c.name, input: c.input, expected: JSON.stringify(c.input) })),
    stable: stableCases.map((c) => ({
      name: c.name,
      input: c.input,
      expected: stable(c.input),
      digest: digest(c.input),
    })),
    provenance: provenanceCases.map((c) => {
      const expected = DatasourceStore.sanitizeProvenance(c.claim);
      return { name: c.name, claim: c.claim, expected, expectedStringify: JSON.stringify(expected) };
    }),
    tokenize: tokenizeCases.map((c) => ({ name: c.name, input: c.input, expected: tokenize(c.input) })),
    chunk: chunkCases.map((c) => ({
      name: c.name,
      input: c.input,
      maxLen: c.maxLen,
      expected: chunk(c.input, c.maxLen),
    })),
    retrieve: retrieveCases.map((c) => ({
      name: c.name,
      docs: retrievalDocs,
      question: c.question,
      topK: c.topK === undefined ? null : c.topK,
      expected: retrieve(retrievalDocs, c.question, c.topK === undefined ? {} : { topK: c.topK }),
    })),
    // 数据源 cacheKey / id 派生的端到端样例（C# 端点门禁用）
    datasourceIdentity: (() => {
      const csv = "machine,material,part,status\nM1,PLA,bracket,ok\nM2,ABS,cover,fail\n";
      const contentSha256 = sha256(csv);
      const provenance = DatasourceStore.sanitizeProvenance({ synthetic: true, badge: "机群" });
      const cacheKey = sha256(contentSha256 + "\0" + JSON.stringify(provenance));
      const tenantId = "tn_" + "a".repeat(32);
      return {
        csv,
        contentSha256,
        provenance,
        cacheKey,
        tenantId,
        id: "ds_" + sha256(tenantId + "\0" + cacheKey).slice(0, 24),
      };
    })(),
  };
}

/* ── Node 校准治理 file 状态（forgex-calibration-service-state v1） ─────── */

function candidate(id, revision) {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id,
    revision,
    createdAt: "2026-07-28T00:00:00Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized production pairs submitted for independent calibration review.",
    },
    models: [
      {
        id: id + "-pla",
        status: "candidate",
        scope: { machineId: "FX-P8-01", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-07-28T00:00:00Z",
        coefficients: { motionScale: 1.18, fixedOverheadSec: 80, sampleCount: 12 },
        validation: {
          holdoutSamples: 6,
          mape: 0.08,
          maxApe: 0.16,
          medianBias: 0.02,
          evaluatedAt: "2026-07-28T00:00:00Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "c".repeat(64),
      },
    ],
  };
}

async function buildCalibrationState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgex-resource-fixture-"));
  const realNow = Date.now;
  let clock = Date.UTC(2026, 8, 6, 0, 0, 0);
  Date.now = () => (clock += 1000);
  try {
    const store = new CalibrationStore({ dataDir: dir }, quiet);
    await store.submit(candidate("fixture-bundle", 1), "11111111", "Initial production candidate");
    await store.review(
      "fixture-bundle",
      1,
      "approve",
      "22222222",
      "Holdout metrics and anonymization evidence reviewed."
    );
    await store.submit(candidate("fixture-bundle", 2), "11111111", "Revision two candidate kept pending");
    const rejected = candidate("fixture-rejected", 1);
    await store.submit(rejected, "33333333", "Candidate with disputed provenance");
    await store.review("fixture-rejected", 1, "reject", "22222222", "Source authorization could not be verified.");
    const raw = fs.readFileSync(path.join(dir, "calibrations.json"), "utf8");
    return JSON.parse(raw);
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function render(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function main() {
  const parity = render(buildParity());
  const calibrations = render(await buildCalibrationState());
  const outputs = [
    [parityPath, parity],
    [calibrationsPath, calibrations],
  ];
  if (checkOnly) {
    let stale = false;
    for (const [file, content] of outputs) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (current !== content) {
        stale = true;
        console.error(
          `resource parity fixture is stale: ${path.relative(root, file)} (run: npm run resources:fixtures)`
        );
      }
    }
    if (stale) process.exit(1);
    console.log("resource parity fixtures are up to date");
    return;
  }
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [file, content] of outputs) {
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(root, file)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
