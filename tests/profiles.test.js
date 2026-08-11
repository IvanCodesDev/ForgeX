/* FORGE·X Profile 注册表测试：校验、安全边界、社区扩展与物理特征接线 */
"use strict";

const fs = require("fs");
const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("machine-profile.js"));
require(J("profile-registry.js"));
require(J("insight-data.js"));
const Profiles = globalThis.FXProfiles;
const MachineProfile = globalThis.FXMachineProfile;
const InsightData = globalThis.FXInsightData;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function example() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "profiles", "example-bundle.json"), "utf8")
  );
}

console.log("\n[1] 内置 Profile");
check("内置 4 台机器", Profiles.listMachines().length === 4, Profiles.listMachines().length);
check("内置 4 种材料", Profiles.listMaterials().length === 4, Profiles.listMaterials().length);
check("PLA 已规范化为运行时温度字段", Profiles.material("PLA").nozzleTemp === 210);
check("CoreXY 构建空间可读", Profiles.machine("corexy").buildVolume.x === 256);

console.log("\n[2] 示例 bundle 与 JSON 安全边界");
const bundle = example();
const valid = Profiles.validateBundle(bundle);
check("仓库示例通过运行时校验", valid.ok, valid.errors.join("；"));

const unknown = example();
unknown.materials[0].script = "alert(1)";
const unknownCheck = Profiles.validateBundle(unknown);
check(
  "未知字段/脚本载荷被拒绝",
  !unknownCheck.ok && unknownCheck.errors.some((e) => /script/.test(e)),
  unknownCheck.errors.join("；")
);

const badKin = example();
badKin.machines[0].kinematics = "remote-code";
check("未知运动学被拒绝", !Profiles.validateBundle(badKin).ok);

const badRange = example();
badRange.materials[0].nozzle.default = 900;
check("危险温度范围被拒绝", !Profiles.validateBundle(badRange).ok);

let malformedResult = null;
let malformedError = null;
try {
  malformedResult = Profiles.validateBundle({
    format: "forgex-profile-bundle",
    version: 1,
    machines: {},
    materials: [],
  });
} catch (e) {
  malformedError = e;
}
check("畸形 machines 字段返回校验错误而不是抛异常", !malformedError && malformedResult && !malformedResult.ok);
check(
  "畸形 machines 字段给出稳定数组错误",
  malformedResult && malformedResult.errors.some((e) => /machines 必须是数组/.test(e)),
  malformedResult ? malformedResult.errors.join("；") : String(malformedError)
);

const override = example();
override.materials[0].id = "PLA";
let overrideError = null;
try {
  Profiles.importBundle(override, { persist: false });
} catch (e) {
  overrideError = e;
}
check("社区 Profile 不能覆盖内置 ID", overrideError && /不能覆盖/.test(overrideError.message));
check("失败导入不会留下半个机型", Profiles.machine("community-corexy-300") === null);

console.log("\n[3] 社区机器 / 材料注册与物理特征");
const added = Profiles.importBundle(bundle, { persist: false });
check("导入 1 台社区机器", added.machines.length === 1);
check("导入 1 种社区材料", added.materials.length === 1);
check("社区标记保留", added.machines[0].community && added.materials[0].community);
check("材料运行时字段生成", added.materials[0].nozzleTemp === 285);
check("材料流量进入注册表", added.materials[0].flowMm3s === 7);
check("材料价格进入注册表", added.materials[0].priceCnyKg === 239);
check("社区价格同步到成本分析口径",
  InsightData.COST_PROFILE.material["PA-CF-example"] === 23900 &&
    /PA-CF-example/.test(InsightData.COST_PROFILE.source));

const trait = MachineProfile.MODEL_TRAITS["CCX-300"];
check("机器结构特征注册到物理模型", trait && trait.enclosed && trait.buildMm === 300);
const physical = MachineProfile.of("CCX-300-01", added.machines[0].physics);
check("Profile 物理覆盖进入确定性机台", physical.heaterHealth === 0.96);
check("同一 machineId 的物理特征可复现", MachineProfile.of("CCX-300-01").seed === physical.seed);

console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
process.exit(failed ? 1 : 0);
