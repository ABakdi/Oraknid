import type { ServerTestResult, ServerView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Servers that are easy to add and fix (Servers → Adding one, Testing the
// connection, Editing a server): the key file first, pasting second, Test
// connection inline, the same dialog prefilled to edit, Fix wording.

const add = vi.fn(async (x: Record<string, unknown>) => ({ ...SERVER, ...x }) as ServerView);
const update = vi.fn(async (x: Record<string, unknown>) => ({ ...SERVER, ...x }) as ServerView);
let answer: ServerTestResult = {
  ok: true,
  said: "Logged in as root: Linux 6.1.0-18-amd64 (vps1).",
  system: "Linux 6.1.0-18-amd64",
  hostname: "vps1",
  fingerprint: "SHA256:abcdefghijklmnop",
};
const test = vi.fn(async (_: Record<string, unknown>) => answer);
const polish = vi.fn(async (_: { text: string; kind?: string }) => ({
  text: "The VPS for my sites: nginx and Postgres.",
}));
const toasts = { success: vi.fn(), error: vi.fn() };

vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toasts.success(...a),
    error: (...a: unknown[]) => toasts.error(...a),
  },
}));
vi.mock("@/lib/api", () => ({
  api: {
    servers: {
      add: (x: Record<string, unknown>) => add(x),
      update: (x: Record<string, unknown>) => update(x),
      test: (x: Record<string, unknown>) => test(x),
    },
    text: { polish: (x: { text: string; kind?: string }) => polish(x) },
  },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const SERVER = {
  id: "01M41GSETJFT8T355BQF7W9Q01",
  name: "vps",
  host: "203.0.113.7",
  port: 22,
  user: "root",
  description: "nginx",
  auth: "my-key",
  setup: "ready",
  hostKey: "SHA256:old",
  hostKeyOffered: null,
  lastSeenAt: null,
  error: "vps refused the SSH login of root: check the server's key or password.",
  stale: false,
  busy: null,
  stateVersion: 1,
  latest: null,
  projectIds: [],
  projectId: null,
  production: false,
  productionIn: [],
  createdAt: 1,
} as ServerView;

/** An OpenSSH private key's armour around its header: the cipher named, "none" or another. */
function openSshKey(cipher = "none") {
  const header = `openssh-key-v1\0\0\0\0${String.fromCharCode(cipher.length)}${cipher}`;
  const body = btoa(header + "x".repeat(60));
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const { AddServer, lookAtKey } = await import("./add-server");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the add-server dialog", () => {
  it("takes the key from a file by default, and adds the server with it", async () => {
    const added = vi.fn();
    render(<AddServer open onOpenChange={() => {}} onAdded={added} />);
    // No textarea for the key until I ask to paste.
    expect(document.getElementById("sv-key")).toBeNull();
    expect(screen.getByText("Choose the key file")).toBeTruthy();
    type("Name", "vps");
    type("Host", "203.0.113.7");
    const key = openSshKey();
    fireEvent.change(screen.getByLabelText("Private key"), {
      target: { files: [new File([key], "id_ed25519")] },
    });
    expect(await screen.findByText("id_ed25519 · OpenSSH private key")).toBeTruthy();
    expect(screen.getByText("OpenSSH private key read.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(added).toHaveBeenCalled());
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "vps", host: "203.0.113.7", port: 22, privateKey: key }),
    );
  });

  it("pastes as the other way, in a box that scrolls, and warns of a public key", () => {
    render(<AddServer open onOpenChange={() => {}} />);
    type("Name", "vps");
    type("Host", "203.0.113.7");
    fireEvent.click(screen.getByRole("button", { name: "Paste it instead" }));
    const box = screen.getByLabelText("Private key") as HTMLTextAreaElement;
    expect(box.tagName).toBe("TEXTAREA");
    // Fixed in size: a long key never widens the dialog.
    expect(box.getAttribute("wrap")).toBe("off");
    expect(box.className).toMatch(/field-sizing-fixed/);
    expect(box.className).toMatch(/resize-none/);
    expect(box.className).toMatch(/overflow-auto/);
    type(
      "Private key",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@box",
    );
    expect(screen.getByText(/This is a public key \(\.pub\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    // An encrypted key asks for its passphrase.
    type("Private key", openSshKey("aes256-ctr"));
    expect(screen.getByText("OpenSSH private key, with a passphrase: type it below.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("tests the connection with the form's values and shows what it found", async () => {
    render(<AddServer open onOpenChange={() => {}} />);
    type("Host", "203.0.113.7");
    type("Port", "2222");
    fireEvent.click(screen.getByRole("button", { name: "A password" }));
    type("Password", "pw");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Logged in as root: Linux 6.1.0-18-amd64 (vps1).")).toBeTruthy();
    expect(screen.getByText(/SHA256:abcdefghijklmnop/)).toBeTruthy();
    expect(test).toHaveBeenCalledWith({
      host: "203.0.113.7",
      port: 2222,
      user: "root",
      password: "pw",
    });
    expect(add).not.toHaveBeenCalled();
    // A failure, in its words; a change of the form clears the last answer.
    answer = {
      ok: false,
      said: "203.0.113.7 (203.0.113.7:2222) gave no answer: it may be off, or a firewall is in the way.",
      system: null,
      hostname: null,
      fingerprint: null,
    };
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/gave no answer/)).toBeTruthy();
    type("Port", "22");
    expect(screen.queryByText(/gave no answer/)).toBeNull();
  });

  it("edits a server: prefilled, credentials kept when empty, only what changed sent", async () => {
    render(<AddServer server={SERVER} open onOpenChange={() => {}} />);
    expect(screen.getByText("Edit vps")).toBeTruthy();
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("203.0.113.7");
    expect((screen.getByLabelText("What it is and what it has") as HTMLTextAreaElement).value).toBe(
      "nginx",
    );
    expect(screen.getByText("Empty: the key you gave stays.")).toBeTruthy();
    // Test with the kept credentials: the server's id, no key.
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(test).toHaveBeenCalledWith({
        id: SERVER.id,
        host: "203.0.113.7",
        port: 22,
        user: "root",
      }),
    );
    type("User", "deploy");
    type("Its passphrase, if it has one", "secret");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ id: SERVER.id, user: "deploy", passphrase: "secret" }),
    );
  });

  it("fixes the description's wording, and undoes it", async () => {
    render(<AddServer open onOpenChange={() => {}} />);
    type("What it is and what it has", "the vps for my sites nginx postgres");
    fireEvent.click(screen.getByRole("button", { name: "Fix wording" }));
    const desc = screen.getByLabelText("What it is and what it has") as HTMLTextAreaElement;
    await waitFor(() => expect(desc.value).toBe("The VPS for my sites: nginx and Postgres."));
    expect(polish).toHaveBeenCalledWith({
      text: "the vps for my sites nginx postgres",
      kind: "server-description",
    });
    // Undo in the toast and next to the button.
    expect(toasts.success.mock.calls[0]?.[1]).toMatchObject({ action: { label: "Undo" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(desc.value).toBe("the vps for my sites nginx postgres");
  });

  it("says plainly when no model can rephrase", async () => {
    polish.mockRejectedValueOnce(new Error("No model can rephrase text right now."));
    render(<AddServer open onOpenChange={() => {}} />);
    type("What it is and what it has", "helo");
    fireEvent.click(screen.getByRole("button", { name: "Fix wording" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("No model can rephrase text right now."),
    );
    expect((screen.getByLabelText("What it is and what it has") as HTMLTextAreaElement).value).toBe(
      "helo",
    );
  });
});

describe("lookAtKey", () => {
  it("names private keys and refuses public ones", () => {
    expect(lookAtKey(openSshKey())).toMatchObject({ ok: true, encrypted: false });
    expect(lookAtKey(openSshKey("aes256-ctr"))).toMatchObject({ ok: true, encrypted: true });
    expect(
      lookAtKey(
        "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----",
      ),
    ).toMatchObject({ ok: true, label: "RSA private key (PEM)", encrypted: true });
    expect(lookAtKey("ssh-rsa AAAAB3NzaC1yc2E me").ok).toBe(false);
    expect(lookAtKey("hello").label).toBe("This doesn't look like a private key.");
  });
});
