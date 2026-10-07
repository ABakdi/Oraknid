import { fileURLToPath } from "node:url";

/** The stand-in `codex` (tests only): its mode is read from $CODEX_HOME/.fake-codex-mode. */
export const FAKE_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
