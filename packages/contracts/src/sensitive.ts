// What the rules (the guard, ADR-053 layer 1) and the policy both read, kept
// in one place (ADR-056 §3): the files whose reading is reading a credential,
// and the lockfiles a package manager installs from.

/** Files whose reading is reading a credential (CC Safety Net's secret paths and more). */
export const SENSITIVE_PATHS: readonly RegExp[] = [
  /(^|\/)\.env(\.(?!example\b|sample\b|template\b|dist\b|defaults\b)[\w-]+)?$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.(netrc|pgpass|git-credentials|pypirc)$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/(gh\/hosts\.yml|gcloud)(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.azure(\/|$)/,
];

/** Whether reading this path is reading a credential. */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path));
}

/**
 * The job's own ssh setup, written by Oraknid in the job's home (ADR-049):
 * the config naming the job's servers and the host keys it pinned. Reading
 * them is no secret read; the private keys beside them are.
 */
export const OWN_SSH_FILE = /(^|\/)\.ssh\/(config|oraknid_known_hosts)$/;

/** The lockfiles each package manager installs from. */
export const LOCKFILES: Readonly<Record<string, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lockb", "bun.lock"],
  uv: ["uv.lock"],
  poetry: ["poetry.lock"],
  pipenv: ["Pipfile.lock"],
  bundle: ["Gemfile.lock"],
  composer: ["composer.lock"],
  go: ["go.sum"],
  cargo: ["Cargo.lock"],
};

/** Every lockfile, whatever its package manager. */
export const ALL_LOCKFILES: readonly string[] = [...new Set(Object.values(LOCKFILES).flat())];
