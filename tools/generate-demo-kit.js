"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("../js/util.js");
require("../js/gcode-parser.js");

const ROOT = path.resolve(__dirname, "..");
const DEMO = path.join(ROOT, "demo");

function write(rel, content) {
  const target = path.join(DEMO, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith("\n") ? content : content + "\n", "utf8");
}

function json(rel, value) {
  write(rel, JSON.stringify(value, null, 2));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function g(n) {
  return Number(n)
    .toFixed(3)
    .replace(/\.?0+$/, "");
}

function buildGcode() {
  const lines = [
    "; FORGE·X video demonstration toolpath",
    "; Built reproducibly with tools/generate-demo-kit.js",
    "; Demo asset only — not produced by a physical printer",
    ";Generated with OrcaSlicer 2.3.0",
    ";FLAVOR:Marlin",
    ";TIME:0",
    ";Filament used: 0m",
    ";Layer height: 0.20",
    ";LAYER_COUNT:18",
    "M82",
    "M140 S60",
    "M104 S210",
    "M190 S60",
    "M109 S210",
    "G28",
    "G29",
    "G92 E0",
  ];
  let e = 0;
  const cx = 120;
  const cy = 120;

  function travel(x, y, feed = 7200) {
    lines.push(`G0 X${g(x)} Y${g(y)} F${feed}`);
  }

  function extrude(x, y, from, feed = 1800) {
    const distance = Math.hypot(x - from.x, y - from.y);
    e += distance * 0.042;
    lines.push(`G1 X${g(x)} Y${g(y)} E${g(e)} F${feed}`);
    return { x, y };
  }

  for (let layer = 0; layer < 18; layer++) {
    const z = (layer + 1) * 0.2;
    lines.push(`;LAYER:${layer}`, `G1 Z${g(z)} F900`);

    for (const perimeter of [38, 34]) {
      lines.push(perimeter === 38 ? ";TYPE:WALL-OUTER" : ";TYPE:WALL-INNER");
      const points = [];
      for (let i = 0; i <= 24; i++) {
        const a = (Math.PI * 2 * i) / 24 + (layer % 2 ? Math.PI / 24 : 0);
        points.push({ x: cx + Math.cos(a) * perimeter, y: cy + Math.sin(a) * perimeter });
      }
      travel(points[0].x, points[0].y);
      let pos = points[0];
      for (let i = 1; i < points.length; i++) pos = extrude(points[i].x, points[i].y, pos, 1500);
    }

    lines.push(layer < 3 || layer >= 15 ? ";TYPE:SOLID-FILL" : ";TYPE:FILL");
    const angle = layer % 2 ? Math.PI / 4 : -Math.PI / 4;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const vx = -uy;
    const vy = ux;
    for (let offset = -27; offset <= 27; offset += layer < 3 || layer >= 15 ? 4.5 : 9) {
      const half = Math.sqrt(Math.max(0, 31 * 31 - offset * offset));
      const a = { x: cx + vx * offset - ux * half, y: cy + vy * offset - uy * half };
      const b = { x: cx + vx * offset + ux * half, y: cy + vy * offset + uy * half };
      const start = (Math.round((offset + 27) / 4.5) + layer) % 2 ? b : a;
      const end = start === a ? b : a;
      travel(start.x, start.y);
      extrude(end.x, end.y, start, layer < 3 || layer >= 15 ? 1350 : 2100);
    }
  }

  lines.push(";END", "M104 S0", "M140 S0", "M107", "G0 X20 Y220 F7200", "M84");
  let text = lines.join("\n") + "\n";
  const parsed = globalThis.FXGcodeParser.parse(text, { densityG: 1.24, bedSize: 256, origin: "corner" });
  const claimedTime = Math.round(parsed.stats.timeSec * 1.04);
  const claimedFilamentM = parsed.stats.filamentM * 1.01;
  text = text.replace(";TIME:0", `;TIME:${claimedTime}`);
  text = text.replace(";Filament used: 0m", `;Filament used: ${claimedFilamentM.toFixed(4)}m`);
  return text;
}

function buildProductionCsv() {
  const header = [
    "job_id",
    "date",
    "machine_id",
    "model_name",
    "material",
    "layer_height_mm",
    "duration_min",
    "filament_g",
    "cost_fen",
    "status",
    "fail_reason",
    "energy_kwh",
  ];
  const machines = ["DEMO-CX320-01", "DEMO-CX320-02", "DEMO-CX320-03"];
  const materials = ["PLA", "PETG", "ABS", "TPU"];
  const models = ["涡轮端盖", "传感器支架", "治具底座", "风道转接件"];
  const heights = [0.12, 0.2, 0.28];
  const bad02 = new Set([2, 4, 7, 9, 13, 16, 19, 22]);
  const bad01 = new Set([8, 18]);
  const bad03 = new Set([11]);
  const rows = [header.join(",")];

  for (let i = 0; i < 72; i++) {
    const machineIndex = i % machines.length;
    const machineJob = Math.floor(i / machines.length);
    const material = materials[(i + machineIndex) % materials.length];
    const model = models[(i * 2 + machineIndex) % models.length];
    const layerHeight = heights[(machineJob + machineIndex) % heights.length];
    const fail =
      (machineIndex === 0 && bad01.has(machineJob)) ||
      (machineIndex === 1 && bad02.has(machineJob)) ||
      (machineIndex === 2 && bad03.has(machineJob));
    const failReason = fail
      ? material === "ABS"
        ? "翘边"
        : machineIndex === 1 && machineJob % 2
          ? "堵料"
          : "断料"
      : "";
    const duration = Math.round(
      24 + 22 * (0.2 / layerHeight) + (material === "TPU" ? 18 : material === "PETG" ? 6 : 0) + machineIndex * 2
    );
    const filament = Number((15 + (i % 7) * 1.7 + (model === "治具底座" ? 6 : 0)).toFixed(1));
    const energy = Number((duration * (material === "ABS" ? 0.008 : 0.0055)).toFixed(2));
    const cost = Math.round(
      filament * (material === "TPU" ? 18 : material === "PETG" ? 10 : 8) + energy * 60 + duration * 2
    );
    const day = String((machineJob % 24) + 1).padStart(2, "0");
    rows.push(
      [
        `VIDEO-${String(i + 1).padStart(3, "0")}`,
        `2026-07-${day}`,
        machines[machineIndex],
        model,
        material,
        layerHeight,
        duration,
        filament,
        cost,
        fail ? "fail" : "success",
        failReason,
        energy,
      ].join(",")
    );
  }
  return rows.join("\n") + "\n";
}

const profile = {
  $schema: "../../profiles/profile-bundle.schema.json",
  format: "forgex-profile-bundle",
  version: 1,
  machines: [
    {
      id: "demo-corexy-320",
      name: "演示 CoreXY 320",
      tag: "DEMO-CX320",
      kinematics: "corexy",
      description: "封闭式 CoreXY · 320 × 320 × 350 mm · 录屏示例",
      buildVolume: { x: 320, y: 320, z: 350 },
      enclosed: true,
      physics: {
        hotendFouling: 0.08,
        feederGrip: 0.94,
        spoolDrag: 0.1,
        heaterHealth: 0.97,
        beltWear: 0.06,
        ambientC: 29,
        draft: 0.05,
      },
      source: "Video demonstration profile generated for ForgeX; verify all values before real use",
    },
  ],
  materials: [
    {
      id: "PLA-HS-demo",
      name: "高速 PLA（演示）",
      nozzle: { default: 220, min: 205, max: 235 },
      bed: { default: 60, min: 50 },
      fan: 90,
      densityG: 1.24,
      maxSpeed: 260,
      flowMm3s: 18,
      shrinkage: 0.25,
      priceCnyKg: 89,
      source: "Video demonstration material profile; replace with the verified filament datasheet",
    },
  ],
};

const gcode = buildGcode();
const parsed = globalThis.FXGcodeParser.parse(gcode, { densityG: 1.24, bedSize: 256, origin: "corner" });
const actualTime = Math.round(parsed.stats.timeSec * 1.12 + 38);
const actualFilamentMm = Math.round(parsed.stats.filamentM * 1000 * 1.015);
const actualFilamentG = Number((parsed.stats.filamentG * 1.02).toFixed(2));
const log = {
  $schema: "../../logs/machine-log.schema.json",
  format: "forgex-machine-log",
  version: 1,
  job: {
    jobId: "VIDEO-TURBINE-001",
    machineId: "DEMO-CX320-01",
    firmware: "Marlin 2.1.2-demo",
    slicer: "OrcaSlicer 2.3.0",
    gcodeSha256: sha256(gcode),
    durationSec: actualTime,
    filamentMm: actualFilamentMm,
    filamentG: actualFilamentG,
    completedLayers: parsed.totalLayers,
    status: "success",
  },
  telemetry: [
    { timeSec: 0, nozzleC: 27.1, bedC: 27.4 },
    { timeSec: Math.round(actualTime * 0.08), nozzleC: 207.8, bedC: 58.9 },
    { timeSec: Math.round(actualTime * 0.22), nozzleC: 219.7, bedC: 60.2 },
    { timeSec: Math.round(actualTime * 0.48), nozzleC: 220.4, bedC: 60.0 },
    { timeSec: Math.round(actualTime * 0.74), nozzleC: 219.8, bedC: 60.3 },
    { timeSec: Math.round(actualTime * 0.96), nozzleC: 220.2, bedC: 59.9 },
    { timeSec: actualTime, nozzleC: 207.3, bedC: 58.6 },
  ],
};

const calibration = {
  $schema: "../../calibration/calibration-bundle.schema.json",
  format: "forgex-calibration-bundle",
  version: 1,
  id: "forgex-video-demonstration",
  revision: 1,
  createdAt: "2026-07-28T00:00:00Z",
  provenance: "synthetic-conformance",
  source: {
    license: "CC0-1.0",
    note: "Generated exclusively for the ForgeX video workflow; not a production timing model.",
  },
  models: [
    {
      id: "demo-cx320-marlin-pla",
      status: "demonstration-only",
      scope: {
        machineId: "DEMO-CX320-01",
        firmware: "Marlin 2.1.2-demo",
        material: "PLA-HS-demo",
      },
      algorithm: "theil-sen",
      trainedAt: "2026-07-28T00:00:00Z",
      coefficients: {
        motionScale: 1.12,
        fixedOverheadSec: 38,
        sampleCount: 8,
      },
      validation: {
        holdoutSamples: 3,
        mape: 0.06,
        maxApe: 0.11,
        medianBias: 0.02,
        evaluatedAt: "2026-07-28T00:00:00Z",
      },
      thresholds: {
        maxMape: 0.15,
        maxBias: 0.1,
        minDriftSamples: 5,
      },
      trainingSetSha256: sha256("ForgeX video demonstration timing observations v1"),
    },
  ],
};

const knowledge = `# FORGE·X 录屏演示知识库

> 这是一份合成演示知识，不代表任何具体设备或材料厂商的技术承诺。

## 术语

- 翘边：打印件边缘离开热床并向上变形，常与首层附着、材料收缩、床温和环境气流有关。
- 堵料：热端挤出阻力持续升高，可能表现为出料不足、挤出机跳齿或打印中断。
- 断料：送料链路检测不到连续耗材，可能来自料盘耗尽、材料断裂或送料阻力过大。
- OEE：设备综合效率，由可用率、性能效率和良率共同构成。

## 演示工艺规则

- 高速 PLA 演示料的建议喷嘴温度为 205–235°C，演示默认值为 220°C。
- 低于 0.15 mm 的层高通常增加路径数量与打印时长。
- 同一机台连续出现堵料时，应先核对喷嘴温度、体积流量、热端积碳和送料阻力。
- 统计结论必须同时查看样本量、置信区间和显著性，相关关系不能直接解释为因果关系。
`;

const readme = `# FORGE·X 视频演示素材

本目录是录屏专用素材包。所有数据均为可复现的合成演示内容，不代表真实设备、真实客户或真实产线。

## 推荐使用顺序

1. \`profile/02-demo-profile.json\`：导入社区机器与材料 Profile。
2. \`assets/01-turbine-relief.png\`：生成浮雕或剪影 3D 模型。
3. 调整工艺参数，展示不同切片路径。
4. 执行平台校准并启动仿真打印，打开实时监控。
5. \`replay/03-demo-turbine.gcode\`：导入 G-code，展示逐层复盘与对账。
6. \`replay/04-demo-machine-log.json\`：追加对应任务日志。
7. \`calibration/05-demo-calibration.json\`：展示校准包格式与合成模型准入保护。
8. \`insight/06-demo-production.csv\`：上传 72 条任务记录并运行自然语言分析。
9. \`knowledge/07-demo-knowledge.md\`：云端 AI provider 可用时复制到知识库入口。
10. 按 \`DEMO-SCRIPT.zh-CN.md\` 完成整段录制。

## 真实性边界

- 图片、Profile、CSV、日志和校准包均为录屏生成素材。
- G-code 的路径、E 增量、层数与自报统计会被应用实际解析。
- 对应日志通过 \`gcodeSha256\` 绑定该 G-code，但日志数值仍是合成示例。
- 校准包故意使用 \`synthetic-conformance + demonstration-only\`，用于展示系统不会把合成模型自动当作生产校准。
`;

write("replay/03-demo-turbine.gcode", gcode);
json("profile/02-demo-profile.json", profile);
json("replay/04-demo-machine-log.json", log);
json("calibration/05-demo-calibration.json", calibration);
write("insight/06-demo-production.csv", buildProductionCsv());
write("knowledge/07-demo-knowledge.md", knowledge);
write("README.md", readme);

console.log(`Generated demo kit: ${parsed.totalLayers} layers, ${parsed.stats.filamentM.toFixed(2)} m filament`);
