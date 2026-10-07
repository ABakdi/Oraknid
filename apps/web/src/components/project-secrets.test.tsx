import type { ProjectSecretsView } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A project's secrets (ADR-059, Web-UI → Projects → Secrets): masked,
// replace only, a .env pasted.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const VIEW: ProjectSecretsView = {
  projectId: "P1",
  defaultEnvironment: "dev",
  secrets: [
    {
      id: "S1",
      projectId: "P1",
      environment: "dev",
      name: "API_KEY",
      masked: "••••••••",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const set = vi.fn(async (x: unknown) => x);
const importDotEnv = vi.fn(async (_x: unknown) => ({ set: ["A"], skipped: [] }));
vi.mock("@/lib/api", () => ({
  api: {
    projectSecrets: {
      list: async () => VIEW,
      set: (x: unknown) => set(x),
      importDotEnv: (x: unknown) => importDotEnv(x),
      remove: async () => undefined,
      setDefaultEnvironment: async () => VIEW,
    },
  },
  message: (e: unknown) => String(e),
}));
vi.mock("@/lib/live", () => ({
  useLive: (load: () => Promise<ProjectSecretsView>) => {
    const { useEffect, useState } = require("react") as typeof import("react");
    const [data, setData] = useState<ProjectSecretsView | null>(null);
    useEffect(() => {
      void load().then(setData);
    }, [load]);
    return { data, reload: () => {} };
  },
}));

const { ProjectSecretsCard } = await import("./project-secrets");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectSecretsCard", () => {
  it("shows a secret masked and replaces it without ever showing the old value", async () => {
    render(<ProjectSecretsCard projectId="P1" />);
    expect(await screen.findByText("API_KEY")).toBeTruthy();
    expect(screen.getByText("••••••••")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Replace" })[0] as HTMLElement);
    const input = screen.getByLabelText("New value for API_KEY") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "new-one" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Replace" })[0] as HTMLElement);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        projectId: "P1",
        environment: "dev",
        name: "API_KEY",
        value: "new-one",
      }),
    );
  });

  it("sets many from a pasted .env", async () => {
    render(<ProjectSecretsCard projectId="P1" />);
    await screen.findByText("API_KEY");
    fireEvent.change(screen.getByLabelText("Paste a .env"), { target: { value: "A=1" } });
    fireEvent.click(screen.getByRole("button", { name: "Set from this .env (dev)" }));
    await waitFor(() =>
      expect(importDotEnv).toHaveBeenCalledWith({
        projectId: "P1",
        environment: "dev",
        text: "A=1",
      }),
    );
  });
});
