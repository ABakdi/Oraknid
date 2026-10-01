import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  noExternal: [/^@oraknid\//],
  external: [/^[^./@]/, /^@(?!oraknid\/)/],
});
