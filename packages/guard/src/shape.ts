import { initParser, type Part, parseCommand, parserReady } from "./parse.ts";

// "Approve all like this for this job", at the careful level (ADR-053):
// matched on the parsed command's shape, not its text. The shape keeps
// where each part runs, its program, its subcommands and its flags; it
// drops paths, names and values, so `ssh -F a s1 'docker compose -p x
// restart web'` and the same with `api` in place of `web` are alike.

/** Programs whose first words are subcommands. */
const SUBCOMMANDS: Record<string, number> = {
  git: 1,
  docker: 2,
  podman: 2,
  "docker-compose": 1,
  kubectl: 1,
  helm: 1,
  npm: 1,
  pnpm: 1,
  yarn: 1,
  bun: 1,
  cargo: 1,
  go: 1,
  gh: 2,
  glab: 2,
  systemctl: 1,
  apt: 1,
  "apt-get": 1,
  terraform: 1,
  aws: 2,
  gcloud: 3,
  az: 2,
  pm2: 1,
  uv: 1,
  poetry: 1,
  make: 9,
};

/** Options that take a value, per program (the value is dropped with them). */
const WITH_VALUE: Record<string, RegExp> = {
  git: /^(-C|-c|--git-dir|--work-tree)$/,
  docker:
    /^(-p|-f|--file|--project-name|--project-directory|-H|--host|--context|--env-file|--profile)$/,
  podman: /^(-p|-f|--file|--project-name|-H|--host)$/,
  "docker-compose": /^(-p|-f|--file|--project-name)$/,
  kubectl: /^(-n|--namespace|--context|-l|--selector|-o|--output|-f|--filename)$/,
  pnpm: /^(--filter|-F|-C|--dir)$/,
  npm: /^(-w|--workspace|--prefix)$/,
  systemctl: /^(-n|--lines|-p|--property)$/,
  journalctl: /^(-u|--unit|-n|--lines|--since|--until|-p)$/,
};

function partShape(p: Part): string {
  const depth = SUBCOMMANDS[p.program] ?? 0;
  const valued = WITH_VALUE[p.program];
  const subs: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < p.args.length; i++) {
    const a = p.args[i] as string;
    if (a.startsWith("-") && a !== "-") {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      flags.add(name);
      if (valued?.test(a)) i++;
      continue;
    }
    if (subs.length < depth && /^[a-z][\w:.-]*$/i.test(a) && !a.includes("/")) subs.push(a);
  }
  const where = p.host ? `${p.host}: ` : "";
  return `${where}${[p.program, ...subs].join(" ")}${flags.size ? ` ${[...flags].sort().join(" ")}` : ""}`;
}

/** The shape of a command, or null when it can't be read for sure. */
export async function shapeOf(command: string): Promise<string | null> {
  if (!parserReady()) await initParser();
  const parsed = parseCommand(command);
  if (parsed.error || !parsed.parts.length || parsed.parts.some((p) => !p.literal)) return null;
  return parsed.parts
    .filter((p) => p.program !== "cd")
    .map(partShape)
    .join(" ; ");
}

/** The allow rule that holds a shape in a job's rules (Approvals → approve all like this). */
export const SHAPE_RULE = "shape:";
export const shapeRule = (shape: string) => `${SHAPE_RULE}${shape}`;
export const isShapeRule = (rule: string) => rule.startsWith(SHAPE_RULE);
