import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the UI talks to the backend through this proxy.
// HARNESS_BACKEND_URL overrides the default backend address.
const backend = process.env.HARNESS_BACKEND_URL ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@harness/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: backend,
        configure: (proxy) => {
          // When the backend stops mid-response (a restart), close the
          // browser's side too. Otherwise an open event stream hangs silently
          // and the page never reconnects.
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
    },
  },
});
