/* Stage 7.4 删除动作门禁：frontend/classic 零引用核验。
   手册 §5 要求「删除 classic 的 PR 必须附 grep 零引用证明」——这里把 grep 固化成可执行断言：
   1. React 侧（frontend/src、index.html、vite/vitest 配置、package.json）对 classic 目录零引用，现在就必须成立；
   2. 设计系统 CSS 由 React 持有（frontend/design-system/）；classic 存在期间与 classic/css 逐字节一致（双向防漂移）；
   3. 仓库其余部分（根 index.html / server / tools / tests / deploy / config / backend / CI）的引用清单：
      classic 存在期间只汇报（供 7.4 执行者逐项清理，不阻断 8.6d 进行中的 server 改造）；
      classic 一旦删除，清单必须为空——否则删除 PR 不得合入。
   文本由 vitest 插件 test-plugins/repo-text.ts 一次读入（范围与排除规则见该文件）。 */
import { describe, expect, it } from "vitest";
import repo from "virtual:forgex-repo-text";

/* ── 引用模式 ─────────────────────────────────────────────── */

/** 路径形式的 classic 引用：frontend/classic、classic/js、classic/css、path.join 分段写法（"frontend", "classic"）。
    不匹配散文里的 classic 一词（如注释「与 classic 版逐位对齐」）。 */
const CLASSIC_PATH = /frontend[\\/]+classic|\bclassic[\\/]+(?:js|css)\b|"frontend",\s*"classic"/;

/** /legacy 路由（经典入口的服务路径）。前面是 . 或单词字符时不算（TS 模块 src/legacy/engine 的相对导入）。 */
const LEGACY_ROUTE = /(?<![\w.])\/legacy(?![\w-])/;

/** 代码里写明「随 Stage 7.4 一并移除」的墓碑（如 server/index.js 与 PublicFacade.cs 的 classic 启动探测端点）。 */
const TOMBSTONE = /Stage 7\.4/;

/* ── 范围划分 ─────────────────────────────────────────────── */

const SELF = "frontend/src/test/classic-retirement-gate.test.ts";

const REACT_SIDE_FILES = [
  "frontend/index.html",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "frontend/vitest.config.ts",
  "frontend/tsconfig.json",
  "frontend/tsconfig.app.json",
  "frontend/tsconfig.node.json",
];

function isReactSide(file: string): boolean {
  return (file.startsWith("frontend/src/") && file !== SELF) || REACT_SIDE_FILES.includes(file);
}

function isRepoRest(file: string): boolean {
  return !file.startsWith("frontend/");
}

const pick = (keep: (file: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(repo).filter(([file]) => keep(file)));

const REACT_SIDE = pick(isReactSide);
const REPO_REST = pick(isRepoRest);
const REACT_STYLES = pick((file) => file.startsWith("frontend/design-system/") && file.endsWith(".css"));
const CLASSIC_CSS = pick((file) => file.startsWith("frontend/classic/css/") && file.endsWith(".css"));
const classicPresent = Object.keys(CLASSIC_CSS).length > 0;

/* ── 工具 ─────────────────────────────────────────────────── */

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(files: Record<string, string>, patterns: readonly RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of Object.keys(files).sort()) {
    (files[file] ?? "").split(/\r?\n/).forEach((text, index) => {
      if (patterns.some((pattern) => pattern.test(text))) {
        hits.push({ file, line: index + 1, text: text.trim().slice(0, 160) });
      }
    });
  }
  return hits;
}

function owner(file: string): string {
  if (file === "index.html") return "classic 入口（根 index.html）";
  const [top = "", second = ""] = file.split("/");
  if (top === "tests") return second === "e2e" ? "tests/e2e" : "tests（Node 根测试）";
  if (top === ".github") return "CI";
  return top;
}

