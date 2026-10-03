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

/**
 * Run before bwrap (Audit 2): a Landlock domain that scopes abstract unix
 * sockets and signals. bwrap keeps the host's network namespace (Legs need
 * the internet), and abstract sockets live there: without this, a Leg could
 * connect to the desktop's (a terminal's single-instance socket, X11, D-Bus)
 * and run code outside the sandbox. Python's ctypes calls the syscalls;
 * exit 97 says Landlock isn't there.
 */
export const LANDLOCK_SCRIPT = `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
abi = libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
if abi < 6:
    sys.stderr.write("oraknid: this kernel's Landlock can't scope abstract sockets\\n"); sys.exit(97)
class Attr(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]
attr = Attr(0, 0, 1 | 2)
fd = libc.syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
if fd < 0 or libc.prctl(38, 1, 0, 0, 0) != 0 or libc.syscall(446, ctypes.c_int(fd), ctypes.c_uint32(0)) != 0:
    sys.stderr.write("oraknid: Landlock failed\\n"); sys.exit(97)
os.close(fd)
os.execvp(sys.argv[1], sys.argv[1:])
`;

export interface BwrapOptions {
  bwrapPath?: string;
  /** Scope abstract sockets with Landlock (default: when the probe says it works). */
  landlock?: boolean;
  /** A network of its own through pasta (default: when the probe says it works). */
  pasta?: boolean;
  /** For tests: what exists on the host. */
  exists?: (path: string) => boolean;
  symlinkTarget?: (path: string) => string | undefined;
}

export function createBwrapSandbox(options: BwrapOptions = {}): Sandbox {
  const bwrap = options.bwrapPath ?? "bwrap";
  const exists = options.exists ?? existsSync;
  const symlinkTarget = options.symlinkTarget ?? readSymlink;
  let landlock = options.landlock;
  const scoped = () => {
    landlock ??=
      spawnSync("python3", ["-c", LANDLOCK_SCRIPT, "true"], { timeout: 5000 }).status === 0;
    return landlock;
  };
  let pasta = options.pasta;
  const ownNet = () => {
    pasta ??= spawnSync("pasta", [...pastaArgs([]), "true"], { timeout: 10_000 }).status === 0;
    return pasta;
  };

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
      const net = ownNet()
        ? "each sandbox has a network of its own (pasta): the internet, not this computer's services"
        : "sandboxes share this computer's network: install passt (pasta) so they can't reach its services";
      return {
        available: true,
        detail: scoped()
          ? `bubblewrap works; the desktop's sockets are out of reach (Landlock); ${net}`
          : `bubblewrap works, but Landlock can't scope abstract sockets here (needs Linux 6.12+ and python3): a Leg could reach the desktop's sockets; ${net}`,
      };
    },

    wrap(spec: SandboxSpec) {
      const isolated = (spec.network ?? true) && !spec.hostNetwork && ownNet();
      const args = bwrapArgs(spec, exists, symlinkTarget);
      // pasta first: the sandbox gets a network namespace of its own, with the
      // internet through pasta and only the chosen ports of this computer (Audit 2 → S2-21).
      // Landlock comes inside pasta: applied before it, pasta's user namespace can't map ids.
      const confined = scoped()
        ? ["python3", "-c", LANDLOCK_SCRIPT, bwrap, ...args]
        : [bwrap, ...args];
      const line = isolated
        ? ["pasta", ...pastaArgs(spec.localPorts ?? [], spec.inboundPorts ?? []), ...confined]
        : confined;
      return { command: line[0] as string, args: line.slice(1) };
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
  // Inside pasta's user namespace the caller is root: inside, I am myself again.
  if (typeof process.getuid === "function")
    a.push(
      "--uid",
      String(process.getuid()),
      "--gid",
      String(process.getgid?.() ?? process.getuid()),
    );
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

/**
 * pasta's options: configure the namespace like the host, forward nothing
 * in, from inside forward only `ports` to this computer's localhost, and
 * don't map the gateway to it (`--no-map-gw`). Then the command.
 */
export function pastaArgs(ports: number[], inbound: number[] = []): string[] {
  const valid = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
  const ok = ports.filter(valid);
  const into = inbound.filter(valid);
  return [
    "--config-net",
    "--quiet",
    // In: only the given ports, from this computer's localhost, to the sandbox's localhost.
    ...(into.length
      ? ["--host-lo-to-ns-lo", ...into.flatMap((p) => ["-t", `127.0.0.1/${p}`])]
      : ["-t", "none"]),
    "-u",
    "none",
    "-T",
    ok.length ? ok.join(",") : "none",
    "-U",
    "none",
    "--no-map-gw",
    "--",
  ];
}

function readSymlink(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

const dedupe = (xs: string[]) => [...new Set(xs)];
