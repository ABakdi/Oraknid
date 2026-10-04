import type {
  BackupKeyView,
  BackupPlanView,
  BackupRunView,
  BackupTestResult,
  ServerView,
} from "@oraknid/contracts";
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
let providers: { id: string; name: string }[] = [];
let listed = (): BackupPlanView[] => [PLAN];
const TESTED: BackupTestResult = {
  server: { ok: true, said: "Reached db-box over SSH as me." },
  database: {
    ok: false,
    said: 'PostgreSQL 16.4 in shop-db let the login in, but has no database "shopp" (it has postgres, shop).',
    version: "16.4",
    databases: ["postgres", "shop"],
  },
  destination: {
    ok: false,
    said: "Oraknid can't write in /backups on this computer: permission denied.",
  },
};
const testPlan = vi.fn(async (_: unknown) => TESTED);

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
              // Read from its environment by the daemon: never a password's value.
              login: { user: "app", database: "shop", passwordSet: true },
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
    cloud: { providers: async () => providers },
    backups: {
      plans: async () => listed(),
      keys: async () => keys,
      runs: async () => [],
      createPlan: (x: unknown) => createPlan(x),
      updatePlan: (x: unknown) => updatePlan(x),
      testPlan: (x: unknown) => testPlan(x),
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
  hasUri: false,
  nextRunAt: null,
  running: false,
  lastRun: null,
  createdAt: 1,
};

const { PlanForm, BackupKeys, BackupPlans, RestoreDialog } = await import("./backups");
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
        options: {
          mysql: {
            tls: "default",
            singleTransaction: true,
            routines: true,
            events: false,
            triggers: true,
          },
        },
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

/** A plan with a value in every field, none of them the form's defaults. */
const FULL: BackupPlanView = {
  ...PLAN,
  id: ID(21),
  name: "Ledger",
  target: {
    serverId: ID(1),
    kind: "postgres",
    container: null,
    host: "10.0.0.5",
    port: 5433,
    database: "ledger",
    user: "books",
    path: null,
    options: {
      postgres: {
        sslmode: "require",
        schemas: ["sales", "hr"],
        format: "custom",
        extra: ["--no-comments", "--exclude-table-data=logs"],
      },
    },
  },
  schedule: { kind: "weekly", day: 3, at: "04:15" },
  destination: { kind: "cloud", providerId: ID(7), folder: "Books/backups" },
  retention: { count: 7, days: 60 },
  keyId: KEY.id,
  enabled: false,
  hasPassword: true,
};

const value = (label: string | RegExp) => (screen.getByLabelText(label) as HTMLInputElement).value;
const shown = (label: string | RegExp) => screen.getByLabelText(label).textContent;

describe("a saved plan opened again (ADR-044 → Changed 2026-10-04)", () => {
  it("shows every value it was saved with, even after another form was open, and saves it unchanged", async () => {
    providers = [{ id: ID(7), name: "B2" }];
    keys = [KEY];
    listed = () => [PLAN, FULL];
    render(<BackupPlans />);
    // A new plan's form first (its defaults), then Edit: the plan's own values, not the defaults.
    fireEvent.click(await screen.findByRole("button", { name: "New backup plan" }));
    type("Name", "typed in the new form");
    fireEvent.click(screen.getByRole("button", { name: "Edit Shop" }));
    expect(value("Name")).toBe("Shop");
    fireEvent.click(screen.getByRole("button", { name: "Edit Ledger" }));
    expect(screen.getByText("Change the plan")).toBeTruthy();
    expect(value("Name")).toBe("Ledger");
    expect(shown("Kind")).toBe("PostgreSQL");
    expect(screen.queryByLabelText("Container name")).toBeNull();
    expect(value("Host")).toBe("10.0.0.5");
    expect(value("Port")).toBe("5433");
    expect(value("Database")).toBe("ledger");
    expect(value("User")).toBe("books");
    expect(value("Password")).toBe("");
    expect(screen.getByLabelText("Password").getAttribute("placeholder")).toBe(
      "kept; type to change",
    );
    expect(shown("Every")).toBe("Week");
    expect(shown("On")).toBe("Wednesday");
    expect(value("At")).toBe("04:15");
    await waitFor(() => expect(shown("Kept on")).toBe("Cloud storage: B2"));
    expect(value("Folder")).toBe("Books/backups");
    expect(value("Keep the last")).toBe("7");
    expect(value("None older than (days)")).toBe("60");
    expect(shown("Encryption")).toBe("age key Offsite");
    fireEvent.click(screen.getByRole("button", { name: /Advanced: PostgreSQL's own fields/ }));
    expect(shown("TLS (sslmode)")).toBe("require");
    expect(shown("Dump format")).toBe("Custom (pg_restore)");
    expect(value("Schemas")).toBe("sales, hr");
    expect(value("More pg_dump options")).toBe("--no-comments --exclude-table-data=logs");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePlan).toHaveBeenCalled());
    // Exactly what it was saved with: no default, no password, and paused stays the switch's.
    expect(updatePlan.mock.calls[0]?.[0]).toEqual({
      id: FULL.id,
      name: FULL.name,
      target: FULL.target,
      schedule: FULL.schedule,
      destination: FULL.destination,
      retention: FULL.retention,
      keyId: FULL.keyId,
    });
    providers = [];
    listed = () => [PLAN];
  }, 30_000);

  it("Test connection sends the form as it is (the kept password by the plan's id) and shows each part; a database it lists can be picked", async () => {
    render(<PlanForm plan={FULL} servers={SERVERS} keys={[KEY]} onDone={() => {}} />);
    type("Database", "shopp");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const results = await screen.findByRole("status", { name: "Test results" });
    expect(results.textContent).toContain("Server: Reached db-box over SSH as me.");
    expect(results.textContent).toContain('has no database "shopp"');
    expect(results.textContent).toContain("Where to: Oraknid can't write in /backups");
    expect(testPlan).toHaveBeenCalledTimes(1);
    const sent = testPlan.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      planId: FULL.id,
      target: { ...FULL.target, database: "shopp" },
      destination: FULL.destination,
    });
    expect(sent).not.toHaveProperty("password");
    expect(sent).not.toHaveProperty("enabled");
    fireEvent.click(screen.getByRole("button", { name: "shop" }));
    expect(value("Database")).toBe("shop");
    // Nothing was saved by testing.
    expect(updatePlan).not.toHaveBeenCalled();
  }, 20_000);
});

