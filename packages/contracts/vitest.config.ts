import { defineConfig } from "vitest/config";

export default defineConfig({ test: { globalSetup: ["../../vitest.tmp.ts"] } });
