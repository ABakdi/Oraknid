import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import type { Sandbox, SandboxSpec, SandboxStatus } from "../sandbox.ts";

/** Top-level directories that are symlinks into /usr on merged-/usr systems (Arch). */
const MERGED_USR = ["/bin", "/sbin", "/lib", "/lib64"];

/** System files a typical toolchain needs, bound read-only when present. */
const SYSTEM_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/gitconfig",
];

export interface BwrapOptions {
  bwrapPath?: string;
  /** For tests: what exists on the host. */
  exists?: (path: string) => boolean;
  symlinkTarget?: (path: string) => string | undefined;
}

export function createBwrapSandbox(options: BwrapOptions = {}): Sandbox {
  const bwrap = options.bwrapPath ?? "bwrap";
  const exists = options.exists ?? existsSync;
  const symlinkTarget = options.symlinkTarget ?? readSymlink;

  return {
    status(): SandboxStatus {
      const probe = spawnSync(
        bwrap,
        ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "true"],
        { encoding: "utf8", timeout: 5000 },
      );
      if (probe.error)
        return { available: false, detail: `bwrap not found (${probe.error.message})` };
      if (probe.status !== 0) {
        return {
          available: false,
          detail: `bwrap cannot create a sandbox: ${(probe.stderr || "no output").trim()}`,
        };
      }
      return { available: true, detail: "bubblewrap works" };
    },

    wrap(spec: SandboxSpec) {
      return { command: bwrap, args: bwrapArgs(spec, exists, symlinkTarget) };
    },
  };
}

export function bwrapArgs(
  spec: SandboxSpec,
  exists: (p: string) => boolean = existsSync,
  symlinkTarget: (p: string) => string | undefined = readSymlink,
): string[] {
  if (!spec.writable.includes(spec.cwd)) throw new Error(`cwd ${spec.cwd} must be writable`);
  if (!spec.writable.includes(spec.home)) throw new Error(`home ${spec.home} must be writable`);

  const a: string[] = ["--unshare-all"];
  if (spec.network ?? true) a.push("--share-net");
  a.push("--die-with-parent", "--new-session");

  a.push("--ro-bind", "/usr", "/usr");
  for (const dir of MERGED_USR) {
    const target = symlinkTarget(dir);
    if (target) a.push("--symlink", target, dir);
    else if (exists(dir)) a.push("--ro-bind", dir, dir);
  }
  for (const file of SYSTEM_FILES) if (exists(file)) a.push("--ro-bind", file, file);

  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

  // Read-only first: a writable bind listed later wins where they overlap.
  for (const dir of dedupe(spec.readonly)) a.push("--ro-bind", dir, dir);
  for (const dir of dedupe(spec.writable)) a.push("--bind", dir, dir);

  a.push("--chdir", spec.cwd, "--clearenv");
  const env = { ...spec.env, HOME: spec.home };
  for (const [k, v] of Object.entries(env)) a.push("--setenv", k, v);

  a.push("--", spec.command, ...spec.args);
  return a;
}

function readSymlink(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

const dedupe = (xs: string[]) => [...new Set(xs)];
