// Semantic versions (semver.org, ADR-047): enough to order Oraknid's releases.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** The pre-release's identifiers (`1.0.0-rc.1` → ["rc", "1"]); empty for a release. */
  pre: string[];
}

const PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version or a tag (`v0.2.0`); null when it isn't one. */
export function parseVersion(text: string): SemVer | null {
  const m = PATTERN.exec(text.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Negative when a comes first, positive when b does, 0 when equal (build metadata ignored). */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  // A pre-release comes before its release.
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    // Numbers come before words.
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `candidate` is newer than `current`; false when either isn't a version. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return !!a && !!b && compareVersions(a, b) > 0;
}
