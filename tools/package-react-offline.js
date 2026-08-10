/* 将 Vite 的 offline 单入口产物打包成可直接打开的单 HTML 文件。 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "react-offline");
const INDEX = path.join(DIST, "index.html");
const OUTPUT = path.join(DIST, "FORGE-X-React-Offline.html");

function resolveAsset(reference) {
  const clean = reference.replace(/^\.\//, "").replace(/^\//, "");
  const absolute = path.resolve(DIST, clean);
  const relative = path.relative(DIST, absolute);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("离线资产路径越界: " + reference);
  }
  return absolute;
}

let html = fs.readFileSync(INDEX, "utf8");
html = html.replace(
  /<link\s+rel="stylesheet"\s+crossorigin\s+href="([^"]+)"\s*\/?>(?:\r?\n)?/g,
  (_match, reference) => `<style>\n${fs.readFileSync(resolveAsset(reference), "utf8")}\n</style>\n`
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
