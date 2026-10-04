import type { UpdateRun, UpdatesView } from "@oraknid/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge, UpdatesPanel, updateLabel } from "./updates";

// Oraknid's own updates in the UI (ADR-048): the sidebar's word and Settings → About & updates.

const NOW = Date.parse("2026-10-04T12:00:00Z");
afterEach(cleanup);

const script = (channel: "dev" | "stable" = "stable") =>
  ({
    mode: "script",
    appDir: "/home/me/.local/share/oraknid/app",
    ref: channel === "dev" ? "dev" : "main",
    channel,
    commit: "1".repeat(40),
    version: "0.1.0",
    installedAt: "2026-10-04T09:00:00Z",
    from: "https://github.com/ABakdi/Oraknid.git",
    service: true,
  }) as const;

const release = (tag: string, prerelease = false) => ({
  tag,
  version: tag.slice(1),
  name: `Oraknid ${tag}`,
  prerelease,
  publishedAt: NOW - 2 * 3600_000,
  notes: `## What's new\n- Updates from inside Oraknid (${tag})`,
  url: `https://github.com/ABakdi/Oraknid/releases/tag/${tag}`,
});

const view = (o: Partial<UpdatesView> = {}): UpdatesView => ({
  version: "0.1.0",
  install: script(),
  checkedAt: NOW - 5 * 60_000,
  error: null,
  newer: [],
  devAhead: null,
  available: false,
  target: null,
  runningJobs: 0,
  canUpdate: false,
  whyNot: "Oraknid is up to date.",
  run: null,
  ...o,
});

const run = (o: Partial<UpdateRun> = {}): UpdateRun => ({
  state: "running",
  startedAt: NOW - 30_000,
  finishedAt: null,
  fromVersion: "0.1.0",
  fromCommit: "1".repeat(40),
  target: "v0.2.0",
  toVersion: null,
  exitCode: null,
  backup: "/home/me/.local/share/oraknid/backups/pre-update-2026-10-04T12-00-00-000Z-v0.1.0.db",
  log: ["12:00:01 Updating Oraknid 0.1.0 to v0.2.0", "==> Installing dependencies and building"],
  ...o,
});

const available = view({
  newer: [release("v0.2.0")],
  available: true,
  target: "v0.2.0",
  canUpdate: true,
  whyNot: null,
});

