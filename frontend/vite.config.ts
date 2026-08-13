import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/* 旧入口的原始资产按字节供给，不进打包管线。
   落在 assets/ 下是因为服务端静态 allowlist 只放行 /react/assets/，见 server/lib/http.js。 */
const LEGACY_ASSETS = [
  {
    /* 设计系统原样复用。交给打包器压缩会按构建目标重写厂商前缀，
       实测 .pill-card 的标准 backdrop-filter 会被删成只剩 -webkit-，
       Firefox 只认标准属性，毛玻璃将整体失效。 */
    source: "../css/style.css",
    asset: "assets/style.css",
    type: "text/css; charset=utf-8",
  },
  {
    source: "../css/tokens.css",
    asset: "assets/tokens.css",
    type: "text/css; charset=utf-8",
  },
] as const;

function legacyAssets(): Plugin {
  const resolve = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  return {
    name: "forgex:legacy-assets",
    configureServer(server) {
      for (const entry of LEGACY_ASSETS) {
        server.middlewares.use("/" + entry.asset, (_req, res) => {
          res.setHeader("Content-Type", entry.type);
          res.end(readFileSync(resolve(entry.source)));
        });
      }
    },
    generateBundle() {
      for (const entry of LEGACY_ASSETS) {
        this.emitFile({ type: "asset", fileName: entry.asset, source: readFileSync(resolve(entry.source)) });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const offline = mode === "offline";
  return {
    base: offline ? "./" : mode === "production" ? "/react/" : "./",
    plugins: [react(), legacyAssets()],
    build: {
      outDir: offline ? "../dist/react-offline" : "../dist/react",
      emptyOutDir: true,
      sourcemap: mode === "development",
      ...(offline ? { rolldownOptions: { output: { codeSplitting: false } } } : {}),
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api/v1/gcode": "http://127.0.0.1:8787",
        "/api": "http://127.0.0.1:8787",
        "/healthz": "http://127.0.0.1:8787",
        "/metrics": "http://127.0.0.1:8787",
      },
    },
  };
});
