import type { BackupKeyView, BackupPlanView, BackupRunView, ServerView } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Backups in the web app (ADR-044): the plan's form, the keys (the private
// one shown once), Restore in two steps.

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix's select asks for these; jsdom has none.
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

const ID = (n: number) => `01M41GSETJFT8T355BQF7W9Q${String(n).padStart(2, "0")}`;
const server = (n: number, name: string) => ({ id: ID(n), name }) as ServerView;
const SERVERS = [server(1, "db-box"), server(2, "storage-box")];
const KEY: BackupKeyView = {
  id: ID(9),
  name: "Offsite",
  publicKey: "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq",
  imported: false,
  exportedAt: null,
  createdAt: 1,
  planCount: 0,
};
const PRIVATE = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQSAMPLE";

let keys: BackupKeyView[] = [];
const createPlan = vi.fn(async (_: unknown) => ({}));
const updatePlan = vi.fn(async (_: unknown) => ({}));
const createKey = vi.fn(async (x: { name: string }) => {
  const k = { ...KEY, id: ID(10), name: x.name };
  keys = [...keys, k];
  return k;
});
const exportKey = vi.fn(async (x: { id: string }) => {
  const k = keys.find((y) => y.id === x.id) as BackupKeyView;
  if (k.exportedAt) throw new Error("This key's private half was already taken once.");
  keys = keys.map((y) => (y.id === x.id ? { ...y, exportedAt: 5 } : y));
  return { name: k.name, publicKey: k.publicKey, privateKey: PRIVATE };
});
const prepareRestore = vi.fn(async (_: unknown) => ({
  token: "tok",
  summary: 'Replace the database "shop" in the container shop-db on db-box with the backup of …',
  confirmWord: "shop",
  expiresAt: Date.now() + 60_000,
}));
const restore = vi.fn(async (_: unknown) => ({ note: "Restored." }));

