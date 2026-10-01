import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace packages are bundled in. Every third-party package stays
  // external and is a dependency of this package, so native addons
  // (better-sqlite3, the keyring) load from node_modules as built.
  noExternal: [/^@oraknid\//],
  external: [/^[^./@]/, /^@(?!oraknid\/)/],
});
