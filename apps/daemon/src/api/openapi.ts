import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { VERSION } from "../version.ts";
import { router } from "./router.ts";

// The OpenAPI document of every procedure (ADR-010, ADR-058), generated from
// the oRPC router and its Zod contracts: served at GET /api/openapi.json
// (paired devices only, like every /api call) and written to
// docs/02-Architecture/openapi.json by `pnpm --filter @oraknid/daemon openapi`.

const DESCRIPTION = `Oraknid's API: every procedure's input and output, from the contracts in packages/contracts.
The wire is oRPC's RPC protocol: POST /api/<path> with the body {"json": <input>} (a procedure without input takes {}), answered with {"json": <output>}; an error is {"json": {"code", "status", "message", "data"}}.
Every call carries a paired device's token (Authorization: Bearer <token>) and, when the app lock is on, the unlock session (x-oraknid-unlock). Realtime events come on the /live WebSocket, not here.`;

let made: Promise<Record<string, unknown>> | null = null;

/** The document (made once, then kept). */
export function openApiDocument(): Promise<Record<string, unknown>> {
  made ??= new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
    .generate(router, {
      info: { title: "Oraknid", version: VERSION, description: DESCRIPTION },
      servers: [{ url: "/api" }],
    })
    .then((doc) => doc as unknown as Record<string, unknown>);
  return made;
}

/** The document as written to the canon: stable, two-space JSON and a final newline. */
export async function openApiText(): Promise<string> {
  return `${JSON.stringify(await openApiDocument(), null, 2)}\n`;
}
