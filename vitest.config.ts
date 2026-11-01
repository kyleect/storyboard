import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@harness/core/testing": fileURLToPath(
        new URL("./packages/core/src/testing.ts", import.meta.url),
      ),
      "@harness/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@harness/tools": fileURLToPath(
        new URL("./packages/tools/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["packages/*/src/**/*.test.ts"] },
      },
      // The frontend's tests run in jsdom (approval notes design, D15).
      {
        extends: true,
        test: {
          name: "frontend",
          include: ["packages/frontend/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["packages/frontend/src/test-setup.ts"],
        },
      },
    ],
  },
});
