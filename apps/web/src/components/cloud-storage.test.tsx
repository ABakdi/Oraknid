import type { BackupRunView, CloudProviderView, CloudTransfer } from "@oraknid/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Cloud storage in the web app (ADR-046): the providers and their add
// dialog (rclone's sign-in for Google Drive), the pool, an upload's
// progress, and a backup's download.

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

const ID = (n: number) => `01M41GSETJFT8T355BQF7W9Q${String(n).padStart(2, "0")}`;
const provider = (n: number, name: string, extra: Partial<CloudProviderView> = {}) =>
  ({
    id: ID(n),
    name,
    kind: "s3",
    detail: `MinIO · bucket b${n}`,
    preset: "Minio",
    root: `b${n}`,
    space: "limit",
    usedBytes: 1 << 20,
    freeBytes: 9 << 20,
    totalBytes: 10 << 20,
    limitBytes: 10 << 20,
    unlimited: false,
    priority: n,
    checkedAt: 1,
    error: null,
    createdAt: 1,
    ...extra,
  }) as CloudProviderView;
const MINIO = provider(1, "MinIO");
const DRIVE = provider(2, "My Drive", {
  kind: "drive",
  preset: null,
  detail: "Google Drive · Oraknid/",
  space: "provider",
  limitBytes: null,
});

const addProvider = vi.fn(async (_: unknown) => MINIO);
const authorizeStart = vi.fn(async (_: unknown) => ({
  session: "sess-12345678",
  kind: "drive" as const,
  state: "waiting" as const,
  url: "http://127.0.0.1:53682/auth?state=abc",
  error: null,
}));
const authorizeStatus = vi.fn(async (_: unknown) => ({
  session: "sess-12345678",
  kind: "drive" as const,
  state: "ready" as const,
  url: "http://127.0.0.1:53682/auth?state=abc",
  error: null,
}));
const cloudDownload = vi.fn(async (_: unknown) => ({ url: "/download/tok1", expiresAt: 1 }));
const backupDownload = vi.fn(async (_: unknown) => ({ url: "/download/tok2", expiresAt: 1 }));

