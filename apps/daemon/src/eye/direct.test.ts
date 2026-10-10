import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokensOf } from "@oraknid/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { sessions } from "../db/schema.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { scriptedLeg } from "../testing/scripted-leg.ts";
import { PoolLegBrain } from "./brain.ts";
import { MinutePacer } from "./direct.ts";

// Light calls don't need an agent (ADR-066 §3), and a request too large is
// not a quota (§1): The Eye's text-only calls go to a direct model in one
// chat completion; Groq's 413 is remembered as the model's largest request.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

/** Groq's answer to one request larger than the free tier's tokens a minute (2026-10-10). */
const GROQ_413 = JSON.stringify({
  error: {
    message:
      "Request too large for model `openai/gpt-oss-20b` in organization `org_01k` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12446, please reduce your message size and try again.",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
});

interface Sent {
  url: string;
  auth: string | null;
  body: {
    model: string;
    messages: { role: string; content: string }[];
    tools?: unknown;
    max_tokens: number;
  };
}

/** A fake model server reached over plain HTTP: each chat request answered by `reply`. */
function fakeHttp(
  reply: (
    s: Sent,
    n: number,
  ) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const sent: Sent[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const s: Sent = {
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    const n = sent.length;
    sent.push(s);
    const r = reply(s, n);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof fetch;
  return { http, sent };
}

const completion = (content: unknown, usage = { prompt_tokens: 420, completion_tokens: 60 }) => ({
  body: {
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
    usage,
  },
});

const NAME = { title: "Add the keys page", description: "Builds the piano's keys page." };

async function rig(
  reply: Parameters<typeof fakeHttp>[0],
  o: { lightCalls?: string; groq?: boolean } = {},
) {
  const claudeSaid: string[] = [];
  const claude = scriptedLeg((t) => {
    claudeSaid.push(t.message);
    return [{ say: `\`\`\`json\n${JSON.stringify(NAME)}\n\`\`\`` }];
  });
  const groq = scriptedLeg(() => [{ say: "unused" }], {
    kind: "oraknid-agent",
    models: ["openai/gpt-oss-20b"],
  });
  const dir = mkdtempSync(join(tmpdir(), "oraknid-direct-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": claude.adapter, "oraknid-agent": groq.adapter },
  });
  await daemon.registry.create({
    kind: "claude-code",
    name: "Claude",
    config: { binary: "claude" },
  });
  if (o.groq !== false)
    await daemon.registry.create({
      kind: "oraknid-agent",
      name: "Groq",
      config: { baseUrl: "https://api.groq.test/openai/v1", models: ["openai/gpt-oss-20b"] },
      secret: "gsk_test",
    } as never);
  await daemon.health.checkAll();
  const fake = fakeHttp(reply);
  const brain = new PoolLegBrain({
    registry: daemon.registry,
    supervisor: daemon.supervisor,
    pinnedModelId: () => null,
    fetch: fake.http,
    lightCalls: () => o.lightCalls ?? "auto",
  });
  const groqLeg = daemon.registry.all().find((l) => l.name === "Groq");
  return { brain, sent: fake.sent, claudeSaid, d: daemon, dir, groqLeg };
}

const nameInput = (dir: string) => ({
  jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
  cwd: dir,
  goal: `Keys: a piano in the browser with a hardware-synth look.\n${"More detail on the keys, the knobs and the phone layout. ".repeat(60)}`,
  project: "keys",
});

describe("light calls on a direct model (ADR-066 §3)", () => {
  it("names a job in one chat completion: no tools, no agent, a compact prompt, its tokens kept", async () => {
    const { brain, sent, claudeSaid, d, dir, groqLeg } = await rig(() => completion(NAME));
    const named = await brain.nameJob(nameInput(dir));
    expect(named).toEqual(NAME);
    expect(claudeSaid).toEqual([]);
    expect(sent).toHaveLength(1);
    const req = sent[0] as Sent;
    expect(req.url).toBe("https://api.groq.test/openai/v1/chat/completions");
    expect(req.auth).toBe("Bearer gsk_test");
    expect(req.body.model).toBe("openai/gpt-oss-20b");
    expect(req.body.tools).toBeUndefined();
    // The whole prompt, system and schema included, stays under ~2k tokens, even for a long goal.
    const prompt = req.body.messages.map((m) => m.content).join("\n");
    expect(tokensOf(prompt)).toBeLessThan(2000);
    // On record like a session: the job, the Leg, the call, the tokens.
    const row = d.db
      .select()
      .from(sessions)
      .where(eq(sessions.legId, groqLeg?.id ?? ""))
      .get();
    expect(row).toMatchObject({
      attemptId: "eye:name-job:direct",
      jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
      inputTokens: 420,
      outputTokens: 60,
      endReason: "completed",
    });
  });

  it("judges stage 1 and triages directly; plans never", async () => {
    const { brain, sent, claudeSaid, dir } = await rig((s) =>
      /ALLOW or BLOCK/.test(s.body.messages[1]?.content ?? "")
        ? completion({ answer: "ALLOW" })
        : completion({ intent: "question", reply: "It is on its third task.", tasks: [] }),
    );
    const v = await brain.judgeAction({
      jobId: "",
      cwd: dir,
      stage: 1,
      prompt: "Is this command safe? `ls src`. Answer ALLOW or BLOCK.",
    });
    expect(v.decision).toBe("allow");
    const t = await brain.triage({
      jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
      cwd: dir,
      goal: "Keys",
      state: "The job is running.",
      silk: "## decision: Use Web Audio\nThe synth uses Web Audio.\n".repeat(200),
      conversation: "Owner: how is it going?\nYou: fine.\n".repeat(100),
      message: "Where is it now?",
    });
    expect(t.reply).toBe("It is on its third task.");
    expect(sent).toHaveLength(2);
    // The triage's context is cut short for a direct model.
    expect(tokensOf(sent[1]?.body.messages[1]?.content ?? "")).toBeLessThan(3500);
    expect(claudeSaid).toEqual([]);
  });

  it("goes to the agent when I say so, or when no direct model is there", async () => {
    const a = await rig(() => completion(NAME), { lightCalls: "agent" });
    await a.brain.nameJob(nameInput(a.dir));
    expect(a.sent).toHaveLength(0);
    expect(a.claudeSaid).toHaveLength(1);
    await daemon?.close();
    const b = await rig(() => completion(NAME), { groq: false });
    await b.brain.nameJob(nameInput(b.dir));
    expect(b.claudeSaid).toHaveLength(1);
  });
});

describe("a request too large is not a quota (ADR-066 §1)", () => {
  it("remembers Groq's 413 as the model's largest request, keeps the Leg healthy, and asks another", async () => {
    const { brain, sent, claudeSaid, d, dir, groqLeg } = await rig(() => ({
      status: 413,
      body: GROQ_413,
    }));
    const named = await brain.nameJob(nameInput(dir));
    // Claude answered it instead.
    expect(named).toEqual(NAME);
    expect(sent).toHaveLength(1);
    expect(claudeSaid).toHaveLength(1);
    const leg = d.registry.require(groqLeg?.id ?? "");
    expect(leg.health).toBe("healthy");
    const model = d.registry.models(leg.id)[0];
    expect(d.registry.maxRequestOf(model?.id ?? "")).toBe(8000);
    // A small call still goes to it; a large one doesn't.
    await brain.nameJob({ ...nameInput(dir), goal: "Keys" });
    expect(sent).toHaveLength(2);
  });

  it("waits out a per-minute limit instead of failing, the Leg never marked out of quota", async () => {
    const { brain, sent, d, dir, groqLeg } = await rig((_s, n) =>
      n === 0
        ? {
            status: 429,
            body: {
              error: {
                message:
                  "Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 0.05s.",
              },
            },
          }
        : completion(NAME),
    );
    expect(await brain.nameJob(nameInput(dir))).toEqual(NAME);
    expect(sent).toHaveLength(2);
    expect(d.registry.require(groqLeg?.id ?? "").health).toBe("healthy");
  });
});

describe("pacing a minute's tokens (ADR-066 §5)", () => {
  it("waits for room under a model's tokens a minute", () => {
    let now = 0;
    const p = new MinutePacer(() => now);
    expect(p.waitFor("m", 5000)).toBe(0);
    p.learn("m", 8000);
    p.record("m", 5000);
    now = 10_000;
    p.record("m", 2000);
    expect(p.waitFor("m", 1000)).toBe(0);
    // 3,000 more: the first 5,000 leave the minute at 60 s.
    expect(p.waitFor("m", 3000)).toBe(50_000);
    now = 61_000;
    expect(p.waitFor("m", 3000)).toBe(0);
  });
});
