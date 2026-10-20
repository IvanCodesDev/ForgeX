/* forgex/declare-virtual-init-fields —— Stage 10.2「declare 字段规范」自动门禁。

   背景（优化开发手册 §7.2 / 决策表 2026-08-23）：FXPrinterBase 的构造函数会虚调用子类的
   _buildMachine()，子类在其中给 beam / TIP_DZ / zCarriage / _arms 等字段赋值。
   tsconfig 开着 useDefineForClassFields（ES2022 语义）：子类若把这些字段写成普通类字段，
   super() 返回后会被重新 [[Define]] 成 undefined / 初始值，把构建期状态全部抹掉——
   表现为切换机型即崩、喷头 TIP_DZ 错位、Delta 并联臂断线（四机型事故）。

   规则：凡 extends 受保护基类（默认 FXPrinterBase）的类，其实例字段一律必须 `declare`，
   真实赋值放在 _buildMachine() 内。静态字段 / abstract 字段不发射运行时属性，放行。
   基类清单通过 options[0].bases 配置，未来出现同类「构造期虚调用」基类时在此登记即可。 */
"use strict";

const ACCESSIBILITY_ONLY = /^(?:public|protected|private|readonly|\s)*$/;

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "子类字段在基类构造期虚调用中赋值时必须用 declare 声明，否则会被 ES2022 类字段初始化抹掉",
    },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          bases: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      needDeclare:
        "「{{cls}}」继承 {{base}}，其字段「{{field}}」必须写成 `declare {{field}}`：" +
        "基类构造期会虚调用 _buildMachine() 给它赋值，普通类字段会在 super() 返回后被重新初始化为 undefined（2026-08-23 四机型事故）。",
      noInitializer:
        "「{{cls}}」继承 {{base}}，其字段「{{field}}」带初始值：该初始值会在 super() 返回后覆盖 _buildMachine() 里的赋值。" +
        "请改为 `declare {{field}}` 并把初始化移入 _buildMachine()。",
      noPrivateName:
        "「{{cls}}」继承 {{base}}，其私有名字段「{{field}}」在 super() 返回前不存在，_buildMachine() 内对它赋值会抛 TypeError；" +
        "请改用 `declare private` 的普通字段。",
    },
  },

  create(context) {
    const opts = context.options[0] || {};
    const bases = new Set(opts.bases || ["FXPrinterBase"]);
    const sourceCode = context.sourceCode || context.getSourceCode();

    function baseName(node) {
      const sup = node.superClass;
      if (!sup) return null;
      if (sup.type === "Identifier") return bases.has(sup.name) ? sup.name : null;
      // 允许 `Ns.FXPrinterBase` 形式
      if (sup.type === "MemberExpression" && sup.property.type === "Identifier")
        return bases.has(sup.property.name) ? sup.property.name : null;
      return null;
    }

    function fieldName(member) {
      const key = member.key;
      if (key.type === "Identifier") return key.name;
      if (key.type === "PrivateIdentifier") return "#" + key.name;
      if (key.type === "Literal") return String(key.value);
      return sourceCode.getText(key);
    }

    function checkClass(node) {
      const base = baseName(node);
      if (!base) return;
      const cls = node.id ? node.id.name : "(匿名类)";
      for (const member of node.body.body) {
        if (member.type !== "PropertyDefinition") continue;
        if (member.declare || member.static || member.abstract) continue;
        const field = fieldName(member);
        if (member.key.type === "PrivateIdentifier") {
          context.report({ node: member, messageId: "noPrivateName", data: { cls, base, field } });
          continue;
        }
        if (member.value) {
          context.report({ node: member, messageId: "noInitializer", data: { cls, base, field } });
          continue;
        }
        // 仅在修饰符只有可访问性/readonly 时提供自动修复（override/accessor/装饰器等组合交给人工处理）
        const keyStart = sourceCode.getIndexFromLoc(member.key.loc.start);
        const prefix = sourceCode.text.slice(member.range[0], keyStart);
        const fixable = ACCESSIBILITY_ONLY.test(prefix);
        context.report({
          node: member,
          messageId: "needDeclare",
          data: { cls, base, field },
          fix: fixable
            ? (fixer) => {
                const fixes = [fixer.insertTextBeforeRange(member.range, "declare ")];
                // `declare` 字段不允许带确定赋值断言 `!`（TS1255），一并去掉
                const bang = sourceCode.getTokenAfter(member.key);
                if (member.definite && bang && bang.value === "!") fixes.push(fixer.remove(bang));
                return fixes;
              }
            : null,
        });
      }
    }

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
};