describe("the sidebar's version (ADR-048)", () => {
  it("says up to date, an update and to what, or an update running", () => {
    expect(updateLabel(view())).toEqual({ text: "Up to date", tone: "ok" });
    expect(updateLabel(view({ checkedAt: null }))).toEqual({
      text: "Not checked yet",
      tone: "unknown",
    });
    expect(updateLabel(available)).toEqual({ text: "Update available: v0.2.0", tone: "update" });
    expect(updateLabel(view({ run: run() })).tone).toBe("running");
    expect(
      updateLabel(
        view({
          install: script("dev"),
          available: true,
          target: "dev",
          devAhead: { count: 4, commits: [], url: "u" },
        }),
      ).text,
    ).toBe("New work on dev (4)");
    const { container } = render(<UpdateBadge view={available} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/settings/about");
    expect(link?.textContent).toBe("Oraknid 0.1.0Update available: v0.2.0");
    // Folded: only the dot, the words in its label.
    const folded = render(<UpdateBadge view={view()} folded />).container.querySelector("a");
    expect(folded?.textContent).toBe("");
    expect(folded?.getAttribute("aria-label")).toBe("Oraknid 0.1.0 · Up to date");
  });
});

describe("Settings → About & updates (ADR-048)", () => {
  it("up to date: the version, the channel and how it was installed, no Update now", () => {
    const onCheck = vi.fn();
    const r = render(<UpdatesPanel view={view()} now={NOW} onCheck={onCheck} />);
    expect(r.getByText("Oraknid 0.1.0")).toBeTruthy();
    expect(r.container.querySelector("[data-channel]")?.textContent).toBe("stable channel");
    expect(r.getByText(/Installed by install\.sh from main/)).toBeTruthy();
    expect(r.getByText("Last checked 5 min ago")).toBeTruthy();
    expect(r.queryByText(/Update now/)).toBeNull();
    fireEvent.click(r.getByText("Check now"));
    expect(onCheck).toHaveBeenCalled();
  });

  it("a release: its notes, and Update now", () => {
    const onUpdate = vi.fn();
    const r = render(<UpdatesPanel view={available} now={NOW} onUpdate={onUpdate} />);
    expect(r.container.querySelector("[data-state]")?.textContent).toBe("Update available: v0.2.0");
    expect(r.getByText("Updates from inside Oraknid (v0.2.0)")).toBeTruthy();
    expect(r.getByText(/copies its database first/)).toBeTruthy();
    fireEvent.click(r.getByText("Update now to v0.2.0"));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("the dev channel: pre-releases and new work on dev", () => {
    const r = render(
      <UpdatesPanel
        now={NOW}
        view={view({
          install: script("dev"),
          newer: [release("v0.3.0-rc.1", true)],
          devAhead: {
            count: 2,
            commits: [
              { sha: "a".repeat(40), message: "feat: updates" },
              { sha: "b".repeat(40), message: "docs: ADR-048" },
            ],
            url: "https://github.com/ABakdi/Oraknid/compare/1111111...dev",
          },
          available: true,
          target: "dev",
          canUpdate: true,
          whyNot: null,
        })}
      />,
    );
    expect(r.container.querySelector("[data-channel]")?.textContent).toBe("dev channel");
    expect(r.getByText("pre-release")).toBeTruthy();
    expect(r.getByText("New work on dev (2 commits)")).toBeTruthy();
    expect(r.getByText("aaaaaaa feat: updates")).toBeTruthy();
    expect(r.getByText("Update now to the newest dev")).toBeTruthy();
  });

  it("from a clone: says to update with git, and has no Update now", () => {
    const r = render(
      <UpdatesPanel
        now={NOW}
        view={view({
          install: { mode: "clone", appDir: "/home/me/Dev/Oraknid" },
          newer: [release("v0.2.0")],
          available: true,
          whyNot: "Oraknid runs from a clone at /home/me/Dev/Oraknid: update it with git.",
        })}
      />,
    );
    expect(
      r.getByText(/Running from a clone at \/home\/me\/Dev\/Oraknid: update it with git/),
    ).toBeTruthy();
    expect(r.queryByText(/Update now/)).toBeNull();
    // Installed by an install.sh from before the record: run it once more.
    r.rerender(
      <UpdatesPanel
        now={NOW}
        view={view({
          install: { mode: "clone", appDir: "/home/me/.local/share/oraknid/app", unrecorded: true },
          whyNot:
            "The install.sh that installed Oraknid in /home/me/.local/share/oraknid/app didn't record what it installed: run it once more (with --dev for dev) and Oraknid updates itself from then on.",
        })}
      />,
    );
    expect(r.getByText("installed before the record")).toBeTruthy();
    expect(r.getByText(/run it once more \(with --dev for dev\)/)).toBeTruthy();
  });

  it("away from home without full rights, or offline: says why", () => {
    const r = render(
      <UpdatesPanel
        now={NOW}
        view={{
          ...available,
          canUpdate: false,
          whyNot: "Updating away from home needs a device with full rights.",
          error: "GitHub couldn't be reached (offline?). Oraknid tries again later.",
        }}
      />,
    );
    expect(
      (r.getByText("Update now to v0.2.0").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(r.getByText(/needs a device with full rights/)).toBeTruthy();
    expect(r.getByRole("status").textContent).toMatch(/offline/);
  });

  it("follows an update: running, restarting, then updated with a reload", () => {
    const running = { ...available, canUpdate: false, run: run() };
    const r = render(<UpdatesPanel view={running} now={NOW} />);
    expect(r.getByText("Updating to v0.2.0…")).toBeTruthy();
    expect(r.getByText(/Installing dependencies and building/)).toBeTruthy();
    expect(r.getByText(/The database was copied first to .*pre-update-/)).toBeTruthy();
    // The button isn't there while it runs.
    expect(r.queryByText("Update now to v0.2.0")).toBeNull();
    r.rerender(<UpdatesPanel view={running} restarting now={NOW} />);
    expect(r.getByText("Updating to v0.2.0: Oraknid is restarting…")).toBeTruthy();
    const onReload = vi.fn();
    r.rerender(
      <UpdatesPanel
        view={view({
          version: "0.2.0",
          run: run({ state: "succeeded", toVersion: "0.2.0", exitCode: 0, finishedAt: NOW }),
        })}
        pageVersion="0.1.0"
        onReload={onReload}
        now={NOW}
      />,
    );
    expect(r.getByText("Updated to v0.2.0")).toBeTruthy();
    fireEvent.click(r.getByText("Reload the page"));
    expect(onReload).toHaveBeenCalled();
  });

  it("an update that failed and went back says so", () => {
    const r = render(
      <UpdatesPanel
        now={NOW}
        view={view({ run: run({ state: "rolled-back", exitCode: 3, finishedAt: NOW }) })}
      />,
    );
    expect(r.getByText("The update to v0.2.0 failed; Oraknid went back to v0.1.0.")).toBeTruthy();
    expect(r.container.querySelector("[data-run]")?.getAttribute("data-run")).toBe("rolled-back");
  });
});