vi.mock("@/lib/api", () => ({
  api: {
    cloud: {
      providers: async () => [MINIO, DRIVE],
      placement: async () => ({
        mode: "auto",
        rule: "free",
        providerId: null,
        largeFromBytes: 100 << 20,
      }),
      list: async ({ path }: { path: string }) => ({
        path,
        entries: path
          ? []
          : [
              {
                path: "docs",
                name: "docs",
                isDir: true,
                size: null,
                modTime: null,
                mimeType: null,
                providerId: null,
                providers: [ID(1), ID(2)],
              },
              {
                path: "report.pdf",
                name: "report.pdf",
                isDir: false,
                size: 2048,
                modTime: "2026-10-03T10:00:00Z",
                mimeType: "application/pdf",
                providerId: ID(2),
                providers: [ID(2)],
              },
            ],
        errors: [],
        truncated: false,
      }),
      addProvider: (x: unknown) => addProvider(x),
      authorizeStart: (x: unknown) => authorizeStart(x),
      authorizeStatus: (x: unknown) => authorizeStatus(x),
      authorizeCancel: async () => {},
      downloadLink: (x: unknown) => cloudDownload(x),
    },
    backups: {
      runs: async () => [RUN],
      downloadLink: (x: unknown) => backupDownload(x),
    },
  },
  auth: { token: () => "tok" },
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const RUN: BackupRunView = {
  id: ID(30),
  planId: ID(20),
  state: "ok",
  trigger: "manual",
  startedAt: 1,
  endedAt: 2,
  size: 1234,
  durationMs: 1000,
  checksum: "ab".repeat(32),
  location: "cloud storage, MinIO",
  path: "Oraknid backups/shop/x.sqlite.zst.age",
  keyId: ID(9),
  error: null,
  verifiedAt: null,
  verifyOk: null,
  verifyNote: null,
  prunedAt: null,
};

const { ProvidersCard, PoolBrowser } = await import("./cloud-storage");
const { BackupRuns } = await import("./backups");
const { live } = await import("@/lib/live");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const clicks = () => vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

/** A Radix menu: opened from its button by the keyboard. */
const openMenu = (name: string | RegExp) =>
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });

describe("cloud storage providers", () => {
  it("shows each provider with its space, and adds MEGA with its e-mail and password", async () => {
    render(<ProvidersCard providers={[MINIO]} />);
    expect(screen.getByText("MinIO · bucket b1")).toBeTruthy();
    expect(screen.getByText(/1 MiB used · 9 MiB free of 10 MiB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("radio", { name: "MEGA" }));
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "me@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addProvider).toHaveBeenCalledWith({
        kind: "mega",
        name: "MEGA",
        folder: "",
        email: "me@example.com",
        password: "pw-123",
      }),
    );
  });

  it("Google Drive: rclone's sign-in page to open here, then Add with the finished sign-in", async () => {
    render(<ProvidersCard providers={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Google Drive" }));
    const link = await screen.findByRole("link", { name: /Open the sign-in page/ });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:53682/auth?state=abc");
    await screen.findByText("Signed in. Add it to finish.", {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(addProvider).toHaveBeenCalledWith({
        kind: "drive",
        name: "Google Drive",
        folder: "",
        authSession: "sess-12345678",
      }),
    );
  }, 15_000);
});

/** XMLHttpRequest as the upload sees it: progress, then the answer, when the test says. */
class FakeXHR {
  static last: FakeXHR | null = null;
  url = "";
  headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  body: unknown;
  upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.body = body;
    FakeXHR.last = this;
  }
}

describe("the pool", () => {
  const renderPool = () => {
    const { hook } = memoryLocation({ path: "/storage" });
    return render(
      <Router hook={hook}>
        <PoolBrowser path="" providers={[MINIO, DRIVE]} />
      </Router>,
    );
  };

  it("lists folders across providers and each file with its own; downloads one through a one-time link", async () => {
    const click = clicks();
    renderPool();
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
    // The folder is in both; the file in My Drive only.
    expect(screen.getAllByText("MinIO")).toHaveLength(1);
    expect(screen.getAllByText("My Drive").length).toBeGreaterThanOrEqual(2);
    openMenu("Actions for report.pdf");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() =>
      expect(cloudDownload).toHaveBeenCalledWith({ providerId: ID(2), path: "report.pdf" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
  });

  it("uploads with progress: to Oraknid, then to the provider from the live socket, then where it went", async () => {
    const real = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    let push: ((t: CloudTransfer) => void) | null = null;
    vi.spyOn(live, "onTransfer").mockImplementation((l) => {
      push = l;
      return () => {};
    });
    try {
      renderPool();
      await screen.findByText("report.pdf");
      const file = new File([new Uint8Array(1000)], "song.flac");
      fireEvent.change(screen.getByTestId("upload-input"), { target: { files: [file] } });
      await waitFor(() => expect(FakeXHR.last).not.toBeNull());
      const xhr = FakeXHR.last as FakeXHR;
      expect(xhr.url).toMatch(/^\/api\/cloud\/upload\?/);
      const q = new URLSearchParams(xhr.url.split("?")[1]);
      expect(Object.fromEntries(q)).toMatchObject({
        name: "song.flac",
        size: "1000",
        provider: "auto",
        folder: "",
      });
      expect(xhr.headers.authorization).toBe("Bearer tok");
      expect(xhr.body).toBe(file);

      act(() => xhr.upload.onprogress?.({ loaded: 500, total: 1000 }));
      const bar = screen.getByRole("progressbar", { name: "Progress of song.flac" });
      expect(bar.getAttribute("aria-valuenow")).toBe("50");
      expect(screen.getByText("sending to Oraknid")).toBeTruthy();

      const id = q.get("transfer") as string;
      act(() =>
        push?.({
          id,
          name: "song.flac",
          phase: "send",
          bytes: 250,
          total: 1000,
          providerId: ID(1),
          error: null,
        }),
      );
      expect(screen.getByText("to the provider")).toBeTruthy();
      expect(
        screen
          .getByRole("progressbar", { name: "Progress of song.flac" })
          .getAttribute("aria-valuenow"),
      ).toBe("25");

      act(() => {
        xhr.status = 200;
        xhr.responseText = JSON.stringify({
          providerId: ID(1),
          path: "song.flac",
          size: 1000,
          providerName: "MinIO",
        });
        xhr.onload?.();
      });
      expect(await screen.findByText("in MinIO")).toBeTruthy();
    } finally {
      globalThis.XMLHttpRequest = real;
      FakeXHR.last = null;
    }
  });

  it("an upload refused says why, in words", async () => {
    const real = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    try {
      renderPool();
      await screen.findByText("report.pdf");
      fireEvent.change(screen.getByTestId("upload-input"), {
        target: { files: [new File([new Uint8Array(10)], "huge.iso")] },
      });
      await waitFor(() => expect(FakeXHR.last).not.toBeNull());
      act(() => {
        const x = FakeXHR.last as FakeXHR;
        x.status = 400;
        x.responseText = JSON.stringify({ message: "Too big for any one place: never split." });
        x.onload?.();
      });
      expect(await screen.findByText("Too big for any one place: never split.")).toBeTruthy();
    } finally {
      globalThis.XMLHttpRequest = real;
      FakeXHR.last = null;
    }
  });
});

describe("a backup's download", () => {
  it("as stored, or decrypted with its key", async () => {
    const click = clicks();
    render(<BackupRuns planId={ID(20)} />);
    await screen.findByText(/cloud storage, MinIO/);
    openMenu("Download");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Decrypted with its key" }));
    await waitFor(() =>
      expect(backupDownload).toHaveBeenCalledWith({ runId: ID(30), decrypt: true }),
    );
    openMenu("Download");
    fireEvent.click(await screen.findByRole("menuitem", { name: "As stored (encrypted)" }));
    await waitFor(() => expect(backupDownload).toHaveBeenLastCalledWith({ runId: ID(30) }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  });
});
