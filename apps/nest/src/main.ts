#!/usr/bin/env node
import { join } from "node:path";
import { createNest } from "./relay.ts";

// The Nest's process: its daemons come from the environment
// (NEST_DAEMONS="id:secret,id2:secret2"), never from a file it writes.

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
if (daemons.size === 0) {
  console.error("NEST_DAEMONS is empty: no daemon could connect. Set it to id:secret pairs.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const nest = createNest({
  daemons,
  publicDir: join(import.meta.dirname, "..", "public"),
});
nest.server.listen(port, () =>
  console.log(`The Nest listening on :${port} for ${daemons.size} daemon(s)`),
);
const stop = () => void nest.close().then(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
