#!/usr/bin/env node
import { join } from "node:path";
import { createNest } from "./relay.ts";

// The Nest's process: its own daemons come from the environment
// (NEST_DAEMONS="id:secret,id2:secret2"). A public Nest (NEST_MODE=public,
// ADR-031) also takes daemons that register themselves, kept in
// NEST_DATA_DIR; NEST_INVITE makes registering need that code.

const mode = process.env.NEST_MODE ?? "private";
if (mode !== "private" && mode !== "public") {
  console.error(`NEST_MODE is "${mode}": set it to private or public.`);
  process.exit(1);
}
const daemons = new Map(
  (process.env.NEST_DAEMONS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      return [p.slice(0, i), p.slice(i + 1)] as [string, string];
    }),
);
// A daemon's secret is what keeps others from posing as it: long, or refused (Audit 2).
for (const [id, secret] of daemons)
  if (!id || secret.length < 32) {
    console.error(`NEST_DAEMONS: "${id}" needs an id and a secret of 32 characters or more.`);
    process.exit(1);
  }
if (daemons.size === 0 && mode === "private") {
  console.error("NEST_DAEMONS is empty: no daemon could connect. Set it to id:secret pairs.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const nest = createNest({
  daemons,
  mode,
  invite: process.env.NEST_INVITE || undefined,
  dataDir: process.env.NEST_DATA_DIR || join(process.cwd(), "data"),
  publicDir: join(import.meta.dirname, "..", "public"),
});
nest.server.listen(port, () =>
  console.log(
    mode === "public"
      ? `The Nest (public) listening on :${port}, with ${daemons.size} daemon(s) of its own`
      : `The Nest listening on :${port} for ${daemons.size} daemon(s)`,
  ),
);
const stop = () => void nest.close().then(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
