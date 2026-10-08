import type {
  CatalogEntry,
  LocalModelView,
  ModelKind,
  ModelRole,
  ModelSearchResult,
} from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Models page (ADR-054, Web-UI → Models): Refresh, each model's roles
// picked on its own card, and search results from both sources.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const model = (
  id: string,
  name: string,
  kinds: ModelKind[],
  roles: ModelRole[] = [],
  suggestedRoles: ModelRole[] = [],
): LocalModelView => ({
  id,
  source: "huggingface",
  repo: `acme/${name}`,
  file: `${name}.gguf`,
  name,
  runner: "llama.cpp",
  state: "ready",
  error: null,
  sizeBytes: 1_000_000_000,
  quant: "Q4_K_M",
  kinds,
  license: null,
  contextLength: 4096,
  download: null,
  loaded: null,
  tokensPerSec: null,
  toolCalls: null,
  settings: { keepLoaded: false, idleMinutes: 15, contextSize: "auto", gpuLayers: "auto" },
  roles,
  suggestedRoles,
  lastUsedAt: null,
  createdAt: 1,
});

const MODELS = [
  model("M1", "chat", ["text"], ["translate"], ["mail", "code", "general"]),
  model("M2", "eyes", ["vision", "text"], [], ["ocr"]),
  model("M3", "ears", ["speech"]),
  model("M4", "vectors", ["embedding"], [], ["embed"]),
];

const entry = (source: CatalogEntry["source"], id: string): CatalogEntry => ({
  source,
  id,
  name: id.split("/").at(-1) ?? id,
  description: null,
  downloads: 10,
  likes: null,
  kinds: ["text"],
  license: null,
  url: `https://example.com/${id}`,
  updatedAt: null,
  files: [
    {
      name: source === "ollama" ? "8b" : `${id}-Q4_K_M.gguf`,
      parts: [],
      sizeBytes: 4_000_000_000,
      quant: source === "ollama" ? null : "Q4_K_M",
      sha256: null,
      fit: { fits: "yes", runsOn: "gpu", note: "fits the GPU" },
    },
  ],
  projector: null,
});

const FOUND: ModelSearchResult = {
  // As the daemon interleaves them: the exact name first, then each source in turn.
  entries: [
    entry("ollama", "llama3.2"),
    entry("huggingface", "bartowski/Llama-3.2-1B-GGUF"),
    entry("ollama", "llama3.2-vision"),
    entry("huggingface", "bartowski/Llama-3.2-3B-GGUF"),
    entry("huggingface", "unsloth/Llama-3.2-3B-GGUF"),
  ],
  counts: { ollama: 2, huggingface: 3 },
  problems: [],
};

const calls: { name: string; input: unknown }[] = [];
let refreshDone: (() => void) | null = null;

vi.mock("@/lib/api", () => ({
  api: {
    models: {
      status: async () => ({
        dir: "/data/models",
        diskFreeBytes: 100e9,
        usedBytes: 4e9,
        diskLow: false,
        runtimes: { llamaServer: "/bin/llama-server", ollama: null, whisper: null },
        machine: { gpus: [], memoryTotalBytes: 32e9, memoryAvailableBytes: 20e9 },
        roles: {},
        legId: null,
      }),
      list: async () => {
        calls.push({ name: "list", input: null });
        return MODELS;
      },
      refresh: () => {
        calls.push({ name: "refresh", input: null });
        return new Promise<LocalModelView[]>((resolve) => {
          refreshDone = () => resolve(MODELS);
        });
      },
      setRole: async (input: unknown) => {
        calls.push({ name: "setRole", input });
        return {};
      },
      search: async (input: unknown) => {
        calls.push({ name: "search", input });
        return FOUND;
      },
    },
  },
  message: (e: unknown) => String(e),
}));

vi.mock("@/lib/live", async () => {
  const React = await import("react");
  return {
    useLive: <T,>(load: () => Promise<T>) => {
      const [data, setData] = React.useState<T>();
      const [tick, setTick] = React.useState(0);
      // Reloads on the tick, as the real one does.
      React.useEffect(() => {
        if (tick >= 0) void load().then(setData);
      }, [tick]);
      return { data, error: undefined, loading: false, reload: () => setTick((n) => n + 1) };
    },
  };
});

const { ModelsPage, rolesFor } = await import("./models");

afterEach(() => {
  cleanup();
  calls.length = 0;
  refreshDone = null;
});

const card = async (name: string) => {
  const title = await screen.findByText(name, { selector: "span.font-medium" });
  return title.closest(".rounded-md.border") as HTMLElement;
};

const pickerOf = async (name: string) => {
  const c = await card(name);
  fireEvent.click(within(c).getByRole("button", { name: /^(Roles|Give a role)$/ }));
  return within(c).getByRole("group", { name: `Roles of ${name}` });
};

const labels = (group: HTMLElement) =>
  within(group)
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("Refresh", () => {
  it("re-reads the models, saying it is refreshing until it is done", async () => {
    render(<ModelsPage />);
    await card("chat");
    const lists = calls.filter((c) => c.name === "list").length;
    const button = screen.getByRole("button", { name: "Refresh the models on this computer" });
    fireEvent.click(button);
    expect(calls.some((c) => c.name === "refresh")).toBe(true);
    expect(button.textContent).toContain("Refreshing…");
    expect(button).toHaveProperty("disabled", true);
    refreshDone?.();
    await waitFor(() => expect(button.textContent).toBe("Refresh"));
    await waitFor(() =>
      expect(calls.filter((c) => c.name === "list").length).toBeGreaterThan(lists),
    );
  });
});

