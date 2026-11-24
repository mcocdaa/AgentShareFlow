import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const proxyTarget = env.VITE_PROXY_TARGET || "http://localhost:8787";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": proxyTarget,
        "/healthz": proxyTarget,
        "/ws": {
          target: proxyTarget,
          ws: true,
        },
      },
    },
    preview: {
      port: 5173,
    },
  };
});
