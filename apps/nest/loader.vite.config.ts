import { defineConfig } from "vite";

// The loader The Nest serves (Nest-Protocol) under /app/: the product site
// (apps/site) has the root (ADR-033).
export default defineConfig({
  root: "loader",
  base: "/app/",
  build: { outDir: "../public/app", emptyOutDir: true },
});