vi.mock("@/lib/api", () => ({
  api: {
    servers: {
      list: async () => SERVERS,
      databases: async () => ({
        at: 1,
        data: {
          databases: [
            {
              kind: "postgres",
              name: "shop-db",
              source: "container",
              version: "16.4",
              state: "running",
              port: 5432,
              sizeBytes: null,
              note: null,
            },
            {
              kind: "redis",
              name: "redis-server",
              source: "service",
              version: "7.2",
              state: "active",
              port: 6380,
              sizeBytes: null,
              note: null,
            },
          ],
          notes: [],
        },
      }),
    },
    backups: {
      plans: async () => [PLAN],
      keys: async () => keys,
      runs: async () => [],
      createPlan: (x: unknown) => createPlan(x),
      updatePlan: (x: unknown) => updatePlan(x),
      createKey: (x: { name: string }) => createKey(x),
      exportKey: (x: { id: string }) => exportKey(x),
      prepareRestore: (x: unknown) => prepareRestore(x),
      restore: (x: unknown) => restore(x),
    },
  },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const PLAN: BackupPlanView = {
  id: ID(20),
  name: "Shop",
  target: {
    serverId: ID(1),
    kind: "mysql",
    container: "shop-db",
    host: null,
    port: null,
    database: "shop",
    user: "app",
    path: null,
  },
  schedule: { kind: "daily", at: "03:30" },
  destination: { kind: "local", folder: "~/Backups/oraknid" },
  retention: { count: 14, days: null },
  keyId: KEY.id,
  enabled: true,
  hasPassword: true,
  nextRunAt: null,
  running: false,
  lastRun: null,
  createdAt: 1,
};

const { PlanForm, BackupKeys, RestoreDialog } = await import("./backups");
const { ServerBackupsTab } = await import("./server-backups");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Opens a Radix select by its label and picks an option. */
async function choose(label: string | RegExp, option: string | RegExp) {
  const trigger = screen.getByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("a backup plan's form", () => {
  it("takes a database found on the server, a cron line and a password, and sends them", async () => {
    const done = vi.fn();
    render(
      <PlanForm
        serverId={ID(1)}
        servers={SERVERS}
        keys={[KEY]}
        databases={[
          { kind: "mysql", container: "shop-db", database: "shop", label: "MariaDB 11 in shop-db" },
        ]}
        onDone={done}
      />,
    );
    await choose("Found on the server", "MariaDB 11 in shop-db");
    expect((screen.getByLabelText("Container name") as HTMLInputElement).value).toBe("shop-db");
    expect((screen.getByLabelText("Database") as HTMLInputElement).value).toBe("shop");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("MariaDB 11 in shop-db");
    type("User", "app");
    type("Password", "s3cret");
    await choose("Every", "A cron line");
    type("Cron line", "15 */6 * * *");
    await choose("Kept on", "storage-box");
    type("Folder", "backups/shop");
    type("None older than (days)", "30");
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createPlan).toHaveBeenCalledWith({
      name: "MariaDB 11 in shop-db",
      target: {
        serverId: ID(1),
        kind: "mysql",
        container: "shop-db",
        host: null,
        port: null,
        database: "shop",
        user: "app",
        path: null,
      },
      schedule: { kind: "cron", line: "15 */6 * * *" },
      destination: { kind: "server", serverId: ID(2), folder: "backups/shop" },
      retention: { count: 14, days: 30 },
      keyId: KEY.id,
      enabled: true,
      password: "s3cret",
    });
  }, 20_000);

  it("describes one on the host, and says what's missing before sending", async () => {
    render(<PlanForm servers={SERVERS} keys={[]} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    expect(await screen.findByText("Give the plan a name.")).toBeTruthy();
    type("Name", "Blog");
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    expect(await screen.findByText("Give the container's name.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "It runs in a Docker container" }));
    expect(screen.queryByLabelText("Container name")).toBeNull();
    await choose("Kind", "SQLite");
    expect(screen.queryByLabelText("Password")).toBeNull();
    type("Database file", "/srv/blog/blog.db");
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    await waitFor(() => expect(createPlan).toHaveBeenCalled());
    expect(createPlan.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: "sqlite", container: null, path: "/srv/blog/blog.db" },
      keyId: null,
    });
    expect(createPlan.mock.calls[0]?.[0]).not.toHaveProperty("password");
  }, 20_000);

  it("keeps the kept password when I change a plan without typing one", async () => {
    render(<PlanForm plan={PLAN} servers={SERVERS} keys={[KEY]} onDone={() => {}} />);
    expect(screen.getByLabelText("Password").getAttribute("placeholder")).toBe(
      "kept; type to change",
    );
    type("Name", "Shop (nightly)");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalled());
    expect(updatePlan.mock.calls[0]?.[0]).toMatchObject({ id: PLAN.id, name: "Shop (nightly)" });
    expect(updatePlan.mock.calls[0]?.[0]).not.toHaveProperty("password");
  });
});

describe("keys", () => {
  it("makes a key and shows its private half once, to download; never again", async () => {
    keys = [];
    render(<BackupKeys />);
    fireEvent.click(await screen.findByRole("button", { name: "Make a key" }));
    type("Name", "Laptop");
    fireEvent.click(screen.getByRole("button", { name: "Make it" }));
    expect((await screen.findByTestId("private-key")).textContent).toBe(PRIVATE);
    expect(screen.getByText(/Shown this once/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(createKey).toHaveBeenCalledWith({ name: "Laptop" });
    expect(exportKey).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("private-key")).toBeNull());
    // The list shows the public half only.
    expect(document.body.textContent).not.toContain(PRIVATE);
  });

  it("offers a key not yet taken: once", async () => {
    keys = [KEY];
    const { unmount } = render(<BackupKeys />);
    expect(
      await screen.findByText(/isn't saved anywhere but this computer's keychain/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take the private key (once)" }));
    expect((await screen.findByTestId("private-key")).textContent).toBe(PRIVATE);
    unmount();
    render(<BackupKeys />);
    await screen.findByText("Offsite");
    expect(screen.queryByRole("button", { name: "Take the private key (once)" })).toBeNull();
    expect(screen.queryByText(/isn't saved anywhere/)).toBeNull();
  });
});

describe("restore", () => {
  it("asks twice: what it replaces, then the database's name typed back", async () => {
    const run = { id: ID(30), planId: PLAN.id, startedAt: 1 } as BackupRunView;
    const close = vi.fn();
    render(<RestoreDialog run={run} onClose={close} />);
    const next = await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
    expect(await screen.findByText(/Replace the database "shop"/)).toBeTruthy();
    expect(prepareRestore).toHaveBeenCalledWith({ runId: run.id });
    const go = screen.getByRole("button", { name: "Restore now" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(/Type .*shop.* to confirm/, "sho");
    expect(go.disabled).toBe(true);
    type(/Type .*shop.* to confirm/, "shop");
    expect(go.disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(restore).toHaveBeenCalledWith({ token: "tok", confirm: "shop" });
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
});

describe("a server's Backups tab", () => {
  it("offers the databases found on the server: a container's by its name, a service by its port", async () => {
    render(<ServerBackupsTab server={{ ...SERVERS[0], setup: "ready" } as ServerView} />);
    fireEvent.click(await screen.findByRole("button", { name: "New backup plan" }));
    await choose("Found on the server", "postgres 16.4 · container shop-db");
    expect((screen.getByLabelText("Container name") as HTMLInputElement).value).toBe("shop-db");
    await choose("Found on the server", "redis 7.2 · redis-server");
    expect(screen.queryByLabelText("Container name")).toBeNull();
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("6380");
  }, 20_000);
});
