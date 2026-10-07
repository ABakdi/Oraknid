import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool } from "../tools/registry.ts";
import type { LocalModels } from "./service.ts";

// The local models' roles as a tool every agent may call (ADR-054): Claude
// can hand OCR, a translation or a transcript to a model on this computer.
// Nothing leaves the machine. Text read from a file is the file's, so it
// comes back as data (untrusted, BR-15).

export const MODELS_TOOL: BuiltInTool = {
  name: "local-models",
  description:
    "The models on this computer, by their roles: translate, summarise, OCR an image, transcribe audio, embed text. Nothing leaves the machine.",
  reads: ["translate", "summarize", "ocr", "transcribe", "embed"],
  held: [],
  untrusted: true,
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
const str = (description: string) => ({ type: "string", description });

const TOOLS: { name: string; description: string; inputSchema: Schema }[] = [
  {
    name: "translate",
    description: "Translate text with the local model given the translate role.",
    inputSchema: {
      type: "object",
      properties: {
        text: str("The text to translate."),
        to: str('The language to translate into, e.g. "French".'),
        from: str("The text's language, when known."),
      },
      required: ["text", "to"],
    },
  },
  {
    name: "summarize",
    description: "Summarise text (a mail, a document) with the local model given the mail role.",
    inputSchema: {
      type: "object",
      properties: {
        text: str("The text to summarise."),
        instructions: str("What to keep or how long, e.g. 'three bullet points'."),
      },
      required: ["text"],
    },
  },
  {
    name: "ocr",
    description:
      "Read the text in an image (PNG, JPEG, WebP) with the local vision model given the OCR role.",
    inputSchema: {
      type: "object",
      properties: { path: str("The image's full path, inside this job's project.") },
      required: ["path"],
    },
  },
  {
    name: "transcribe",
    description: "Turn speech into text with whisper.cpp (a 16 kHz WAV works everywhere).",
    inputSchema: {
      type: "object",
      properties: { path: str("The audio file's full path, inside this job's project.") },
      required: ["path"],
    },
  },
  {
    name: "embed",
    description: "Embedding vectors for texts, from the local embedding model.",
    inputSchema: {
      type: "object",
      properties: {
        texts: { type: "array", items: { type: "string" }, description: "The texts." },
      },
      required: ["texts"],
    },
  },
];

const text = (id: Rpc["id"], t: string, isError = false): Rpc => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: t }], isError },
});

/** The tool as the broker runs it, for one session of a job. */
export function modelsServer(models: LocalModels): BuiltInServer {
  return (session) => {
    const handle: McpHandler = async (m) => {
      if (m.method === "initialize")
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "oraknid-local-models", version: "1.0.0" },
          },
        };
      if (m.id === undefined) return null;
      if (m.method === "ping") return { jsonrpc: "2.0", id: m.id, result: {} };
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      if (m.method !== "tools/call")
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
      const a = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
      try {
        switch (m.params?.name) {
          case "translate":
            if (!s("text") || !s("to")) throw new Error("Give text and to (the language).");
            return text(m.id, await models.translate(s("text"), s("to"), s("from") || undefined));
          case "summarize":
            if (!s("text")) throw new Error("Give text.");
            return text(m.id, await models.summarize(s("text"), s("instructions") || undefined));
          case "ocr":
            return text(m.id, await models.ocr(s("path"), session.jobId));
          case "transcribe":
            return text(m.id, await models.transcribe(s("path"), session.jobId));
          case "embed": {
            const texts = Array.isArray(a.texts) ? a.texts.map(String) : [];
            if (!texts.length) throw new Error("Give texts: a list of strings.");
            const out = await models.embed(texts);
            return text(m.id, JSON.stringify(out));
          }
          default:
            throw new Error(`No such tool: ${String(m.params?.name)}.`);
        }
      } catch (error) {
        return text(m.id, error instanceof Error ? error.message : String(error), true);
      }
    };
    return handle;
  };
}
