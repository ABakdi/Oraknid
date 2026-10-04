import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vitest/config";

// The daemon serves dist/ (Architecture-Overview); in development Vite proxies to it.
// `--mode remote` builds the UI for away from home: one self-contained page in
// dist-remote/, which the daemon sends through the Nest tunnel (Nest-Protocol).
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "remote" ? [viteSingleFile()] : [])],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7417",
      "/live": { target: "ws://127.0.0.1:7417", ws: true },
    },
  },
  build:
    mode === "remote"
      ? { outDir: "dist-remote", emptyOutDir: true }
      : {
          // The graph and the charts are heavy and change rarely: their own chunks, cached apart from the app.
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (id.includes("@xyflow") || id.includes("elkjs")) return "graph";
                if (id.includes("recharts") || id.includes("d3-")) return "charts";
                // Syntax colouring is loaded when a file is opened in Repos.
                if (id.includes("highlight.js")) return "highlight";
                if (id.includes("node_modules")) return "vendor";
                return undefined;
              },
            },
          },
        },
  // Rendering whole pages under jsdom takes seconds when every package tests at once.
  test: { environment: "jsdom", globalSetup: ["../../vitest.tmp.ts"], testTimeout: 20_000 },
}));
