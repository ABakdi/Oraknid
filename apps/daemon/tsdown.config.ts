import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace packages are bundled in; real dependencies stay external.
  noExternal: [/^@oraknid\//],
});