function summarize(hits: readonly Hit[]): string {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(owner(hit.file), (counts.get(owner(hit.file)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

function format(hits: readonly Hit[]): string {
  return hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join("\n");
}

const fileName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

/* ── 断言 ─────────────────────────────────────────────────── */

describe("Stage 7.4 删除门禁：frontend/classic 零引用核验", () => {
  it("React 侧（frontend/src · index.html · vite/vitest 配置 · package.json）对 frontend/classic 零引用", () => {
    const scanned = Object.keys(REACT_SIDE);
    expect(scanned.length).toBeGreaterThan(60);
    for (const file of REACT_SIDE_FILES) expect(scanned).toContain(file);
    expect(scanned).toContain("frontend/src/main.tsx");

    const hits = scan(REACT_SIDE, [CLASSIC_PATH]);
    expect(hits, "React 侧不得引用 frontend/classic：\n" + format(hits)).toEqual([]);
  });

  it("设计系统 CSS 由 React 持有：vite.config 只读 frontend/design-system，副本无 BOM 且保留 tokens 同级导入", () => {
    const viteConfig = repo["frontend/vite.config.ts"] ?? "";
    expect(viteConfig).toContain('source: "./design-system/style.css"');
    expect(viteConfig).toContain('source: "./design-system/tokens.css"');
    expect(viteConfig).not.toMatch(CLASSIC_PATH);

    expect(Object.keys(REACT_STYLES).map(fileName).sort()).toEqual(["style.css", "tokens.css"]);
    for (const [file, text] of Object.entries(REACT_STYLES)) {
      expect(text.length, `${file} 读到空文本`).toBeGreaterThan(0);
      // 7.2 教训：style.css 带 BOM 会让离线单文件内联后的设计令牌整体失效
      expect(text.charCodeAt(0), `${file} 不得带 UTF-8 BOM`).not.toBe(0xfeff);
    }
    expect(repo["frontend/design-system/style.css"]).toContain('@import url("./tokens.css")');
  });

  it("classic 存在期间：frontend/design-system 与 frontend/classic/css 逐字节一致；classic 删除后 classic/css 必须已不存在", () => {
    if (!classicPresent) {
      expect(Object.keys(repo).filter((file) => file.startsWith("frontend/classic/"))).toEqual([]);
      return;
    }
    const classicNames = Object.keys(CLASSIC_CSS).map(fileName).sort();
    const reactNames = Object.keys(REACT_STYLES).map(fileName).sort();
    expect(classicNames, "两侧文件集合必须相同（classic 冻结期任何 CSS 改动需同时落到两处）").toEqual(reactNames);
    for (const name of classicNames) {
      const classic = repo[`frontend/classic/css/${name}`] ?? "";
      const react = repo[`frontend/design-system/${name}`] ?? "";
      expect(classic.length, `${name} 读到空文本`).toBeGreaterThan(0);
      expect(
        react === classic,
        `${name} 两侧内容不一致：改动必须同时应用到 frontend/design-system 与 frontend/classic/css`
      ).toBe(true);
    }
  });

  it("仓库其余部分的 classic 引用清单：classic 存在期间汇报，删除后必须为空", () => {
    const scanned = Object.keys(REPO_REST);
    expect(scanned).toContain("package.json");
    for (const prefix of ["tools/", "tests/", "backend/src/", "deploy/", "config/", ".github/workflows/"]) {
      expect(
        scanned.some((file) => file.startsWith(prefix)),
        `扫描范围应覆盖 ${prefix}（test-plugins/repo-text.ts 未读到任何文件）`
      ).toBe(true);
    }

    const hits = scan(REPO_REST, [CLASSIC_PATH, LEGACY_ROUTE, TOMBSTONE]);
    if (classicPresent) {
      console.info(
        `[classic-retirement-gate] frontend/classic 仍在；仓库其余部分引用 ${hits.length} 处（${summarize(hits)}）。` +
          " 删除 classic 时这些必须清零，逐行清单见 optimization/stage7-classic-retirement/classic-zero-ref-gate.md"
      );
      return;
    }
    expect(
      hits,
      "frontend/classic 已删除，但以下引用仍悬空（含 /legacy 路由与「Stage 7.4」墓碑），删除 PR 不得合入：\n" +
        format(hits)
    ).toEqual([]);
  });
});
