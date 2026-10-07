import { posix } from "node:path";
import { isSensitivePath, LOCKFILES } from "@oraknid/contracts";
import { initParser, type Parsed, type Part, parseCommand, parserReady } from "./parse.ts";
import { readsOnlyProgram, urlHosts } from "./readonly.ts";
import { safetyNet } from "./safety-net.ts";
import { NETWORK, secretByPattern, secretBySecretlint } from "./secrets.ts";

// Layer 1 of auto mode (ADR-053): rules that settle most commands at once.
// Block what is known to be dangerous (CC Safety Net, its cloud rulebooks,
// our own rules for its gaps, secrets going out); allow what only reads,
// edits inside the job's folder, or is the project's own build, test or
// lint command; ask the owner for a change on a production server; leave
// the rest to the judge.

export interface GuardServer {
  alias: string;
  name: string;
  production: boolean;
}

export interface GuardContext {
  /** The job's folder: the command's working directory. */
  workspace: string;
  /** Places private to the job's sandbox (its /tmp, its home for the job). */
  scratch?: string[];
  /** HOME inside the sandbox, for `~`. */
  home?: string;
  /** The job's servers, by the alias its commands use (ADR-049). */
  servers?: GuardServer[];
  /** The job's own ssh config (`ssh -F <it>`): Oraknid's, not a secret read. */
  sshConfig?: string | null;
  /** What the task is about (its goal, title, scope, my messages): for "named in the task". */
  taskText?: string;
  /** Hosts a plain GET may read at once: the project's registries, its repos' hosts. */
  knownHosts?: string[];
  /** Script names in the workspace's package.json. */
  projectScripts?: string[];
  /** Lockfiles at the workspace's root (`pnpm-lock.yaml`, `uv.lock`…). */
  lockfiles?: string[];
  /** The task's own checks: run as written, they are the project's. */
  verify?: string[];
}

/** Where a command reaches: its own folder, the job's non-production servers, or anything else. */
export type Reach = "local" | "servers" | "outside";

export type Layer1 =
  | { verdict: "allow"; reason: string; rule: string }
  | { verdict: "block"; reason: string; rule: string }
  /** Layer 3: a change on a production server is mine to approve. */
  | { verdict: "ask"; reason: string; rule: string }
  | { verdict: "judge"; reason: string; reach: Reach };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);
const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "lua",
  "tsx",
  "ts-node",
]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c"]);

/** Programs that reach beyond the machine on their own. */
const REACHES_OUT = new Set(
  `curl wget ssh scp sftp rsync nc ncat netcat telnet ftp socat dig nslookup host ping traceroute gh glab aws gcloud az
   kubectl helm docker podman terraform tofu pulumi ansible ansible-playbook vault op pass gpg ssh-add ssh-keygen keyctl
   secret-tool security mail sendmail mailx msmtp http https xh vercel netlify fly flyctl heroku firebase wrangler
   serverless sls railway doctl s3cmd rclone`.split(/\s+/),
);

/** Programs that change files given as arguments, and nothing else. */
const FILE_OPS = new Set(
  `mkdir touch cp mv rm rmdir ln chmod tee truncate patch install unlink sed awk gawk tar gzip gunzip zip unzip xz unxz
   bzip2 bunzip2 zstd unzstd split csplit dos2unix unix2dos shred rename`.split(/\s+/),
);

/** Tools that work on the files of the folder they run in, inside the sandbox. */
const LOCAL_TOOLS = new Set(
  `tsc tsx esbuild vite rollup webpack swc vitest jest mocha ava playwright cypress eslint biome prettier
   stylelint oxlint ruff black isort mypy pyright flake8 pylint pytest tox nox shellcheck shfmt clang-format rustfmt
   gofmt golint go cargo rustc gcc g++ cc clang clang++ ld make cmake ninja meson javac java kotlinc mvn gradle dotnet
   swift zig nim elixir mix sqlite3 jq yq xmllint tidy pandoc convert identify ffmpeg sox dot plantuml mmdc
   turbo nx lerna tsup tsdown rolldown oxc vue-tsc svelte-check astro next nuxt remix wasm-pack protoc buf
   hexo hugo jekyll mkdocs sphinx-build typst latexmk pdflatex xelatex`.split(/\s+/),
);

