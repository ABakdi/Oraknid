import type { ServerView } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// A server's tabs (ADR-043): what runs there, a restart asked first, a log followed.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const now = Date.now();
const SERVER: ServerView = {
  id: "S1",
  name: "vps",
  host: "203.0.113.9",
  port: 22,
  user: "deploy",
  description: "My sites.",
  auth: "oraknid-key",
  setup: "ready",
  hostKey: "SHA256:x",
  hostKeyOffered: null,
  lastSeenAt: now,
  error: null,
  busy: null,
  stateVersion: 1,
  latest: null,
  projectIds: [],
  projectId: null,
  production: false,
  productionIn: [],
  createdAt: now,
};

const container = (name: string, more: Record<string, unknown> = {}) => ({
  id: name,
  name,
  image: `${name}:1`,
  state: "running",
  status: "Up 2 hours",
  health: null,
  uptime: "2 hours",
  ports: "",
  project: null,
  service: null,
  cpuPercent: 1.5,
  memBytes: 100 * 1048576,
  memLimit: 1024 * 1048576,
  ...more,
});

let dockerError: string | null = null;
const calls: string[] = [];
const fn =
  <T,>(name: string, value: (x: Record<string, unknown>) => T) =>
  async (x: Record<string, unknown> = {}) => {
    calls.push(`${name} ${JSON.stringify(x)}`);
    return value(x);
  };

