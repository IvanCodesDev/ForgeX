/* 项目自有 ESLint 规则是 Node CommonJS（config/eslint-rules/*.js，allowJs 关闭），
   前端测试要对其做 RuleTester 回归，这里补上类型声明。 */
declare module "*/eslint-rules/declare-virtual-init-fields.js" {
  import type { Rule } from "eslint";
  const rule: Rule.RuleModule;
  export default rule;
}
