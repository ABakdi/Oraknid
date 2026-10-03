import { defineConfig } from "vitest/config";

// The contract kit runs here against the real `opencode` binary: starting it
// takes a few seconds, more on a busy machine, past vitest's 5 s default.
export default defineConfig({
  test: { globalSetup: ["../../../vitest.tmp.ts"], testTimeout: 30_000 },
});
