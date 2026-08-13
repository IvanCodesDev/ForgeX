/* 检查 vendor three.min.js 的版本与光照模式（node tests/check-three.js） */
const fs = require("fs");
const path = require("path");
const s = fs.readFileSync(path.join(__dirname, "..", "frontend", "classic", "js", "vendor", "three.min.js"), "utf8");
const m = s.match(/REVISION\s*=\s*["']?(\w+)/);
console.log("REVISION:", m && m[1]);
console.log("has useLegacyLights:", s.includes("useLegacyLights"));
console.log("has physicallyCorrectLights:", s.includes("physicallyCorrectLights"));
console.log("file KB:", (s.length / 1024).toFixed(0));
