/** A command to run confined to a few directories (ADR-006, docs/02-Architecture/Sandboxing.md). */
export interface SandboxSpec {
  command: string;
  args: string[];
  /** Working directory; must also be in `writable`. */
  cwd: string;
  /** Read-write binds: the worktree, the Leg's home. */
  writable: string[];
  /** Read-only binds: toolchain directories. */
  readonly: string[];
  /** HOME inside the sandbox. Must be in `writable`. */
  home: string;
  /** The complete environment. Nothing else from the parent leaks in. */
  env: Record<string, string>;
  /** The internet (default true; Legs need their APIs). Never this computer's own services, but… */
  network?: boolean;
  /** …these ports on this computer's localhost, reachable as localhost inside (a project's database, a Leg's local model). */
  localPorts?: number[];
  /** Ports inside that this computer reaches on its localhost (a Leg's own server, like OpenCode's). */
  inboundPorts?: number[];
  /** This computer's network, not one of its own: only while I sign a Leg in (its browser callback). */
  hostNetwork?: boolean;
  /**
   * A worktree's git folders (M13.22), bound after the others: the
   * project's `.git` as a throwaway layer over its entries, what git writes
   * writable, the rest read-only, and the links that say where the
   * repository is read-only again. Found from `cwd` when not given.
   */
  git?: { layer: string[]; readonly: string[]; writable: string[]; protect: string[] };
}

export interface SandboxStatus {
  available: boolean;
  detail: string;
}

export interface Sandbox {
  status(): SandboxStatus;
  /** The command line that runs `spec` inside the sandbox. */
  wrap(spec: SandboxSpec): { command: string; args: string[] };
}

/** The same sandbox, with these local ports open too (a session's project and Leg). */
export function withLocalPorts(sandbox: Sandbox, ports: number[]): Sandbox {
  if (!ports.length) return sandbox;
  return {
    status: () => sandbox.status(),
    wrap: (spec) =>
      sandbox.wrap({ ...spec, localPorts: [...new Set([...(spec.localPorts ?? []), ...ports])] }),
  };
}

/**
 * For tests on a machine whose sandbox doesn't work (a CI runner without
 * user namespaces): the command runs as it is, in its folder, with its
 * variables. What tests isolation itself must skip there (`isolated`).
 */
export function sandboxForTests(real: Sandbox): { sandbox: Sandbox; isolated: boolean } {
  if (process.env.ORAKNID_TEST_NO_SANDBOX !== "1" && real.status().available)
    return { sandbox: real, isolated: true };
  return {
    isolated: false,
    sandbox: {
      status: () => ({ available: true, detail: "no sandbox (tests on a machine without one)" }),
      wrap: (spec) => ({
        command: "env",
        args: [
          "-i",
          ...Object.entries({ ...spec.env, HOME: spec.home }).map(([k, v]) => `${k}=${v}`),
          "sh",
          "-c",
          'cd "$0" && exec "$@"',
          spec.cwd,
          spec.command,
          ...spec.args,
        ],
      }),
    },
  };
}
