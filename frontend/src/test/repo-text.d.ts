/* 由 ../../test-plugins/repo-text.ts 在 vitest 里提供：仓库相对路径 → 文本，
   供 classic 退役门禁扫描；浏览器构建不会引用它。 */
declare module "virtual:forgex-repo-text" {
  const files: Readonly<Record<string, string>>;
  export default files;
}
