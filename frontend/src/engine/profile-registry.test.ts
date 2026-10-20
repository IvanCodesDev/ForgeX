/* Profile 注册表（Stage 7.4 前置：自 tests/profiles.test.js 迁入 vitest，改测 TS 引擎）
   覆盖：内置 Profile / 示例 bundle 与 JSON 安全边界 / 社区机器、材料注册与物理特征接线。 */
import { beforeAll, describe, expect, it } from "vitest";
import { getCostProfile } from "./insight-data.ts";
import * as MachineProfile from "./machine-profile.ts";
import * as Profiles from "./profile-registry.ts";
import type { ProfileBundle } from "./profile-registry.ts";
import exampleBundleRaw from "../../../contracts/profiles/example-bundle.json?raw";

type LooseBundle = ProfileBundle & {
  machines: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown> & { nozzle?: Record<string, unknown> }>;
};
const example = () => JSON.parse(exampleBundleRaw) as LooseBundle;

describe("内置 Profile", () => {
  it("4 台机器、4 种材料、PLA 运行时温度、CoreXY 构建空间", () => {
    expect(Profiles.listMachines()).toHaveLength(4);
    expect(Profiles.listMaterials()).toHaveLength(4);
    expect(Profiles.material("PLA")!.nozzleTemp).toBe(210);
    expect(Profiles.machine("corexy")!.buildVolume.x).toBe(256);
  });
});

describe("示例 bundle 与 JSON 安全边界", () => {
  it("仓库示例通过运行时校验", () => {
    const valid = Profiles.validateBundle(example());
    expect(valid.ok, valid.errors.join("；")).toBe(true);
  });

  it("未知字段/脚本载荷、未知运动学、危险温度范围 均被拒绝", () => {
    const unknown = example();
    unknown.materials[0]!.script = "alert(1)";
    const unknownCheck = Profiles.validateBundle(unknown);
    expect(unknownCheck.ok).toBe(false);
    expect(unknownCheck.errors.some((e) => /script/.test(e))).toBe(true);

    const badKin = example();
    badKin.machines[0]!.kinematics = "remote-code";
    expect(Profiles.validateBundle(badKin).ok).toBe(false);

    const badRange = example();
    badRange.materials[0]!.nozzle!.default = 900;
    expect(Profiles.validateBundle(badRange).ok).toBe(false);
  });

  it("畸形 machines 字段返回稳定的校验错误而不是抛异常", () => {
    const malformed = Profiles.validateBundle({
      format: "forgex-profile-bundle",
      version: 1,
      machines: {},
      materials: [],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.errors.some((e) => /machines 必须是数组/.test(e))).toBe(true);
  });

  it("社区 Profile 不能覆盖内置 ID，失败导入不会留下半个机型", () => {
    const override = example();
    override.materials[0]!.id = "PLA";
    expect(() => Profiles.importBundle(override, { persist: false })).toThrow(/不能覆盖/);
    expect(Profiles.machine("community-corexy-300")).toBeNull();
  });
});

describe("社区机器 / 材料注册与物理特征", () => {
  // 在前两组用例（内置数量 / 失败导入不留痕）跑完之后才真正导入
  let added: ReturnType<typeof Profiles.importBundle>;
  beforeAll(() => {
    added = Profiles.importBundle(example(), { persist: false });
  });

  it("导入 1 台机器 + 1 种材料，社区标记与运行时字段生成，价格同步到成本口径", () => {
    expect(added.machines).toHaveLength(1);
    expect(added.materials).toHaveLength(1);
    expect(added.machines[0]!.community).toBe(true);
    expect(added.materials[0]!.community).toBe(true);
    expect(added.materials[0]!.nozzleTemp).toBe(285);
    expect(added.materials[0]!.flowMm3s).toBe(7);
    expect(added.materials[0]!.priceCnyKg).toBe(239);
    expect(getCostProfile().material["PA-CF-example"]).toBe(23900);
    expect(getCostProfile().source).toMatch(/PA-CF-example/);
  });

  it("机器结构特征注册到物理模型；Profile 物理覆盖进入确定性机台且可复现", () => {
    const trait = MachineProfile.MODEL_TRAITS["CCX-300"];
    expect(trait?.enclosed).toBe(true);
    expect(trait?.buildMm).toBe(300);
    const physical = MachineProfile.of("CCX-300-01", added.machines[0]!.physics as Record<string, unknown>);
    expect(physical.heaterHealth).toBe(0.96);
    expect(MachineProfile.of("CCX-300-01").seed).toBe(physical.seed);
  });
});
