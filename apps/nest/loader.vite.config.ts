import { defineConfig } from "vite";

// The loader The Nest serves (Nest-Protocol): built into public/.
export default defineConfig({
  root: "loader",
  build: { outDir: "../public", emptyOutDir: true },
});
