import { fileURLToPath } from "node:url";

/** The stand-in `agy` (tests only): its mode is read from $HOME/.fake-agy-mode. */
export const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
