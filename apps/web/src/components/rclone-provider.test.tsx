import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CloudAddStep, RcloneBackend } from "@oraknid/contracts";
import { readRcloneSchema, summaryOf } from "@oraknid/core/rclone";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Any provider rclone supports, in the web app (ADR-046 → Changed
// 2026-10-04): the searchable list, the form made of one backend's schema
// (required first, the rest under Advanced, a service's own options,
// password fields), and rclone's questions. The schema is the one the real
// rclone v1.75.1 printed (recorded).

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
});

const SCHEMA = readRcloneSchema(
  JSON.parse(
    gunzipSync(
      readFileSync(
        join(__dirname, "../../../../packages/core/src/fixtures/rclone-providers-v1.75.1.json.gz"),
      ),
    ).toString("utf8"),
  ),
);
const byName = (n: string) => SCHEMA.find((b) => b.name === n) as RcloneBackend;

const ID = "01M41GSETJFT8T355BQF7W9Q01";
const added: CloudAddStep = {
  provider: {
    id: ID,
    name: "x",
    kind: "rclone",
    backend: "sftp",
    detail: "SSH/SFTP · the whole account",
    preset: null,
    root: "",
    space: "unknown",
    usedBytes: null,
    freeBytes: null,
    totalBytes: null,
    limitBytes: null,
    unlimited: false,
    priority: 0,
    checkedAt: null,
    error: null,
    createdAt: 1,
  },
  question: null,
};

const addRclone = vi.fn(async (_: unknown): Promise<CloudAddStep> => added);
const answerRclone = vi.fn(async (_: unknown): Promise<CloudAddStep> => added);
const cancelRclone = vi.fn(async (_: unknown) => {});
const authorizeStart = vi.fn(async (_: unknown) => ({
  session: "sess-12345678",
  kind: "onedrive",
  state: "ready" as const,
  url: "http://127.0.0.1:53682/auth?state=abc",
  error: null,
}));

