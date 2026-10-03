import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Radix's switch measures itself; jsdom has nothing to measure with.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const addAccount = vi.fn(async (_: unknown) => ({}));
vi.mock("@/lib/api", () => ({
  api: { mail: { addAccount: (x: unknown) => addAccount(x) } },
  message: (e: unknown) => String(e),
}));

const { AddAccountForm } = await import("./mail-accounts-card");

afterEach(() => {
  cleanup();
  addAccount.mockClear();
});

const pick = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("adding an email account", () => {
  it("gives Gmail and Outlook a link to make an app password, and no OAuth sign-in", () => {
    render(<AddAccountForm onDone={() => {}} />);
    const link = screen.getByRole("link", { name: /Google app password/ });
    expect(link.getAttribute("href")).toBe("https://myaccount.google.com/apppasswords");
    expect(screen.queryByText(/Connect with Google|client id/i)).toBeNull();
    pick("Outlook / Hotmail");
    expect(screen.getByRole("link", { name: /Microsoft account security/ })).toBeTruthy();
    pick("POP3");
    expect(screen.getByText(/turn it on in Outlook\.com/)).toBeTruthy();
  });

  it("asks for a POP3 server on port 995 and sends it with delete-from-server", async () => {
    const done = vi.fn();
    render(<AddAccountForm onDone={done} />);
    pick("Another server");
    expect((screen.getByLabelText("IMAP server") as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByLabelText("Port", { selector: "#imap-port" }) as HTMLInputElement).value,
    ).toBe("993");
    pick("POP3");
    expect(screen.queryByLabelText("IMAP server")).toBeNull();
    expect(
      (screen.getByLabelText("Port", { selector: "#pop-port" }) as HTMLInputElement).value,
    ).toBe("995");
    type("Address", "me@example.com");
    type("Password", "secret");
    type("POP3 server", "pop.example.com");
    type("SMTP server", "smtp.example.com");
    fireEvent.click(screen.getByRole("switch", { name: /Delete from the server too/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(addAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "imap",
        protocol: "pop",
        email: "me@example.com",
        deleteFromServer: true,
        pop: { host: "pop.example.com", port: 995, security: "tls" },
        smtp: { host: "smtp.example.com", port: 465, security: "tls" },
      }),
    );
  });

  it("keeps a Gmail account on IMAP by default, with Gmail's own servers", async () => {
    const done = vi.fn();
    render(<AddAccountForm onDone={done} />);
    type("Address", "me@gmail.com");
    type("App password", "abcd efgh");
    expect(screen.queryByRole("switch", { name: /Delete from the server/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const sent = addAccount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ provider: "gmail", protocol: "imap", deleteFromServer: false });
    expect(sent.imap).toBeUndefined();
  });
});
