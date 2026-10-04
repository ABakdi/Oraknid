import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallRecord } from "@oraknid/contracts";
import type { Fetch } from "../updates/github.ts";
import { RECORD_FILE } from "../updates/install.ts";
import type { Launcher } from "../updates/runner.ts";

// Stand-ins for the updates' tests (ADR-048): GitHub, an install, a launcher.

export const release = (
  tag: string,
  o: { prerelease?: boolean; draft?: boolean; body?: string; name?: string } = {},
) => ({
  tag_name: tag,
  name: o.name ?? `Oraknid ${tag}`,
  draft: o.draft ?? false,
  prerelease: o.prerelease ?? false,
  published_at: "2026-10-04T10:00:00Z",
  body: o.body ?? `What is new in ${tag}.`,
  html_url: `https://github.com/ABakdi/Oraknid/releases/tag/${tag}`,
});

/** GitHub's API for releases and comparisons, with ETags; offline or rate-limited on demand. */
export function fakeGitHub() {
  const gh = {
    releases: [] as unknown[],
    etag: '"r1"',
    ahead: 0,
    offline: false,
    limited: false,
    calls: [] as { url: string; ifNoneMatch: string | undefined }[],
    fetch: (async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      gh.calls.push({ url, ifNoneMatch: headers["if-none-match"] });
      if (gh.offline) throw new TypeError("fetch failed");
      if (gh.limited) return new Response("{}", { status: 403 });
      if (url.includes("/releases")) {
        if (headers["if-none-match"] === gh.etag) return new Response(null, { status: 304 });
        return Response.json(gh.releases, { headers: { etag: gh.etag } });
      }
      const m = /\/compare\/(\w+)\.\.\.dev$/.exec(url);
      if (m) {
        const commits = Array.from({ length: gh.ahead }, (_, i) => ({
          sha: `${String(i + 1).padStart(2, "0")}${"a".repeat(38)}`,
          commit: { message: `Work ${i + 1}\n\nits details` },
        }));
        return Response.json(
          { ahead_by: gh.ahead, status: gh.ahead ? "ahead" : "identical", commits },
          { headers: { etag: `"c${gh.ahead}"` } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as Fetch,
  };
  return gh;
}

/** A folder with install.sh's record in it (the script's install), or without (a clone). */
export function fakeApp(record: Partial<InstallRecord> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-app-"));
  if (record)
    writeFileSync(
      join(dir, RECORD_FILE),
      JSON.stringify({
        ref: "main",
        channel: "stable",
        commit: "1".repeat(40),
        version: "0.1.0",
        installedAt: "2026-10-04T09:00:00Z",
        from: "https://github.com/ABakdi/Oraknid.git",
        service: true,
        ...record,
      }),
    );
  return dir;
}

/** Records what it was asked to start, starting nothing. */
export function fakeLauncher(status = 0) {
  const l = {
    runs: [] as string[][],
    detached: [] as string[][],
    run(cmd: string, args: string[]) {
      l.runs.push([cmd, ...args]);
      return { status, stderr: status ? "Failed to connect to bus" : "" };
    },
    detach(cmd: string, args: string[]) {
      l.detached.push([cmd, ...args]);
    },
  } satisfies Launcher & Record<string, unknown>;
  return l;
}