describe("roles on each model's card", () => {
  it("offers only the roles a model's kind can do", async () => {
    expect(rolesFor(["speech"])).toEqual(["transcribe"]);
    expect(rolesFor(["embedding"])).toEqual(["embed"]);
    expect(rolesFor(["text"])).toEqual(["translate", "mail", "code", "general"]);
    expect(rolesFor(["vision", "text"])).toEqual(["translate", "ocr", "mail", "code", "general"]);
    render(<ModelsPage />);
    expect(labels(await pickerOf("ears"))).toEqual(["Speech to text"]);
    expect(labels(await pickerOf("vectors"))).toEqual(["Embeddings"]);
    expect(labels(await pickerOf("eyes"))).toEqual([
      "Translate",
      "OCR / vision",
      "Mail",
      "Simple code",
      "General",
    ]);
  });

  it("shows the roles a model holds as badges, and the suggested ones as suggested", async () => {
    render(<ModelsPage />);
    const chat = await card("chat");
    expect(
      within(chat)
        .getAllByTestId("role-badge")
        .map((b) => b.textContent),
    ).toEqual(["Translate"]);
    expect(
      within(chat)
        .getAllByTestId("role-suggested")
        .map((b) => b.textContent),
    ).toEqual(["Mail · suggested", "Simple code · suggested", "General · suggested"]);
    const eyes = await card("eyes");
    expect(within(eyes).queryAllByTestId("role-badge")).toEqual([]);
    expect(within(eyes).getByTestId("role-suggested").textContent).toBe("OCR / vision · suggested");
    // The Roles panel on the side is gone.
    expect(screen.queryByText("Which model does what.", { exact: false })).toBeNull();
  });

  it("moves a role from the model holding it, saying where it was, and takes one back", async () => {
    render(<ModelsPage />);
    const picker = await pickerOf("eyes");
    const translate = within(picker).getByRole("button", { name: "Translate" });
    expect(translate.getAttribute("aria-pressed")).toBe("false");
    expect(translate.getAttribute("title")).toContain("Now on chat");
    fireEvent.click(translate);
    await waitFor(() =>
      expect(calls.find((c) => c.name === "setRole")?.input).toEqual({
        role: "translate",
        id: "M2",
      }),
    );
    const eyes = await card("eyes");
    expect(await within(eyes).findByText("Translate was on chat.")).toBeTruthy();

    calls.length = 0;
    const own = await pickerOf("chat");
    const held = within(own).getByRole("button", { name: "Translate" });
    expect(held.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(held);
    await waitFor(() =>
      expect(calls.find((c) => c.name === "setRole")?.input).toEqual({
        role: "translate",
        id: null,
      }),
    );
  });
});

describe("finding a model", () => {
  it("asks both sources, shows them in turn with each one's count, and filters by source", async () => {
    render(<ModelsPage />);
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "llama3.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const results = await waitFor(() => {
      const r = document.querySelector('[data-help="models.results"]') as HTMLElement;
      expect(r.children.length).toBe(5);
      return r;
    });
    expect(calls.find((c) => c.name === "search")?.input).toMatchObject({
      query: "llama3.2",
      source: "all",
      fresh: false,
    });
    const order = () => [...results.querySelectorAll("a")].map((a) => a.textContent);
    expect(order()).toEqual([
      "llama3.2",
      "bartowski/Llama-3.2-1B-GGUF",
      "llama3.2-vision",
      "bartowski/Llama-3.2-3B-GGUF",
      "unsloth/Llama-3.2-3B-GGUF",
    ]);
    const filter = screen.getByRole("group", { name: "Show results from" });
    expect(labels(filter)).toEqual(["All5", "Ollama2", "Hugging Face3"]);
    // An Ollama model shows its sizes, a Hugging Face one its quantisations.
    expect(results.children[0]?.textContent).toContain("Sizes (tags)");
    expect(results.children[0]?.textContent).toContain("8b");
    expect(results.children[1]?.textContent).toContain("Quantisations");
    expect(results.children[1]?.textContent).toContain("Q4_K_M");

    fireEvent.click(within(filter).getByRole("button", { name: /^Ollama/ }));
    expect(order()).toEqual(["llama3.2", "llama3.2-vision"]);
    fireEvent.click(within(filter).getByRole("button", { name: /^Hugging Face/ }));
    expect(order()).toEqual([
      "bartowski/Llama-3.2-1B-GGUF",
      "bartowski/Llama-3.2-3B-GGUF",
      "unsloth/Llama-3.2-3B-GGUF",
    ]);
  });

  it("refreshes the results by asking the sources afresh", async () => {
    render(<ModelsPage />);
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const again = await screen.findByRole("button", {
      name: "Search again, asking both sources afresh",
    });
    fireEvent.click(again);
    await waitFor(() =>
      expect(calls.filter((c) => c.name === "search").map((c) => c.input)).toMatchObject([
        { query: "qwen", fresh: false },
        { query: "qwen", fresh: true },
      ]),
    );
  });
});
