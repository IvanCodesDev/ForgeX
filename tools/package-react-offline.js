/* 将 Vite 的 offline 单入口产物打包成可直接打开的单 HTML 文件。 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "react-offline");
const INDEX = path.join(DIST, "index.html");
const OUTPUT = path.join(DIST, "FORGE-X-React-Offline.html");

function resolveAsset(reference, baseDir) {
  const clean = reference.replace(/^\.\//, "").replace(/^\//, "");
  const absolute = path.resolve(baseDir || DIST, clean);
  const relative = path.relative(DIST, absolute);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("离线资产路径越界: " + reference);
  }
  return absolute;
}

/* 经典设计系统的 style.css 通过 @import 引 tokens.css；
   内联进单 HTML 后相对导入会悬空，必须递归展开。 */
function readCssInlined(cssPath) {
  const css = fs.readFileSync(cssPath, "utf8");
  return css.replace(/@import\s+url\("([^"]+)"\);?/g, (_match, reference) =>
    readCssInlined(resolveAsset(reference, path.dirname(cssPath)))
  );
}

let html = fs.readFileSync(INDEX, "utf8");
// crossorigin 可选：Vite 生成的样式链接带该属性，手写的 legacy 设计系统链接不带。
html = html.replace(
  /<link\s+rel="stylesheet"(?:\s+crossorigin)?\s+href="([^"]+)"\s*\/?>(?:\r?\n)?/g,
  (_match, reference) => `<style>\n${readCssInlined(resolveAsset(reference))}\n</style>\n`
);
html = html.replace(
  /<script\s+type="module"\s+crossorigin\s+src="([^"]+)"\s*><\/script>/g,
  (_match, reference) => `<script type="module">\n${fs.readFileSync(resolveAsset(reference), "utf8")}\n</script>`
);

if (/<script[^>]+src=|<link[^>]+rel="stylesheet"/i.test(html)) {
  throw new Error("离线包仍包含外部脚本或样式引用");
}
if (/\/assets\//.test(html)) throw new Error("离线包仍包含绝对 assets 引用");

fs.writeFileSync(OUTPUT, html, "utf8");
console.log(`Offline React artifact: ${path.relative(ROOT, OUTPUT)} (${Buffer.byteLength(html)} bytes)`);
