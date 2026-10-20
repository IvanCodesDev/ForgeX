/* Stage 10.2：declare 字段规范的自动门禁本身也要有回归测试。
   规则实现在 config/eslint-rules/declare-virtual-init-fields.js（npm run lint 全仓生效），
   这里用 ESLint RuleTester 锁定它的判定边界：哪些写法必须报、哪些不能误报、自动修复长什么样。
   同时用真实机型源码做一次「活体」检查——printer3d.ts / printers.ts 必须零告警，
   而把 FXPrinterI3 的 declare 抠掉就必须被拦下。 */
import { describe, expect, it } from "vitest";
import { Linter, RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import rule from "../../../config/eslint-rules/declare-virtual-init-fields.js";
import printer3dSource from "./printer3d.ts?raw";
import printersSource from "./printers.ts?raw";

const languageOptions = {
  parser: tseslint.parser,
  ecmaVersion: 2022 as const,
  sourceType: "module" as const,
};

/** 与 config/eslint.config.js 中 TS 块的接线一致 */
function flatConfig(options?: { bases: string[] }): Linter.Config[] {
  return [
    {
      files: ["**/*.ts"],
      languageOptions,
      plugins: { forgex: { rules: { "declare-virtual-init-fields": rule } } },
      rules: { "forgex/declare-virtual-init-fields": options ? ["error", options] : "error" },
    },
  ];
}

describe("forgex/declare-virtual-init-fields（Stage 10.2 门禁）", () => {
  it("判定边界：extends FXPrinterBase 的实例字段必须 declare；static / abstract / 无关基类放行", () => {
    const tester = new RuleTester({ languageOptions });
    tester.run("declare-virtual-init-fields", rule, {
      valid: [
        // 现行四机型的写法
        `class FXPrinterCoreXY extends FXPrinterBase {
           declare beam: THREE.Group;
           declare TIP_DZ: number;
           declare protected screwPos: Array<[number, number]>;
           declare private _arms?: THREE.Mesh[][];
           protected _buildMachine(): void { this.TIP_DZ = 38; }
         }`,
        // 与受保护基类无关的类不受约束
        `class Widget extends Component { beam!: THREE.Group; count = 0; }`,
        `class Plain { beam!: THREE.Group; }`,
        // 静态字段 / abstract 字段不发射实例属性
        `class Registry extends FXPrinterBase { static list: string[] = []; }`,
        `abstract class Mid extends FXPrinterBase { abstract kind: string; }`,
        // 命名空间形式的基类同样识别
        `class Custom extends Engine.FXPrinterBase { declare beam: THREE.Group; }`,
        // 自定义基类清单
        {
          code: `class Foo extends OtherVirtualBase { declare x: number; }`,
          options: [{ bases: ["OtherVirtualBase"] }],
        },
        {
          code: `class Foo extends FXPrinterBase { x!: number; }`,
          options: [{ bases: ["OtherVirtualBase"] }],
        },
      ],
      invalid: [
        {
          // 确定赋值断言：加 declare 并去掉 `!`（declare 字段不允许 `!`）
          code: `class FXPrinterI3 extends FXPrinterBase { beam!: THREE.Group; }`,
          output: `class FXPrinterI3 extends FXPrinterBase { declare beam: THREE.Group; }`,
          errors: [{ messageId: "needDeclare", data: { cls: "FXPrinterI3", base: "FXPrinterBase", field: "beam" } }],
        },
        {
          code: `class A extends FXPrinterBase { protected screwPos: number[]; readonly TIP_DZ: number; }`,
          output: `class A extends FXPrinterBase { declare protected screwPos: number[]; declare readonly TIP_DZ: number; }`,
          errors: [
            { messageId: "needDeclare", data: { cls: "A", base: "FXPrinterBase", field: "screwPos" } },
            { messageId: "needDeclare", data: { cls: "A", base: "FXPrinterBase", field: "TIP_DZ" } },
          ],
        },
        {
          // 带初始值：会覆盖 _buildMachine 的赋值，不能自动修（初始化要搬进 _buildMachine）
          code: `class A extends FXPrinterBase { TIP_DZ = 0; }`,
          output: null,
          errors: [{ messageId: "noInitializer", data: { cls: "A", base: "FXPrinterBase", field: "TIP_DZ" } }],
        },
        {
          // override 等修饰符组合：只报不修
          code: `class A extends FXPrinterBase { override beam: THREE.Group; }`,
          output: null,
          errors: [{ messageId: "needDeclare" }],
        },
        {
          // 私有名字段在 super() 返回前不存在
          code: `class A extends FXPrinterBase { #arms: THREE.Mesh[][]; }`,
          output: null,
          errors: [{ messageId: "noPrivateName", data: { cls: "A", base: "FXPrinterBase", field: "#arms" } }],
        },
        {
          code: `const K = class extends Engine.FXPrinterBase { zGantry: THREE.Group; };`,
          output: `const K = class extends Engine.FXPrinterBase { declare zGantry: THREE.Group; };`,
          errors: [{ messageId: "needDeclare", data: { cls: "(匿名类)", base: "FXPrinterBase", field: "zGantry" } }],
        },
        {
          code: `class Foo extends OtherVirtualBase { x: number; }`,
          options: [{ bases: ["OtherVirtualBase"] }],
          output: `class Foo extends OtherVirtualBase { declare x: number; }`,
          errors: [{ messageId: "needDeclare" }],
        },
      ],
    });
  });

  it("活体检查：printer3d.ts / printers.ts 在该规则下零告警", () => {
    const linter = new Linter({ configType: "flat" });
    const config = flatConfig({ bases: ["FXPrinterBase"] });
    for (const [name, source] of [
      ["printer3d.ts", printer3dSource],
      ["printers.ts", printersSource],
    ] as const) {
      const messages = linter.verify(source, config, { filename: `frontend/src/engine/${name}` });
      expect(messages, name).toEqual([]);
    }
  });

  it("活体检查：把 FXPrinterI3 的 declare 去掉就会被拦下，且可自动修回", () => {
    const linter = new Linter({ configType: "flat" });
    const broken = printersSource.replace(
      "declare BED_Y: number;\n  declare zCarriage: THREE.Group;",
      "BED_Y!: number;\n  zCarriage!: THREE.Group;"
    );
    expect(broken).not.toBe(printersSource);
    const messages = linter.verify(broken, flatConfig(), { filename: "frontend/src/engine/printers.ts" });
    expect(messages.map((m) => m.ruleId)).toEqual([
      "forgex/declare-virtual-init-fields",
      "forgex/declare-virtual-init-fields",
    ]);
    expect(messages[0]!.message).toContain(
      "「FXPrinterI3」继承 FXPrinterBase，其字段「BED_Y」必须写成 `declare BED_Y`"
    );
    expect(messages[1]!.message).toContain("「zCarriage」");
    const fixed = linter.verifyAndFix(broken, flatConfig(), { filename: "frontend/src/engine/printers.ts" });
    expect(fixed.fixed).toBe(true);
    expect(fixed.output).toBe(printersSource);
  });
});
