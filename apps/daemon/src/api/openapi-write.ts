import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiText } from "./openapi.ts";

// Writes the OpenAPI document into the canon (ADR-058):
//   pnpm --filter @oraknid/daemon openapi           writes docs/02-Architecture/openapi.json
//   pnpm --filter @oraknid/daemon openapi --check   fails when it isn't the current one (CI)

const target = fileURLToPath(
  new URL("../../../../docs/02-Architecture/openapi.json", import.meta.url),
);
const text = await openApiText();
let before = "";
try {
  before = readFileSync(target, "utf8");
} catch {
  before = "";
}
if (process.argv.includes("--check")) {
  if (before !== text) {
    console.error(
      "docs/02-Architecture/openapi.json isn't the router's: run `pnpm --filter @oraknid/daemon openapi` and commit it.",
    );
    process.exit(1);
  }
  console.log("openapi.json is current.");
} else if (before !== text) {
  writeFileSync(target, text);
  console.log(`Wrote ${target}.`);
} else console.log("openapi.json is current.");
