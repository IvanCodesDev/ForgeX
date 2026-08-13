/* 交叉校验：ui.js / insight.js / main.js 引用的 DOM id 必须在 index.html 中存在，
   或由 JS 动态创建（`.id = "xxx"` 赋值）。（node tests/check-refs.js） */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

const js = ["frontend/classic/js/ui.js", "frontend/classic/js/insight.js", "frontend/classic/js/main.js"]
  .map((f) => fs.readFileSync(path.join(root, f), "utf8"))
  .join("\n");

// JS 动态赋予的 id 也算已知（如导航胶囊 pill-insight）
for (const m of js.matchAll(/\.id = "([a-zA-Z0-9_-]+)"/g)) ids.add(m[1]);

const refs = new Set(
  [...js.matchAll(/\$\("#([a-zA-Z0-9_-]+)/g)].map((m) => m[1])
    .concat([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]))
);

const missing = [...refs].filter((r) => !ids.has(r));
console.log(`HTML ids: ${ids.size} | JS id refs: ${refs.size}`);
if (missing.length) {
  console.log("MISSING:", missing.join(", "));
  process.exit(1);
}
console.log("ALL REFS OK");
