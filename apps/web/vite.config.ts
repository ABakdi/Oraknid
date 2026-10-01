import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The daemon serves dist/ (Architecture-Overview); in development Vite proxies to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7417",
      "/live": { target: "ws://127.0.0.1:7417", ws: true },
    },
  },
  build: {
    // The graph and the charts are heavy and change rarely: their own chunks, cached apart from the app.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xyflow") || id.includes("elkjs")) return "graph";
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
  test: { environment: "jsdom" },
});
