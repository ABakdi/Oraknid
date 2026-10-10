import { describe, expect, it } from "vitest";
import { apiBase } from "./types.ts";

describe("an OpenAI-compatible server's base address", () => {
  it.each([
    ["https://api.x.ai/v1/responses", "https://api.x.ai/v1"],
    ["https://api.groq.com/openai/v1/chat/completions", "https://api.groq.com/openai/v1"],
    ["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"],
    ["http://localhost:11434/v1/models", "http://localhost:11434/v1"],
    [" https://api.openai.com/v1 ", "https://api.openai.com/v1"],
  ])("%s → %s", (given, base) => expect(apiBase(given)).toBe(base));
});
