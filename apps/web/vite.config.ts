import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

function versionedServiceWorker() {
  const buildVersion = `${Date.now()}`;
  return {
    name: "corptie-versioned-service-worker",
    apply: "build" as const,
    generateBundle(this: { emitFile: (asset: {
      type: "asset";
      fileName: string;
      source: string;
    }) => void }) {
      const template = readFileSync(
        new URL("./src/lib/pwa/sw-template.js", import.meta.url),
        "utf8"
      );
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replaceAll("__CORPTIE_BUILD_VERSION__", buildVersion)
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), versionedServiceWorker()],
  build: {
    sourcemap: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:47324",
      "/pair": "http://127.0.0.1:47324"
    }
  }
});