vi.mock("@/lib/api", () => ({
  api: {
    cloud: {
      backends: async () => ({ version: "rclone v1.75.1", backends: SCHEMA.map(summaryOf) }),
      backend: async ({ name }: { name: string }) => byName(name),
      addRclone: (x: unknown) => addRclone(x),
      answerRclone: (x: unknown) => answerRclone(x),
      cancelRclone: (x: unknown) => cancelRclone(x),
      authorizeStart: (x: unknown) => authorizeStart(x),
      authorizeStatus: async () => authorizeStart({}),
      authorizeCancel: async () => {},
      providers: async () => [],
    },
  },
  auth: { token: () => "tok" },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { RclonePicker, RcloneProviderForm } = await import("./rclone-provider");
const { ProvidersCard } = await import("./cloud-storage");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const form = (name: string, onDone = () => {}) =>
  render(
    <RcloneProviderForm
      name={name}
      onBack={() => {}}
      onDone={onDone}
      spaceFields={() => <div>space</div>}
    />,
  );

const pick = async (trigger: HTMLElement, option: RegExp) => {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
};

describe("rclone's providers, searched by name", () => {
  it("lists every one, finds them by name, title or another name, and picks one", async () => {
    const onPick = vi.fn();
    render(<RclonePicker onPick={onPick} />);
    const list = await screen.findByRole("list", { name: "rclone's providers" });
    expect(within(list).getAllByRole("button")).toHaveLength(55);
    const search = screen.getByRole("textbox", { name: "Search rclone's providers" });
    fireEvent.change(search, { target: { value: "ssh" } });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["SSH/SFTPsftp"]);
    fireEvent.change(search, { target: { value: "one" } });
    const first = within(list).getAllByRole("button")[0] as HTMLElement;
    expect(first.textContent).toContain("Microsoft OneDrive");
    expect(first.textContent).toContain("browser sign-in");
    fireEvent.change(search, { target: { value: "tardigrade" } });
    expect(within(list).getByRole("button").textContent).toContain("Storj");
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No provider of rclone's is called that.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "webdav" } });
    fireEvent.click(within(list).getByRole("button"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "webdav" }));
  });

  it("Google Drive, Dropbox and MEGA found there open their short forms", async () => {
    render(<ProvidersCard providers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("radio", { name: "Another provider" }));
    const search = await screen.findByRole("textbox", { name: "Search rclone's providers" });
    fireEvent.change(search, { target: { value: "mega" } });
    fireEvent.click(screen.getByRole("button", { name: /^Mega/ }));
    expect(screen.getByRole("radio", { name: "MEGA" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("E-mail")).toBeTruthy();
  });
});

describe("the form made of a backend's schema", () => {
  it("SFTP: the required host first, the password a password field, the rest under Advanced", async () => {
    const onDone = vi.fn();
    form("sftp", onDone);
    const host = await screen.findByLabelText(/SSH host to connect to/);
    const fields = [...document.querySelectorAll("[data-option]")].map((e) =>
      e.getAttribute("data-option"),
    );
    expect(fields[0]).toBe("host");
    expect(host.closest("[data-option]")?.textContent).toContain("*");
    const pass = screen.getByLabelText(/SSH password/) as HTMLInputElement;
    expect(pass.type).toBe("password");
    expect((screen.getByLabelText(/SSH port number/) as HTMLInputElement).placeholder).toBe("22");
    // Advanced: closed, its fields not there until opened.
    expect(document.querySelector('[data-option="known_hosts_file"]')).toBeNull();
    const toggle = screen.getByRole("button", { name: /^Advanced \(\d+\)$/ });
    fireEvent.click(toggle);
    expect(document.querySelector('[data-option="known_hosts_file"]')).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(host, { target: { value: "files.example.org" } });
    fireEvent.change(pass, { target: { value: "pw-S3cr3t" } });
    fireEvent.change(screen.getByLabelText("Folder in the account"), {
      target: { value: "Oraknid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addRclone).toHaveBeenCalledWith({
        name: "SSH/SFTP",
        backend: "sftp",
        options: { host: "files.example.org", pass: "pw-S3cr3t" },
        authSession: null,
        folder: "Oraknid",
        limitBytes: null,
        unlimited: false,
      }),
    );
    expect(onDone).toHaveBeenCalled();
    // The password is never shown as text.
    expect(document.body.textContent).not.toContain("pw-S3cr3t");
  });

  it("S3: the service first; then only that service's options", async () => {
    form("s3");
    const service = await screen.findByRole("combobox", { name: /Choose your S3 provider/ });
    expect(document.querySelector('[data-option="endpoint"]')).toBeNull();
    expect(screen.getByText("Pick the service: its own options follow.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Bucket, and a folder in it")).toBeTruthy();

    await pick(service, /^Minio Object Storage/);
    expect(document.querySelector('[data-option="endpoint"]')).toBeTruthy();
    expect(
      document.querySelector('[data-option="secret_access_key"] input')?.getAttribute("type"),
    ).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    expect(document.querySelector('[data-option="requester_pays"]')).toBeNull();

    await pick(
      screen.getByRole("combobox", { name: /Choose your S3 provider/ }),
      /^Amazon Web Services/,
    );
    expect(document.querySelector('[data-option="requester_pays"]')).toBeTruthy();
    // AWS's regions offered, not Hetzner's.
    const regions = [...document.querySelectorAll('[data-option="region"] datalist option')].map(
      (o) => o.getAttribute("value"),
    );
    expect(regions).toContain("eu-west-1");
    expect(regions).not.toContain("fsn1");
    await pick(
      screen.getByRole("combobox", { name: /Choose your S3 provider/ }),
      /^Hetzner Object Storage/,
    );
    const hetzner = [...document.querySelectorAll('[data-option="region"] datalist option')].map(
      (o) => o.getAttribute("value"),
    );
    expect(hetzner).toContain("fsn1");
    expect(hetzner).not.toContain("eu-west-1");
    // Hundreds of S3 fields in jsdom: ~4 s alone, up to 30 s when every package tests at once.
  }, 60_000);

  it("a backend that signs in through a browser: Add only once signed in, with the form's region", async () => {
    form("onedrive");
    await screen.findByText("Microsoft OneDrive");
    expect(document.querySelector('[data-option="client_secret"]')).toBeNull();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Microsoft OneDrive" }));
    await screen.findByText("Signed in. Add it to finish.");
    expect(authorizeStart).toHaveBeenCalledWith({ kind: "onedrive", options: {} });
    // rclone asks which drive: answered, then added.
    addRclone.mockResolvedValueOnce({
      provider: null,
      question: {
        pending: "pend-12345678",
        error: null,
        option: {
          name: "config_type",
          help: "Type of connection",
          type: "string",
          default: "onedrive",
          required: true,
          advanced: false,
          password: false,
          secret: false,
          exclusive: true,
          examples: [
            { value: "onedrive", help: "OneDrive Personal or Business", provider: null },
            { value: "sharepoint", help: "Root Sharepoint site", provider: null },
          ],
          provider: null,
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("rclone asks, to finish setting up Microsoft OneDrive:");
    expect(addRclone).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "onedrive", authSession: "sess-12345678" }),
    );
    await pick(screen.getByRole("combobox", { name: /Type of connection/ }), /Root Sharepoint/);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(answerRclone).toHaveBeenCalledWith({ pending: "pend-12345678", answer: "sharepoint" }),
    );
  });

  it("a code rclone asks for is a password field; cancelling gives the add up", async () => {
    addRclone.mockResolvedValueOnce({
      provider: null,
      question: {
        pending: "pend-87654321",
        error: "wrong code",
        option: {
          name: "config_2fa",
          help: "Two-factor authentication: please enter your 2FA code",
          type: "string",
          default: "",
          required: true,
          advanced: false,
          password: true,
          secret: true,
          exclusive: false,
          examples: [],
          provider: null,
        },
      },
    });
    form("pikpak");
    fireEvent.change(await screen.findByLabelText(/Pikpak username/), { target: { value: "me" } });
    fireEvent.change(screen.getByLabelText(/Pikpak password/), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const code = (await screen.findByLabelText(/2FA code/)) as HTMLInputElement;
    expect(code.type).toBe("password");
    expect(screen.getByText("wrong code")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelRclone).toHaveBeenCalledWith({ pending: "pend-87654321" });
  });
});
