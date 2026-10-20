import { defineConfig } from "vitest/config";
import { repoTextPlugin } from "./test-plugins/repo-text.ts";

export default defineConfig({
  plugins: [repoTextPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