describe("each kind's own fields, under Advanced", () => {
  it("shows a kind's own fields only, and sends them with the plan", async () => {
    const done = vi.fn();
    render(<PlanForm serverId={ID(1)} servers={SERVERS} keys={[]} onDone={done} />);
    const advanced = (kind: string) =>
      screen.getByRole("button", { name: `Advanced: ${kind}'s own fields` });
    fireEvent.click(advanced("PostgreSQL"));
    expect(screen.getByLabelText("TLS (sslmode)")).toBeTruthy();
    // An option off the list is refused before it's sent.
    type("More pg_dump options", "--file=/etc/passwd");
    type("Name", "x");
    type("Container name", "db");
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    expect(
      await screen.findByText("--file=/etc/passwd isn't a pg_dump option Oraknid passes on."),
    ).toBeTruthy();
    expect(createPlan).not.toHaveBeenCalled();

    await choose("Kind", "MySQL / MariaDB");
    expect(screen.queryByLabelText("TLS (sslmode)")).toBeNull();
    expect(screen.getByRole("switch", { name: "Events" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Triggers" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /One transaction/ })).toBeTruthy();

    await choose("Kind", "Redis");
    expect(screen.getByLabelText("Database number")).toBeTruthy();
    expect(screen.getByLabelText("User (ACL)")).toBeTruthy();

    await choose("Kind", "SQLite");
    expect(screen.queryByRole("button", { name: /Advanced/ })).toBeNull();

    await choose("Kind", "MongoDB");
    type("Authentication database", "shop");
    type("Replica set", "rs0");
    await choose("TLS", "On, without checking its certificate");
    await choose("Read preference", "secondaryPreferred");
    type("User", "app");
    type("Password", "pw-typed");
    fireEvent.click(
      screen.getByRole("switch", { name: "Connect with a connection string instead" }),
    );
    // The fields of where and who give way to the string.
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    type("Connection string", "mongodb://app:pw@10.0.0.9/shop?authSource=shop");
    fireEvent.click(screen.getByRole("button", { name: "Make the plan" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const sent = createPlan.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      target: {
        kind: "mongodb",
        container: "db",
        user: "app",
        options: {
          mongodb: {
            authSource: "shop",
            replicaSet: "rs0",
            tls: "insecure",
            readPreference: "secondaryPreferred",
          },
        },
      },
      uri: "mongodb://app:pw@10.0.0.9/shop?authSource=shop",
    });
    // Only the kind's own fields go, and no password beside the string.
    expect(Object.keys((sent.target as { options: object }).options)).toEqual(["mongodb"]);
    expect(sent).not.toHaveProperty("password");
  }, 30_000);
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
    // Its login, as its container's environment says it; the password never filled in.
    expect(value("User")).toBe("app");
    expect(value("Database")).toBe("shop");
    expect(value("Password")).toBe("");
    expect(
      screen.getByText(
        "A password is set in the container's environment: type it here (Oraknid doesn't read it from there).",
      ),
    ).toBeTruthy();
    await choose("Found on the server", "redis 7.2 · redis-server");
    expect(value("User (ACL)")).toBe("");
    expect(screen.queryByText(/A password is set in the container's environment/)).toBeNull();
    expect(screen.queryByLabelText("Container name")).toBeNull();
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("6380");
  }, 20_000);
});
