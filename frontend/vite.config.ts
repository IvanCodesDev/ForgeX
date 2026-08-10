import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const offline = mode === "offline";
  return {
    base: offline ? "./" : mode === "production" ? "/react/" : "./",
    plugins: [react()],
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
