import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mail's sign-in with Google and Microsoft (ADR-063): the apps I register,
// and the sign-in, a page in a new tab or a code to type.

let apps = [
  {
    provider: "google",
    clientId: "",
    hasSecret: false,
    redirectUri: "http://127.0.0.1:7417/oauth/mail/callback",
    ready: false,
  },
  {
    provider: "microsoft",
    clientId: "ms-app",
    hasSecret: false,
    redirectUri: "http://127.0.0.1:7417/oauth/mail/callback",
    ready: true,
  },
];
const setOAuthApp = vi.fn(async (_: unknown) => undefined);
let status = { state: "pending", email: null as string | null, error: null };
vi.mock("@/lib/api", () => ({
  api: {
    mail: {
      oauthApps: async () => apps,
      setOAuthApp: (x: unknown) => setOAuthApp(x),
      oauthStart: async (x: { provider: string }) =>
        x.provider === "microsoft"
          ? {
              kind: "device",
              id: "s1",
              userCode: "ABCD-1234",
              verificationUri: "https://microsoft.com/devicelogin",
              expiresAt: Date.now() + 900_000,
            }
          : { kind: "browser", id: "s2", url: "https://accounts.example/auth" },
      oauthStatus: async () => status,
    },
  },
  message: (e: unknown) => String(e),
}));

const { MailOAuthAppsCard, OAuthSignIn } = await import("./mail-oauth");

afterEach(() => {
  cleanup();
  setOAuthApp.mockClear();
});

describe("mail's OAuth apps", () => {
  it("says which app is ready, shows the redirect, and saves Google's id and secret", async () => {
    render(<MailOAuthAppsCard />);
    expect(await screen.findByText("not set up")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getAllByText("http://127.0.0.1:7417/oauth/mail/callback")).toHaveLength(2);
    // Microsoft is a public client: no secret field.
    expect(screen.getAllByLabelText("Client secret")).toHaveLength(1);
    fireEvent.change(screen.getAllByLabelText("Client ID")[0] as HTMLElement, {
      target: { value: "g-app" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "g-secret" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    await waitFor(() =>
      expect(setOAuthApp).toHaveBeenCalledWith({
        provider: "google",
        clientId: "g-app",
        clientSecret: "g-secret",
      }),
    );
  });
});

describe("signing in with Google or Microsoft", () => {
  it("offers only the apps set up, shows Microsoft's code, and finishes when the daemon says so", async () => {
    const done = vi.fn();
    render(<OAuthSignIn onDone={done} />);
    expect(await screen.findByRole("button", { name: "Sign in with Microsoft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Microsoft" }));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open Microsoft's page/ }).getAttribute("href")).toBe(
      "https://microsoft.com/devicelogin",
    );
    status = { state: "done", email: "me@outlook.com", error: null };
    await waitFor(() => expect(done).toHaveBeenCalledWith("me@outlook.com"), { timeout: 3000 });
  });

  it("says where to set an app up when signing an account in again needs one", async () => {
    apps = apps.map((a) => ({ ...a, ready: false }));
    render(<OAuthSignIn only="google" accountId="A1" />);
    expect(await screen.findByText(/Set up Google's app in Settings → Mail/)).toBeTruthy();
  });
});