vi.mock("@/lib/api", () => ({
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  api: {
    servers: {
      list: fn("list", () => [SERVER]),
      samples: fn("samples", () => []),
      history: fn("history", () => []),
      state: fn("state", () => ({ version: 1, body: "# vps", source: "eye", createdAt: now })),
      docker: fn("docker", () => ({
        at: now,
        data: {
          engine: "docker",
          version: "27.0.3",
          error: dockerError,
          containers: dockerError
            ? []
            : [
                container("web", {
                  project: "shop",
                  health: "unhealthy",
                  ports: "127.0.0.1:3000->3000/tcp",
                }),
                container("db", { project: "shop", image: "postgres:16" }),
                container("lonely", {
                  state: "exited",
                  uptime: null,
                  status: "Exited (0) 2 days ago",
                  cpuPercent: null,
                  memBytes: null,
                }),
              ],
          images: [
            {
              repository: "old",
              tag: "1",
              id: "abc",
              sizeBytes: 2e8,
              created: "3 weeks ago",
              inUse: false,
            },
          ],
          volumes: [],
          networks: [],
        },
      })),
      databases: fn("databases", () => ({
        at: now,
        data: {
          databases: [
            {
              kind: "postgres",
              name: "db",
              source: "container",
              version: "16",
              state: "running",
              port: 5432,
              sizeBytes: null,
              note: "In a container: its size needs the database credentials.",
            },
          ],
          notes: [],
        },
      })),
      proxy: fn("proxy", () => ({
        at: now,
        data: {
          proxies: [
            {
              kind: "nginx",
              source: "service",
              name: "nginx",
              state: "active",
              version: "1.24.0",
              check: { ok: null, output: "nginx -t needs root to check the configuration." },
              sites: [
                {
                  names: ["shop.example.com"],
                  listen: ["80", "443"],
                  upstreams: ["127.0.0.1:3000"],
                  root: null,
                  redirect: null,
                  certificate: "/c.pem",
                  accessLog: null,
                },
              ],
              certificates: [
                {
                  path: "/c.pem",
                  notAfter: "x",
                  expiresAt: now + 5 * 86_400_000 + 3600_000,
                  error: null,
                },
              ],
              accessLogs: ["/var/log/nginx/access.log"],
              errorLogs: [],
              note: null,
            },
          ],
          notes: [],
        },
      })),
      traffic: fn("traffic", () => ({
        at: now,
        data: {
          windowMinutes: 15,
          logs: [
            { path: "/var/log/nginx/access.log", error: null },
            {
              path: "/var/log/nginx/other.log",
              error:
                "not readable by deploy (it belongs to www-data:adm): add deploy to the adm group.",
            },
          ],
          linesRead: 10,
          unparsed: 0,
          requests: 42,
          bytes: 2048,
          perMinute: Array(15).fill(2),
          statuses: { "2xx": 30, "3xx": 2, "4xx": 7, "5xx": 3 },
          codes: [{ code: "200", count: 30 }],
          paths: [{ path: "/api/cart", count: 12 }],
          clients: [{ client: "198.51.100.7", count: 9 }],
          connections: [{ port: "443", count: 4 }],
        },
      })),
      logSources: fn("logSources", () => [
        {
          id: "file:/var/log/nginx/access.log",
          label: "nginx: /var/log/nginx/access.log",
          kind: "proxy",
        },
        { id: "container:web", label: "web (shop)", kind: "container" },
      ]),
      logs: fn("logs", (x) => ({
        lines: x.search ? ["GET /api/cart 500"] : ["one", "two"],
        notes: [],
      })),
      restart: fn("restart", () => ({ ok: true })),
    },
    settings: { terminal: fn("terminal", () => false) },
    lock: { status: fn("lock", () => ({ full: false })) },
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  dockerError = null;
  vi.restoreAllMocks();
});

async function open(path: string) {
  const { ServersPage } = await import("@/pages/servers");
  const { hook } = memoryLocation({ path });
  render(
    <Router hook={hook}>
      <Route path="/servers/:id?/:tab?">{(p) => <ServersPage id={p.id} tab={p.tab} />}</Route>
    </Router>,
  );
}

describe("a server's tabs (ADR-043)", { timeout: 30_000 }, () => {
  it("has Overview, Chat, Jobs, Docker, Databases, Proxy & traffic, Logs, Backups, Terminal and State document", async () => {
    await open("/servers/S1");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((x) => x.textContent)).toEqual([
      "Overview",
      "Chat",
      "Jobs",
      "Docker",
      "Databases",
      "Proxy & traffic",
      "Logs",
      "Backups",
      "Terminal",
      "State document",
    ]);
    // Overview keeps the readings and what was About.
    expect(screen.getByText("Remove this server")).toBeTruthy();
  });

  it("shows containers by compose project, and restarts one only after I confirm", async () => {
    await open("/servers/S1/docker");
    expect(await screen.findByText("Compose project shop")).toBeTruthy();
    expect(screen.getByText("Other containers")).toBeTruthy();
    expect(screen.getByText("unhealthy")).toBeTruthy();
    expect(screen.getByText("Docker 27.0.3: 2 of 3 containers running.")).toBeTruthy();
    expect(screen.getByText("unused")).toBeTruthy();
    const web = screen.getByText("web").closest("li") as HTMLElement;
    fireEvent.click(within(web).getByRole("button", { name: /Restart/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/docker restart web on vps/)).toBeTruthy();
    // Leaving it changes nothing.
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave it running" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.startsWith("restart"))).toBe(false);
    fireEvent.click(within(web).getByRole("button", { name: /Restart/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Restart" }),
    );
    await waitFor(() =>
      expect(calls).toContain('restart {"id":"S1","kind":"container","name":"web","confirm":true}'),
    );
  });

  it("says why Docker can't be read", async () => {
    dockerError = "deploy can't reach the Docker socket: add deploy to the docker group.";
    await open("/servers/S1/docker");
    expect(await screen.findByText(/add deploy to the docker group/)).toBeTruthy();
  });

  it("shows databases, the proxy's sites with their certificate, and the traffic", async () => {
    await open("/servers/S1/databases");
    expect(await screen.findByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByText("port 5432")).toBeTruthy();
    cleanup();
    await open("/servers/S1/proxy");
    expect(await screen.findByText("shop.example.com")).toBeTruthy();
    expect(screen.getByText("certificate ends in 5 days").className).toContain("text-destructive");
    expect(screen.getByText("config not checked")).toBeTruthy();
    expect(await screen.findByText(/42 requests in the last 15 minutes/)).toBeTruthy();
    expect(screen.getByText("/api/cart")).toBeTruthy();
    expect(screen.getByText(/add deploy to the adm group/)).toBeTruthy();
  });

  it("follows a log while open, stops it on leaving, and searches when not following", async () => {
    const stops: string[] = [];
    let push: (l: string[]) => void = () => {};
    const { live } = await import("@/lib/live");
    vi.spyOn(live, "followLog").mockImplementation((serverId, source, onLines) => {
      push = onLines;
      calls.push(`follow ${serverId} ${source}`);
      return () => stops.push(source);
    });
    await open("/servers/S1/logs");
    await waitFor(() => expect(calls).toContain("follow S1 file:/var/log/nginx/access.log"));
    act(() => push(["GET / 200", "GET /x 404"]));
    expect(await screen.findByText("GET /x 404")).toBeTruthy();
    // Another log: the first stops.
    fireEvent.change(screen.getByLabelText("Which log"), { target: { value: "container:web" } });
    await waitFor(() => expect(calls).toContain("follow S1 container:web"));
    expect(stops).toEqual(["file:/var/log/nginx/access.log"]);
    // Not following: a search on the server.
    fireEvent.click(screen.getByRole("button", { name: /Following/ }));
    expect(stops).toEqual(["file:/var/log/nginx/access.log", "container:web"]);
    fireEvent.change(screen.getByPlaceholderText("Search, then Enter"), {
      target: { value: "500" },
    });
    fireEvent.submit(
      screen.getByPlaceholderText("Search, then Enter").closest("form") as HTMLElement,
    );
    expect(await screen.findByText("GET /api/cart 500")).toBeTruthy();
    expect(calls).toContain('logs {"id":"S1","source":"container:web","lines":500,"search":"500"}');
    cleanup();
  });
});
