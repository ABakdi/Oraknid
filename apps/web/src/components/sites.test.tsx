import type { SiteView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { certWords, SitesPanel, stateOf } from "./sites";

// The Sites tab (ADR-060): every domain, up or down, its certificate and DNS.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const now = Date.now();
const DAY = 86_400_000;
const site = (o: Partial<SiteView>): SiteView => ({
  id: "01J00000000000000000000001",
  host: "shop.example.com",
  url: "https://shop.example.com/",
  serverId: "01J00000000000000000000009",
  serverName: "vps",
  source: "nginx",
  upstream: "127.0.0.1:3000",
  checkEnabled: true,
  intervalMin: 5,
  lastCheckAt: now - 60_000,
  up: true,
  downSince: null,
  lastStatus: 200,
  lastLatencyMs: 84,
  lastError: null,
  uptime24h: 1,
  uptime7d: 0.995,
  recent: [
    { at: now - 120_000, up: true, status: 200, latencyMs: 90, error: null },
    { at: now - 60_000, up: true, status: 200, latencyMs: 84, error: null },
  ],
  dns: { a: ["203.0.113.5"], aaaa: [], cname: [], pointsHere: true, error: null },
  dnsAt: now,
  cert: {
    expiresAt: now + 40 * DAY,
    issuer: "Let's Encrypt · R11",
    names: ["shop.example.com"],
    valid: true,
    error: null,
    at: now,
  },
  createdAt: now - 10 * DAY,
  ...o,
});

const SITES = [
  site({}),
  site({
    id: "01J00000000000000000000002",
    host: "blog.example.com",
    up: false,
    downSince: now - 10 * 60_000,
    lastStatus: 502,
    lastError: "It answered 502.",
    dns: { a: ["198.51.100.1"], aaaa: [], cname: [], pointsHere: false, error: null },
    cert: { ...site({}).cert, expiresAt: now + 5 * DAY },
  }),
];
const calls: string[] = [];

vi.mock("@/lib/api", () => ({
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  api: {
    sites: {
      list: async () => SITES,
      find: async () => {
        calls.push("find");
        return { added: ["new.example.com"], total: 3, skipped: [] };
      },
      add: async (x: unknown) => {
        calls.push(`add ${JSON.stringify(x)}`);
        return SITES[0];
      },
      refresh: async (x: unknown) => {
        calls.push(`refresh ${JSON.stringify(x)}`);
        return SITES[0];
      },
      update: async () => SITES[0],
      remove: async () => undefined,
    },
  },
}));

vi.mock("@/lib/live", async () => {
  const React = await import("react");
  const reload = () => {};
  return {
    useLive: (load: () => Promise<unknown>) => {
      const [state, setState] = React.useState<{ data?: unknown; loading: boolean }>({
        loading: true,
      });
      React.useEffect(() => {
        void load().then((data) => setState({ data, loading: false }));
      }, []);
      return { ...state, error: undefined, reload };
    },
  };
});

afterEach(cleanup);

describe("Sites (ADR-060)", () => {
  it("shows each site up or down, its certificate's end and where DNS points", async () => {
    render(<SitesPanel />);
    await screen.findByText("shop.example.com");
    expect(screen.getByText("blog.example.com")).toBeTruthy();
    expect(screen.getByText("down")).toBeTruthy();
    expect(screen.getByText(/It answered 502/)).toBeTruthy();
    expect(screen.getByText(/ends in 39 days|ends in 40 days/)).toBeTruthy();
    expect(screen.getByText(/doesn't point at vps/)).toBeTruthy();
    fireEvent.click(screen.getByText("Find sites"));
    await waitFor(() => expect(calls).toContain("find"));
    fireEvent.change(screen.getByLabelText("A domain or a URL"), {
      target: { value: "example.org" },
    });
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(calls).toContain('add {"address":"example.org"}'));
  });

  it("words: red under two weeks or ended; down before failing", () => {
    expect(certWords(site({}), now).bad).toBe(false);
    expect(certWords(site({ cert: { ...site({}).cert, expiresAt: now + 3 * DAY } }), now)).toEqual({
      text: "ends in 3 days",
      bad: true,
    });
    expect(
      certWords(site({ cert: { ...site({}).cert, expiresAt: now - 2.5 * DAY } }), now).text,
    ).toBe("ended 3 days ago");
    expect(stateOf(site({ downSince: now })).text).toBe("down");
    expect(stateOf(site({ up: false })).text).toBe("failing");
    expect(stateOf(site({ checkEnabled: false })).text).toBe("not checked");
  });
});