/** npm's and the like's commands that are the project's own build, test or lint. */
const PROJECT_SCRIPT =
  /^(build|test|tests|lint|typecheck|type-check|types|check|checks|format|fmt|compile|verify|ci|e2e|unit|coverage|tsc|validate)([:._-].*)?$/;
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Commands of local tools that only build, test or check. */
const TOOL_COMMANDS: Record<string, RegExp> = {
  cargo: /^(build|test|check|clippy|fmt|doc|bench|tree|metadata|nextest)$/,
  go: /^(build|test|vet|fmt|list|doc|version|env)$/,
  dotnet: /^(build|test|format|restore)$/,
  mvn: /^(compile|test|verify|package|validate|-q|-B)$/,
  gradle: /^(build|test|check|assemble|compileJava|lint)$/,
  mix: /^(compile|test|format|credo)$/,
  swift: /^(build|test)$/,
  zig: /^(build|test|fmt)$/,
  deno: /^(test|lint|fmt|check|task)$/,
};

const DB_CLIENTS =
  /\b(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|clickhouse|cockroach|mongosh|mongo|cqlsh|duckdb)\b/;
const DESTROYS_SQL =
  /\b(drop\s+(table|database|schema|index|view|user|role|owned|materialized\s+view)|truncate(\s+table)?\s+[\w"`.]+)/i;

/** Deploy tools, and the arguments that send them to production. */
const DEPLOYS =
  /^(vercel|netlify|fly|flyctl|heroku|firebase|wrangler|serverless|sls|railway|eb|cap|capistrano|kamal|dokku|gcloud|kubectl|helm|ansible-playbook)$/;
const TO_PRODUCTION =
  /^(--prod|--production|prod|production|live|--stage=prod(uction)?|--env=prod(uction)?|--environment=prod(uction)?)$/i;

const word = (re: string) =>
  new RegExp(`(^|[^\\w-])${re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`, "i");

/** Layer 1's verdict on a shell command. */
export async function rules(command: string, ctx: GuardContext): Promise<Layer1> {
  if (!parserReady()) await initParser();
  const parsed = parseCommand(command);
  const blocked = await blocks(command, parsed, ctx);
  if (blocked) return blocked;
  return classify(parsed, ctx);
}

// ---------------------------------------------------------------- blocks

async function blocks(command: string, parsed: Parsed, ctx: GuardContext): Promise<Layer1 | null> {
  const { parts } = parsed;

  // Secrets going out: only a command that reaches the network is scanned.
  if (parts.some((p) => NETWORK.has(p.program) || p.host !== null)) {
    const found = secretByPattern(command) ?? (await secretBySecretlint(command));
    if (found)
      return {
        verdict: "block",
        rule: `secret.${found.id}`,
        reason: `[Exfiltrating data] the command sends ${found.what} out of the machine; use the credential through the tool or config that holds it, never inline`,
      };
  }

  for (const p of parts) {
    const own = gap(p, parts, ctx);
    if (own) return own;
    const secret = sensitiveArg(p, ctx);
    if (secret)
      return {
        verdict: "block",
        rule: "secret.path",
        reason: `[Exfiltrating data] it reads ${secret}, which holds credentials`,
      };
  }

  // CC Safety Net's built-in rules and rulebooks, unless every part only reads (they have nothing to add there).
  const plainReads =
    !parsed.error &&
    parts.length > 0 &&
    parts.every((p) => p.literal && readsOnlyProgram(p.program, p.args) && !writesOutside(p, ctx));
  if (!plainReads) {
    const local = ctx.sshConfig
      ? command.split(ctx.sshConfig).join("/oraknid/ssh_config")
      : command;
    const net = safetyNet(local, ctx.workspace);
    if (net.block)
      return { verdict: "block", rule: `cc-safety-net.${net.rule}`, reason: net.reason };
    for (const s of parsed.ssh) {
      if (!s.remote || !s.literal) continue;
      const remote = safetyNet(s.remote, ctx.workspace);
      if (remote.block)
        return {
          verdict: "block",
          rule: `cc-safety-net.${remote.rule}`,
          reason: `on ${s.host}: ${remote.reason}`,
        };
    }
  }
  return null;
}

/** Our own rules for CC Safety Net's gaps (ADR-053). */
function gap(p: Part, parts: Part[], ctx: GuardContext): Layer1 | null {
  const block = (rule: string, reason: string): Layer1 => ({
    verdict: "block",
    rule: `oraknid.${rule}`,
    reason: p.host ? `on ${p.host}: ${reason}` : reason,
  });
  const a = p.args;
  const where = p.host ? ` on ${p.host}` : "";

  if (p.program === "docker" || p.program === "podman" || p.program === "docker-compose") {
    const words = a.filter((x) => !x.startsWith("-"));
    const compose = p.program === "docker-compose" ? ["compose", ...words] : words;
    if (/^(system|volume)$/.test(words[0] ?? "") && words[1] === "prune")
      return block(
        "docker-prune",
        `[Destroying data] \`docker ${words[0]} prune\` deletes every unused ${words[0] === "volume" ? "volume, with its data" : "container, network, image and cache"}${where}; remove only what the task names`,
      );
    if (
      compose[0] === "compose" &&
      compose.includes("down") &&
      a.some((x) => /^(-v|--volumes)$/.test(x) || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(x))
    ) {
      const project = composeProject(p);
      const named = project && ctx.taskText ? word(project).test(ctx.taskText) : false;
      if (!named)
        return block(
          "compose-down-volumes",
          `[Destroying data] \`docker compose down -v\` deletes the volumes of ${project ? `the project ${project}` : "a project Oraknid can't name"}${where}, which the task doesn't name; stop it without -v, or say why its data must go`,
        );
    }
  }

  if (p.program === "kubectl" && a.find((x) => !x.startsWith("-")) === "delete")
    return block(
      "kubectl-delete",
      `[Touching shared infrastructure] \`kubectl delete\` removes live cluster objects; leave that to the owner`,
    );

  if (
    (p.program === "terraform" || p.program === "tofu") &&
    (a.includes("destroy") || (a.includes("apply") && a.some((x) => /^--?destroy(=.*)?$/.test(x))))
  )
    return block(
      "terraform-destroy",
      "[Destroying data] it destroys the infrastructure Terraform manages",
    );

  // DROP and TRUNCATE in what a database client is given.
  if (DB_CLIENTS.test(p.program) || (p.program === "docker" && DB_CLIENTS.test(a.join(" ")))) {
    if (DESTROYS_SQL.test(p.text) || DESTROYS_SQL.test(a.join(" ")))
      return block("sql-drop", `[Destroying data] it drops or truncates database objects${where}`);
  }
  if (p.program === "dropdb" || (p.program === "mysqladmin" && a.includes("drop")))
    return block("sql-drop", `[Destroying data] it drops a database${where}`);
  if (p.program === "redis-cli" && a.some((x) => /^(flushall|flushdb)$/i.test(x)))
    return block("redis-flush", `[Destroying data] it empties a Redis database${where}`);
  if (/^mongo(sh)?$/.test(p.program) && /dropDatabase\s*\(|\.drop\s*\(/.test(a.join(" ")))
    return block(
      "mongo-drop",
      `[Destroying data] it drops a MongoDB database or collection${where}`,
    );

  // A download run as code: `curl … | sh`, `sh -c "$(curl …)"`.
  const runsInput = SHELLS.has(p.program) || INTERPRETERS.has(p.program);
  if (runsInput) {
    const script = a.filter((x) => !x.startsWith("-"));
    const fromPipe = p.pipedFrom.some((x) => DOWNLOADERS.has(x));
    const inline = a.some((x) => /^-[a-zA-Z]*[ce]$/.test(x));
    if (fromPipe && (script.length === 0 || a.includes("-") || a.includes("-s")))
      return block(
        "download-run",
        "[Weakening security] it runs code straight from a download; fetch it, read it, then run it as a file",
      );
    if (
      !p.literal &&
      inline &&
      parts.some((q) => DOWNLOADERS.has(q.program) && q.via === "substitution")
    )
      return block(
        "download-run",
        "[Weakening security] it runs code straight from a download; fetch it, read it, then run it as a file",
      );
  }
  if (p.program === "eval" && parts.some((q) => DOWNLOADERS.has(q.program)))
    return block("download-run", "[Weakening security] it runs code straight from a download");

  // A deploy to production, from this computer (a change on a production server of the job asks instead).
  if (DEPLOYS.test(p.program)) {
    const sends =
      /^(deploy|publish|release|up|apply|rollout|promote|push)$/.test(
        a.find((x) => !x.startsWith("-")) ?? "",
      ) ||
      p.program === "vercel" ||
      p.program === "ansible-playbook";
    const prod =
      a.some((x) => TO_PRODUCTION.test(x)) ||
      a.some(
        (x, i) =>
          /^(--stage|--env|--environment|-e|--context|--app|-a|--project|--target)$/.test(
            a[i - 1] ?? "",
          ) && /prod/i.test(x),
      );
    if (sends && prod)
      return block(
        "deploy-production",
        "[Bypassing review] it deploys to production; production changes are the owner's to approve, as a plan of a server job",
      );
  }
  return null;
}

/** The name of a docker compose project, as compose would pick it. */
function composeProject(p: Part): string | null {
  const a = p.args;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string;
    if (x === "-p" || x === "--project-name") return a[i + 1] ?? null;
    const m = /^--project-name=(.+)$/.exec(x);
    if (m) return m[1] as string;
  }
  const env = /\bCOMPOSE_PROJECT_NAME=(\S+)/.exec(p.text);
  if (env) return (env[1] as string).replace(/['"]/g, "");
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === "-f" || a[i] === "--file" || a[i] === "--project-directory") && a[i + 1]) {
      const f = a[i + 1] as string;
      const dir = a[i] === "--project-directory" ? f : posix.dirname(f);
      if (dir && dir !== ".") return posix.basename(dir);
    }
  }
  if (p.dir) return posix.basename(p.dir.replace(/\/$/, ""));
  return null;
}

/** An argument that names a file holding credentials; the job's own ssh config is Oraknid's. */
function sensitiveArg(p: Part, ctx: GuardContext): string | null {
  if (p.program === "ssh" || p.program === "scp" || p.program === "rsync" || p.program === "sftp") {
    // Their -F, -i and the like are how they reach the job's servers, not reads.
    return null;
  }
  for (const raw of [...p.args, ...p.redirects.filter((r) => r.op === "<").map((r) => r.target)]) {
    if (raw.startsWith("-") && !raw.includes("=")) continue;
    const value = raw.includes("=") && raw.startsWith("-") ? raw.slice(raw.indexOf("=") + 1) : raw;
    if (ctx.sshConfig && (value === ctx.sshConfig || value.endsWith("/oraknid_known_hosts")))
      continue;
    if (isSensitivePath(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------- classify

type Class =
  | { kind: "ok"; why: string }
  | { kind: "ask"; why: string }
  | { kind: "judge"; why: string; reach: Reach };

function classify(parsed: Parsed, ctx: GuardContext): Layer1 {
  if (parsed.error)
    return {
      verdict: "judge",
      reason: "the shell parser could not read all of it",
      reach: reachOf(parsed, ctx),
    };
  if (!parsed.parts.length) return { verdict: "allow", reason: "it runs nothing", rule: "empty" };
  const classes = parsed.parts.map((p) => partClass(p, ctx));
  const ask = classes.find((c) => c.kind === "ask");
  if (ask) return { verdict: "ask", reason: ask.why, rule: "production" };
  const judged = classes.filter((c): c is Extract<Class, { kind: "judge" }> => c.kind === "judge");
  if (judged.length) {
    const reach: Reach = judged.some((j) => j.reach === "outside")
      ? "outside"
      : judged.some((j) => j.reach === "servers")
        ? "servers"
        : "local";
    return { verdict: "judge", reason: [...new Set(judged.map((j) => j.why))].join("; "), reach };
  }
  const why = [...new Set(classes.map((c) => c.why))];
  return { verdict: "allow", reason: why.join("; "), rule: "allow-list" };
}

function reachOf(parsed: Parsed, ctx: GuardContext): Reach {
  const servers = new Set((ctx.servers ?? []).map((s) => s.alias));
  if (
    parsed.parts.some(
      (p) =>
        (p.host && !servers.has(p.host)) || (REACHES_OUT.has(p.program) && p.program !== "ssh"),
    )
  )
    return "outside";
  return parsed.parts.some((p) => p.host) ? "servers" : "local";
}

const DEV = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** A redirection writing outside the job's folder and its scratch. */
function writesOutside(p: Part, ctx: GuardContext): boolean {
  return p.redirects.some((r) => {
    if (
      r.op === "<" ||
      r.op === "<<<" ||
      r.op === "<<" ||
      /&$/.test(r.op) ||
      /^\d+$/.test(r.target) ||
      r.target === "-"
    )
      return false;
    if (/[<]/.test(r.op) && !/>/.test(r.op)) return false;
    if (!r.literal) return true;
    if (DEV.test(r.target)) return false;
    if (p.host) return true;
    return !inside(r.target, p, ctx);
  });
}

function resolve(path: string, p: Part, ctx: GuardContext): string {
  let x = path;
  if (x === "~" || x.startsWith("~/")) x = `${ctx.home ?? "/nonexistent-home"}${x.slice(1)}`;
  const base = p.dir
    ? p.dir.startsWith("/")
      ? p.dir
      : posix.resolve(ctx.workspace, p.dir)
    : ctx.workspace;
  return posix.resolve(base, x);
}

function inside(path: string, p: Part, ctx: GuardContext): boolean {
  if (/[$`]/.test(path)) return false;
  const abs = resolve(path, p, ctx);
  return [ctx.workspace, ...(ctx.scratch ?? [])].some((root) => {
    const r = posix.resolve(root);
    return abs === r || abs.startsWith(`${r}/`);
  });
}

/** Every path-like argument stays inside the job's folder or its scratch. */
function argsInside(p: Part, ctx: GuardContext, args = p.args): boolean {
  return args.every((x) => {
    if (x.startsWith("-")) {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : "";
      return !v.includes("/") || inside(v, p, ctx);
    }
    // A URL is no path; a plain word is a path in the folder.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(x)) return false;
    return inside(x, p, ctx);
  });
}

function partClass(p: Part, ctx: GuardContext): Class {
  const servers = ctx.servers ?? [];
  const judge = (why: string, reach: Reach): Class => ({ kind: "judge", why, reach });

  if (!p.literal) {
    // Shell expansions make the words unknown until it runs (`cat $f` may be a .env): the judge reads it.
    return judge(
      `\`${p.program || p.argv[0] || "?"}\` has words known only when it runs`,
      p.host ? "servers" : REACHES_OUT.has(p.program) ? "outside" : "local",
    );
  }

  // On a server, over ssh.
  if (p.host) {
    const server = servers.find((s) => s.alias === p.host);
    const reads =
      readsOnlyProgram(p.program, p.args) &&
      !writesOutside(p, ctx) &&
      !p.wrappers.includes("xargs");
    if (!server)
      return judge(`it runs on ${p.host}, which is not one of the job's servers`, "outside");
    if (
      reads ||
      p.program === "cd" ||
      (SHELLS.has(p.program) && p.args.some((x) => /^-[a-zA-Z]*c/.test(x)))
    )
      return { kind: "ok", why: `only reads on ${server.name}` };
    if (server.production)
      return { kind: "ask", why: `it may change ${server.name}, which is production` };
    return judge(`it changes ${server.name}`, "servers");
  }

  if (p.wrappers.includes("sudo") || p.wrappers.includes("doas"))
    return judge("it runs as root", "local");

  const prog = p.program;
  const a = p.args;

  // Builtins and the shell itself.
  if (
    prog === "cd" ||
    prog === "export" ||
    prog === "set" ||
    prog === "unset" ||
    prog === "local" ||
    prog === ":" ||
    prog === "read" ||
    prog === "shift" ||
    prog === "return" ||
    prog === "exit" ||
    prog === "wait" ||
    prog === "trap" ||
    prog === "source" ||
    prog === "."
  )
    return prog === "source" || prog === "."
      ? argsInside(p, ctx)
        ? { kind: "ok", why: "it reads a script in the folder" }
        : judge("it sources a script outside the folder", "local")
      : { kind: "ok", why: "a shell builtin" };
  if (SHELLS.has(prog) && a.some((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x)))
    return { kind: "ok", why: "its script is read part by part" };

  if (writesOutside(p, ctx)) return judge("it writes to a file outside the job's folder", "local");

  // ssh, scp, rsync to the job's servers.
  if (prog === "ssh") {
    const target = p.args.find(
      (x, i) => !x.startsWith("-") && !/^-[BbcDEeFIiJLlmOoPpQRSWw]$/.test(p.args[i - 1] ?? ""),
    );
    const host = target?.replace(/^[^@]+@/, "");
    const server = servers.find((s) => s.alias === host);
    if (!server)
      return judge(`ssh to ${host ?? "a host"}, which is not one of the job's servers`, "outside");
    const remote = p.args.slice(p.args.indexOf(target as string) + 1);
    if (!remote.length) return judge(`an interactive login to ${server.name}`, "servers");
    return { kind: "ok", why: `reaches ${server.name}` };
  }
  if (prog === "scp" || prog === "rsync" || prog === "sftp") {
    const server = servers.find((s) =>
      a.some((x) => new RegExp(`(^|@)${s.alias.replace(/[.]/g, "\\.")}:`).test(x)),
    );
    if (server?.production)
      return { kind: "ask", why: `it copies to or from ${server.name}, which is production` };
    if (server) return judge(`it copies files to or from ${server.name}`, "servers");
    return judge(`${prog} reaches another machine`, "outside");
  }

  // Read-only programs.
  if (readsOnlyProgram(prog, a)) {
    if (prog === "curl" || prog === "wget") {
      const hosts = urlHosts(a);
      const known = new Set([...(ctx.knownHosts ?? []).map((h) => h.toLowerCase())]);
      if (
        hosts.length &&
        hosts.every((h) => known.has(h) || [...known].some((k) => h.endsWith(`.${k}`)))
      )
        return { kind: "ok", why: `${prog} reads ${hosts.join(", ")}, a known host` };
      return judge(`${prog} reaches ${hosts.join(", ") || "the network"}`, "outside");
    }
    if (prog === "nc" || prog === "ncat") return { kind: "ok", why: "nc -z only checks a port" };
    if (REACHES_OUT.has(prog)) {
      // docker ps, kubectl get, gh pr view: reading, but beyond the folder.
      if (
        prog === "docker" ||
        prog === "podman" ||
        prog === "dig" ||
        prog === "nslookup" ||
        prog === "host" ||
        prog === "ping"
      )
        return { kind: "ok", why: `${prog} only reads` };
      return judge(`${prog} reads beyond the machine`, "outside");
    }
    return { kind: "ok", why: `${prog} only reads` };
  }

  // The task's own checks, as written.
  if (ctx.verify?.some((v) => v.trim() === p.text.trim()))
    return { kind: "ok", why: "the task's own check" };

  // Package managers: the project's scripts, installs from the lockfile.
  if (PKG_MANAGERS.has(prog)) return packageManager(p, ctx);
  if (prog === "npx" || prog === "bunx" || prog === "pnpx") {
    const tool = a.find((x) => !x.startsWith("-"));
    if (tool && LOCAL_TOOLS.has(tool) && !a.includes("-y") && !a.includes("--yes"))
      return { kind: "ok", why: `the project's own ${tool}` };
    return judge(`${prog} may fetch and run a package`, "outside");
  }
  if (
    prog === "uv" ||
    prog === "poetry" ||
    prog === "pipenv" ||
    prog === "bundle" ||
    prog === "composer"
  ) {
    const sub = a.find((x) => !x.startsWith("-")) ?? "";
    const locked = (LOCKFILES[prog] ?? []).some((f) => ctx.lockfiles?.includes(f));
    if (locked && /^(sync|install)$/.test(sub) && a.filter((x) => !x.startsWith("-")).length === 1)
      return { kind: "ok", why: "it installs what the lockfile names" };
    if (prog === "uv" && /^(run)$/.test(sub)) {
      const tool = a.filter((x) => !x.startsWith("-"))[1];
      if (tool && (LOCAL_TOOLS.has(tool) || INTERPRETERS.has(tool)))
        return { kind: "ok", why: `the project's own ${tool}` };
    }
    return judge(`\`${prog} ${sub}\` may fetch packages`, "outside");
  }
  if (
    prog === "go" &&
    /^(mod)$/.test(a[0] ?? "") &&
    /^(download|verify|tidy|graph|why)$/.test(a[1] ?? "") &&
    ctx.lockfiles?.includes("go.sum")
  )
    return { kind: "ok", why: "it fetches what go.sum names" };
  if (prog === "pip" || prog === "pip3")
    return judge("pip installs packages from the network", "outside");

  // Tools with their own commands.
  const sub = TOOL_COMMANDS[prog];
  if (sub) {
    const cmd = a.find((x) => !x.startsWith("-")) ?? "";
    if (sub.test(cmd) || (prog === "deno" && cmd === "task"))
      return { kind: "ok", why: `\`${prog} ${cmd}\` builds or checks the project` };
    if ((prog === "go" && cmd === "run") || (prog === "cargo" && cmd === "run"))
      return { kind: "ok", why: "it runs the project's own code" };
    return judge(
      `\`${prog} ${cmd}\` is not a build, test or lint command`,
      prog === "go" && cmd === "get" ? "outside" : "local",
    );
  }
  if (prog === "make") {
    const targets = a.filter((x) => !x.startsWith("-") && !x.includes("="));
    if (
      targets.every(
        (t) =>
          PROJECT_SCRIPT.test(t) ||
          /^(all|clean|install-deps|deps|dev|run|docs|release-check)$/.test(t),
      ) &&
      !targets.includes("deploy")
    )
      return { kind: "ok", why: "the project's own make targets" };
    return judge(`make ${targets.join(" ")}`, "local");
  }
  if (LOCAL_TOOLS.has(prog)) {
    if (
      argsInside(
        p,
        ctx,
        a.filter((x) => x.startsWith("/") || x.startsWith("~") || x.includes("..")),
      )
    )
      return { kind: "ok", why: `${prog} works on the project inside the sandbox` };
    return judge(`${prog} works on files outside the job's folder`, "local");
  }

  // git: local history is the workspace's; what talks to a remote is judged.
  if (prog === "git") return gitClass(p, ctx);

  // Interpreters running a file of the project.
  if (INTERPRETERS.has(prog) || SHELLS.has(prog)) {
    if (
      a.some(
        (x) =>
          /^-[a-zA-Z]*[ce]$/.test(x) ||
          x === "-" ||
          x === "--eval" ||
          x === "--print" ||
          x === "-p",
      )
    )
      return judge(`${prog} runs inline code`, "local");
    const script = a.find((x) => !x.startsWith("-"));
    if (prog === "python" || prog === "python3") {
      const m = a.indexOf("-m");
      if (m >= 0) {
        const mod = a[m + 1] ?? "";
        if (
          /^(pytest|unittest|mypy|ruff|black|isort|pylint|flake8|compileall|py_compile|json\.tool|http\.server|venv|doctest|coverage)$/.test(
            mod,
          )
        )
          return { kind: "ok", why: `python -m ${mod}` };
        if (mod === "pip") return judge("pip installs packages from the network", "outside");
        return judge(`python -m ${mod}`, "local");
      }
    }
    if (!script) return judge(`${prog} reads its code from its input`, "local");
    if (inside(script, p, ctx))
      return { kind: "ok", why: `it runs ${script}, the project's own code` };
    return judge(`it runs ${script}, outside the job's folder`, "local");
  }
  if (/^\.{0,2}\//.test(p.argv[p.argv.length - a.length - 1] ?? "")) {
    const path = p.argv[p.argv.length - a.length - 1] as string;
    if (inside(path, p, ctx)) return { kind: "ok", why: `it runs ${path}, the project's own code` };
  }

  // File operations inside the job's folder.
  if (FILE_OPS.has(prog)) {
    if (argsInside(p, ctx)) return { kind: "ok", why: `${prog} works inside the job's folder` };
    return judge(`${prog} touches files outside the job's folder`, "local");
  }

  if (REACHES_OUT.has(prog)) return judge(`${prog} reaches beyond the machine`, "outside");
  return judge(`${prog || "it"} is not on the allow list`, "local");
}

function packageManager(p: Part, ctx: GuardContext): Class {
  const prog = p.program;
  const a = p.args.filter(
    (x) =>
      !/^(--filter|-F|-C|--dir|--prefix|-w|--workspace|--workspace-root|-r|--recursive|--silent|-s|--if-present|--parallel|--stream)$/.test(
        x,
      ) && !/^--(filter|dir|prefix|workspace)=/.test(x),
  );
  // Values of --filter and the like.
  const words: string[] = [];
  for (let i = 0; i < p.args.length; i++) {
    const x = p.args[i] as string;
    if (/^(--filter|-F|-C|--dir|--prefix|--workspace|-w)$/.test(x)) {
      i++;
      continue;
    }
    if (!x.startsWith("-")) words.push(x);
  }
  const cmd = words[0] ?? "";
  const scripts = new Set(ctx.projectScripts ?? []);
  const script = cmd === "run" || cmd === "run-script" ? (words[1] ?? "") : cmd;
  if (
    (cmd === "run" || cmd === "run-script" || scripts.has(cmd) || cmd === "test" || cmd === "t") &&
    PROJECT_SCRIPT.test(script === "t" ? "test" : script)
  )
    return { kind: "ok", why: `the project's own \`${script}\`` };
  if (cmd === "exec" || cmd === "x" || (prog === "bun" && cmd === "x")) {
    const tool = words[1] ?? "";
    if (LOCAL_TOOLS.has(tool)) return { kind: "ok", why: `the project's own ${tool}` };
  }
  if (cmd === "dlx")
    return { kind: "judge", why: `${prog} dlx fetches and runs a package`, reach: "outside" };
  const locked = (LOCKFILES[prog] ?? []).some((f) => ctx.lockfiles?.includes(f));
  const install = cmd === "" && prog === "yarn" ? true : /^(install|i|ci)$/.test(cmd);
  if (
    install &&
    words.length <= 1 &&
    !a.some((x) => /^(-g|--global|--no-frozen-lockfile|--no-lockfile)$/.test(x))
  ) {
    if (locked) return { kind: "ok", why: "it installs what the lockfile names" };
    return {
      kind: "judge",
      why: "it installs packages, with no lockfile to say which",
      reach: "outside",
    };
  }
  if (
    /^(ls|list|why|outdated|view|info|config|--version|-v|root|bin|audit)$/.test(cmd) &&
    cmd !== "config"
  )
    return { kind: "ok", why: `${prog} ${cmd} only reads` };
  if (cmd === "run" || cmd === "run-script" || scripts.has(cmd))
    return {
      kind: "judge",
      why: `\`${prog} ${script}\` is a script of the project that isn't a build, test or lint`,
      reach: "local",
    };
  return {
    kind: "judge",
    why: `\`${prog} ${cmd}\` changes the project's packages`,
    reach: "outside",
  };
}

function gitClass(p: Part, ctx: GuardContext): Class {
  const a = p.args;
  let i = 0;
  while (i < a.length && (a[i] as string).startsWith("-"))
    i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(a[i] as string) ? 2 : 1;
  const cmd = a[i] ?? "";
  const rest = a.slice(i + 1);
  if (/^(push|fetch|pull|clone|ls-remote|submodule|remote)$/.test(cmd)) {
    if (cmd === "remote" && !/^(add|set-url|remove|rm|rename)$/.test(rest[0] ?? ""))
      return { kind: "ok", why: "git remote only reads" };
    return { kind: "judge", why: `git ${cmd} talks to another repository`, reach: "outside" };
  }
  if (
    /^(add|commit|checkout|switch|restore|stash|merge|rebase|cherry-pick|revert|tag|branch|mv|rm|reset|apply|am|format-patch|notes|bisect|clean|worktree|init|config|gc|fsck|update-index|write-tree|commit-tree|update-ref|symbolic-ref|read-tree|checkout-index|sparse-checkout|lfs|mergetool|difftool|range-diff)$/.test(
      cmd,
    )
  ) {
    if (cmd === "config" && rest.some((x) => x === "--global" || x === "--system"))
      return { kind: "judge", why: "it changes git's settings outside the folder", reach: "local" };
    if (
      !argsInside(
        p,
        ctx,
        rest.filter((x) => x.startsWith("/") || x.includes("..")),
      )
    )
      return {
        kind: "judge",
        why: `git ${cmd} names paths outside the job's folder`,
        reach: "local",
      };
    return { kind: "ok", why: `git ${cmd} works on the job's own history` };
  }
  return { kind: "judge", why: `git ${cmd || "?"}`, reach: "local" };
}
