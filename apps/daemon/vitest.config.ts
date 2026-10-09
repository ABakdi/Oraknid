import { defineConfig } from "vitest/config";

// The daemon's tests start whole daemons, sandboxes and fake servers: a
// first test pays for the start, more on a busy machine.
export default defineConfig({
  test: { globalSetup: ["../../vitest.tmp.ts"], testTimeout: 60_000 },
});
