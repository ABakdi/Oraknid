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
  /** Share the host network (default true; Legs need their APIs). */
  network?: boolean;
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
