/* vitest 插件：把仓库里的源码/配置文本按「仓库相对路径 → 文本」打包成一个虚拟模块，
   供 src/test/classic-retirement-gate.test.ts 做 classic 零引用核验。
   之所以不用 import.meta.glob(?raw)：那会把两三百个文件各自走一遍模块管线，整套 vitest 从 1.5 s 拖到 6 s；
   这里在 Node 侧一次性读完，测试端只导入一个模块。范围与排除规则集中在此，前端 tsconfig 不需要 Node 类型。 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const REPO_TEXT_ID = "virtual:forgex-repo-text";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 扫描入口（仓库相对路径）：文件直接读取，目录递归。 */
const ROOTS = [
  "index.html",
  "package.json",
  "render.yaml",
  "server",
  "tools",
  "tests",
  "deploy",
  "config",
  "backend/src",
  "backend/tests",
  ".github/workflows",
  "frontend/index.html",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "frontend/vitest.config.ts",
  "frontend/tsconfig.json",
  "frontend/tsconfig.app.json",
  "frontend/tsconfig.node.json",
  "frontend/src",
  "frontend/design-system",
  "frontend/classic/css",
  "frontend/test-plugins",
];

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".yml",
  ".yaml",
  ".cs",
  ".csproj",
  ".html",
  ".css",
  ".sh",
  ".ps1",
  ".ignore",
]);

const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", "coverage", "test-results", "screenshots"]);
const MAX_BYTES = 512 * 1024;

function isTextFile(file: string): boolean {
  const base = path.basename(file);
  return base.startsWith("Dockerfile") || TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function walk(absolute: string, out: string[]): void {
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return; // 入口不存在（例如 classic 已删除、server/ 已退场）就跳过，由测试自行判断
  }
  if (stat.isFile()) {
    if (isTextFile(absolute) && stat.size <= MAX_BYTES) out.push(absolute);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".tmp-")) continue;
      walk(path.join(absolute, entry.name), out);
    } else if (entry.isFile()) {
      const file = path.join(absolute, entry.name);
      if (isTextFile(file) && statSync(file).size <= MAX_BYTES) out.push(file);
    }
  }
}

export function collectRepoText(): Record<string, string> {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files);
  const out: Record<string, string> = {};
  for (const file of files.sort()) {
    out[path.relative(REPO_ROOT, file).split(path.sep).join("/")] = readFileSync(file, "utf8");
  }
  return out;
}

export function repoTextPlugin(): Plugin {
  const resolved = "\0" + REPO_TEXT_ID;
  return {
    name: "forgex:repo-text",
    resolveId(id) {
      return id === REPO_TEXT_ID ? resolved : null;
    },
    load(id) {
      if (id !== resolved) return null;
      return `export default ${JSON.stringify(collectRepoText())};`;
    },
  };
}
