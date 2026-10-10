import type { SilkEntry, SilkKind } from "@oraknid/contracts";

// Silk's pure rules (docs/01-Specification/Silk.md): what a session is
// told, how the mirror reads, and how a handoff is rebuilt when a Leg
// could not write one.

/** Roughly four characters a token; packs are capped, not billed, on this. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** The latest version of every entry: superseded ones drop out. */
export function current(entries: SilkEntry[]): SilkEntry[] {
  const superseded = new Set([
    ...entries.map((e) => e.supersedes).filter((x): x is string => !!x),
    ...entries.flatMap((e) => e.covers ?? []),
  ]);
  return entries.filter((e) => !superseded.has(e.id));
}

export interface PackInput {
  task: { id: string; title: string; instructions: string; scope: string[]; verify: string[] };
  goal: string;
  /** The relevant part of the skill, not the whole file. */
  skill: string;
  entries: SilkEntry[];
  /**
   * Earlier jobs of the same project: their standing decisions, architecture
   * and facts (ADR-034). Shown after the job's own and cut first.
   */
  earlier?: SilkEntry[];
  /** A small digest of the files in scope. */
  digest: string;
  /** The job's inputs, already rendered (untrusted ones wrapped as data). */
  inputs?: string;
  /** Default: 15% of the receiving model's context window. */
  capTokens: number;
  /**
   * Silk's own share of the pack (ADR-066 §4): decisions, constraints and
   * my words first, then the latest; the rest by title only, whole in the
   * mirror. Unset: only `capTokens` limits it.
   */
  silkTokens?: number;
  /** The handoff's cap, its start and its end kept (ADR-066 §4). Unset: whole. */
  handoffTokens?: number;
  /** Where the agent reads the whole memory (the mirror), named when entries are shortened. */
  memoryPath?: string;
}

/** What each part of a pack weighs, in tokens (ADR-066 §4: the `ContextSize` event). */
export interface PackSize {
  task: number;
  checks: number;
  goal: number;
  skill: number;
  silk: number;
  handoff: number;
  digest: number;
}

export interface Pack {
  text: string;
  tokens: number;
  /** Entries included in full. */
  included: string[];
  /** The job's own entries cut down to their title to fit: candidates for a summary entry. */
  shortened: string[];
  /** Each part's weight. */
  size: PackSize;
}

const byNewest = (a: SilkEntry, b: SilkEntry) => b.createdAt - a.createdAt;
const ownerFirst = (a: SilkEntry, b: SilkEntry) =>
  (a.authoredBy === "owner" ? 0 : 1) - (b.authoredBy === "owner" ? 0 : 1) || byNewest(a, b);

/**
 * Builds a session's context pack (Silk → Context pack), in the spec's
 * order: the task, the goal and skill, standing decisions and
 * architecture, this task's latest handoff, issues near its scope, then
 * a workspace digest. When it doesn't fit, the oldest entries are cut to
 * their titles first, then the digest is trimmed; the task never is.
 */
/** A check Oraknid answers itself, outside the sandbox (ADR-038): named so to the Leg. */
const OWN_CHECK = /^\s*oraknid\s+github-/;

export function buildContextPack(p: PackInput): Pack {
  const live = current(p.entries);
  const standing = live
    .filter((e) => e.kind === "decision" || e.kind === "architecture")
    .sort(ownerFirst);
  const answers = live.filter((e) => e.kind === "interview-answer").sort(byNewest);
  const handoff = live
    .filter((e) => e.kind === "handoff" && e.taskId === p.task.id)
    .sort(byNewest)[0];
  const issues = live
    .filter(
      (e) =>
        e.kind === "issue" &&
        (e.taskId === null || e.taskId === p.task.id || mentionsScope(e, p.task.scope)),
    )
    .sort(byNewest);
  const facts = live.filter((e) => e.kind === "fact").sort(byNewest);
  // An earlier job's entry the job has its own word on is left out (same title).
  const own = new Set(live.map((e) => e.title));
  const earlier = current(p.earlier ?? [])
    .filter(
      (e) =>
        (e.kind === "decision" || e.kind === "architecture" || e.kind === "fact") &&
        !own.has(e.title),
    )
    .sort(byNewest);

  const checksPart = p.task.verify.length
    ? `**It is done when these checks pass. Run them yourself as you work and keep going until they pass; Oraknid runs them again after you finish:**\n${p.task.verify
        .map((v) =>
          OWN_CHECK.test(v)
            ? `- \`${v}\` — Oraknid's own check of GitHub, run after you finish; there is no \`oraknid\` command for you, so don't run it`
            : `- \`${v}\``,
        )
        .join(
          "\n",
        )}\n\nIf a check itself looks wrong (it fails for a reason that has nothing to do with your work), don't investigate it: finish the work, then say DONE and why the check is wrong. Oraknid reviews its checks.`
    : "";
  const taskPart = [
    `# Your task: ${p.task.title}`,
    p.task.instructions,
    `**You may change only:** ${p.task.scope.length ? p.task.scope.join(", ") : "(nothing — this task changes no files)"}`,
    checksPart,
  ]
    .filter(Boolean)
    .join("\n\n");
  const goalPart = `# The job's goal\n${p.goal}${p.skill ? `\n\n# How this job is run\n${p.skill}` : ""}${
    p.inputs ? `\n\n# Inputs I gave\n${p.inputs}` : ""
  }`;

  // Everything below can shrink, in this order of importance.
  const ranked: SilkEntry[] = [
    ...(handoff ? [handoff] : []),
    ...answers,
    ...standing,
    ...issues,
    ...facts,
    ...earlier,
  ];
  const full = new Set(ranked.map((e) => e.id));
  const past = new Set(earlier.map((e) => e.id));
  let digest = p.digest;
  // The handoff, capped: its start (the goal, what was done) and its end (the state, the traps).
  const handoffBody = (body: string) => {
    const max = (p.handoffTokens ?? 0) * 4;
    if (!max || body.length <= max) return body;
    const head = Math.floor(max * 0.6);
    return `${body.slice(0, head)}\n… (shortened)\n${body.slice(-(max - head))}`;
  };

  const render = () => {
    const show = (e: SilkEntry) =>
      full.has(e.id)
        ? `## ${e.title}\n${e === handoff ? handoffBody(e.body) : e.body}`
        : `## ${e.title} (shortened)`;
    const section = (title: string, list: SilkEntry[]) =>
      list.length ? `# ${title}\n${list.map(show).join("\n\n")}` : "";
    return [
      taskPart,
      goalPart,
      section("What I answered", answers),
      section("Decisions and architecture", standing),
      handoff ? `# Where the last session left this task\n${show(handoff)}` : "",
      section("Known issues", issues),
      section("Facts", facts),
      section("From earlier jobs in this project", earlier),
      p.memoryPath && ranked.some((e) => !full.has(e.id))
        ? `Entries marked (shortened) are whole in ${p.memoryPath} (decisions.md, architecture.md, facts.md, issues.md, interview.md, handoffs/): read one there when you need it.`
        : "",
      digest ? `# The files in scope\n${digest}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  /** What Silk's sections weigh now (the handoff apart). */
  const silkWeight = () => {
    const show = (e: SilkEntry) =>
      full.has(e.id) ? `## ${e.title}\n${e.body}` : `## ${e.title} (shortened)`;
    return estimateTokens(
      [...answers, ...standing, ...issues, ...facts, ...earlier].map(show).join("\n\n"),
    );
  };

  // Silk as a digest (ADR-066 §4): past its share, the least important and oldest go to their
  // titles first; my words in this job stay whole.
  if (p.silkTokens)
    for (let i = ranked.length - 1; i >= 0 && silkWeight() > p.silkTokens; i--) {
      const entry = ranked[i] as SilkEntry;
      if (entry === handoff) continue;
      if (entry.authoredBy === "owner" && entry.kind !== "issue" && !past.has(entry.id)) continue;
      full.delete(entry.id);
    }

  let text = render();
  // Shorten from the least important, oldest end.
  for (let i = ranked.length - 1; i >= 0 && estimateTokens(text) > p.capTokens; i--) {
    const entry = ranked[i] as SilkEntry;
    // My words in this job are kept whole; an earlier job's may be cut to fit.
    if (entry.authoredBy === "owner" && entry.kind !== "issue" && !past.has(entry.id)) continue;
    full.delete(entry.id);
    text = render();
  }
  while (estimateTokens(text) > p.capTokens && digest.length > 200) {
    digest = `${digest.slice(0, Math.floor(digest.length / 2))}\n… (digest trimmed to fit)`;
    text = render();
  }
  return {
    text,
    tokens: estimateTokens(text),
    included: ranked.filter((e) => full.has(e.id)).map((e) => e.id),
    shortened: ranked.filter((e) => !full.has(e.id) && !past.has(e.id)).map((e) => e.id),
    size: {
      task: estimateTokens(taskPart) - estimateTokens(checksPart),
      checks: estimateTokens(checksPart),
      goal: estimateTokens(goalPart) - estimateTokens(p.skill),
      skill: estimateTokens(p.skill),
      silk: silkWeight(),
      handoff: handoff && full.has(handoff.id) ? estimateTokens(handoffBody(handoff.body)) : 0,
      digest: estimateTokens(digest),
    },
  };
}

function mentionsScope(e: SilkEntry, scope: string[]): boolean {
  const roots = scope
    .map((g) => g.split(/[*?[{]/)[0]?.replace(/\/$/, ""))
    .filter((r): r is string => !!r);
  return roots.some((r) => e.body.includes(r) || e.title.includes(r));
}

// ── The markdown mirror ─────────────────────────────────────────────

const FILES: Record<Exclude<SilkKind, "handoff">, string> = {
  decision: "decisions.md",
  architecture: "architecture.md",
  progress: "progress.md",
  issue: "issues.md",
  fact: "facts.md",
  "interview-answer": "interview.md",
  later: "later.md",
};

const TITLES: Record<string, string> = {
  "decisions.md": "Decisions",
  "architecture.md": "Architecture",
  "progress.md": "Progress",
  "issues.md": "Issues",
  "facts.md": "Facts",
  "interview.md": "Interview",
  "later.md": "For later",
};

const marker = (e: SilkEntry) =>
  `<!-- silk:${e.id} by:${typeof e.authoredBy === "string" ? e.authoredBy : `leg:${e.authoredBy.legId}`} -->`;

/** The mirror's files, path → content (Silk → Storage and mirror). */
export function renderMirror(jobTitle: string, entries: SilkEntry[]): Record<string, string> {
  const live = current(entries);
  const files: Record<string, string> = {};
  const entryBlock = (e: SilkEntry) => `## ${e.title}\n${marker(e)}\n\n${e.body.trim()}\n`;

  for (const [kind, file] of Object.entries(FILES) as [SilkKind, string][]) {
    const list = live.filter((e) => e.kind === kind).sort((a, b) => a.createdAt - b.createdAt);
    files[file] = `# ${TITLES[file]}\n\n${list.map(entryBlock).join("\n")}`;
  }
  const handoffs = live.filter((e) => e.kind === "handoff");
  for (const taskId of new Set(handoffs.map((h) => h.taskId ?? "job"))) {
    const latest = handoffs
      .filter((h) => (h.taskId ?? "job") === taskId)
      .sort(byNewest)[0] as SilkEntry;
    files[`handoffs/${taskId}.md`] = `# Handoff\n\n${entryBlock(latest)}`;
  }
  const count = (k: SilkKind) => live.filter((e) => e.kind === k).length;
  files["README.md"] = `# Silk — ${jobTitle}

The memory of this job, written by Oraknid. The database is the source
of truth; edit these files and Oraknid will offer to import the change.

| File | Entries |
| :-- | :-- |
${Object.entries(FILES)
  .map(([k, f]) => `| [${f}](${f}) | ${count(k as SilkKind)} |`)
  .join("\n")}
| handoffs/ | ${new Set(handoffs.map((h) => h.taskId)).size} |
`;
  return files;
}

export interface MirrorEdit {
  /** The entry the edited section replaces, or null for a new section. */
  supersedes: string | null;
  kind: SilkKind;
  title: string;
  body: string;
}

/**
 * What I changed by hand in one mirror file: sections whose text differs
 * from the entry they carry the marker of, and new sections without one.
 * Removed sections are not deletions: Silk only grows.
 */
export function parseMirrorEdits(file: string, text: string, entries: SilkEntry[]): MirrorEdit[] {
  const kind = (Object.entries(FILES).find(([, f]) => f === file)?.[0] ??
    (file.startsWith("handoffs/") ? "handoff" : null)) as SilkKind | null;
  if (!kind) return [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const edits: MirrorEdit[] = [];
  for (const section of text.split(/^## /m).slice(1)) {
    const [titleLine = "", ...rest] = section.split("\n");
    const title = titleLine.trim();
    const m = rest.join("\n").match(/<!-- silk:(\w+)[^>]*-->/);
    const body = rest
      .join("\n")
      .replace(/<!-- silk:[^>]*-->/, "")
      .trim();
    if (!m) {
      if (title || body) edits.push({ supersedes: null, kind, title: title || "Untitled", body });
      continue;
    }
    const original = byId.get(m[1] as string);
    if (!original) continue;
    if (original.title !== title || original.body.trim() !== body) {
      edits.push({ supersedes: original.id, kind: original.kind as SilkKind, title, body });
    }
  }
  return edits;
}

// ── Handoffs ────────────────────────────────────────────────────────

export interface HandoffFacts {
  goal: string;
  /** Files changed since the task's last checkpoint (`git diff --stat`). */
  diffStat: string;
  /** Commands the Leg ran, in order, with whether they succeeded. */
  commands: { command: string; ok: boolean }[];
  /** The Leg's last words, if any. */
  lastText: string;
  /** The latest verification output, if any. */
  verifyOutput: string | null;
}

/** The commands a rebuilt handoff lists, at most: the last ones. */
export const HANDOFF_COMMANDS_MAX = 40;

/**
 * A handoff rebuilt from the event log and the diff, for when the
 * outgoing Leg cannot write one (it crashed, was killed, or ran out of
 * quota). Same shape as the one a Leg is asked for.
 */
export function reconstructHandoff(f: HandoffFacts): string {
  // The last commands, each one line: a long session's every command (a heredoc
  // of a whole file among them) is no handoff (Persistence-and-Recovery → Size caps).
  const brief = (c: string) => {
    const line = c.split("\n")[0] ?? "";
    return line.length > 200 || line !== c ? `${line.slice(0, 200)}…` : line;
  };
  const skipped = Math.max(0, f.commands.length - HANDOFF_COMMANDS_MAX);
  const commands = f.commands.slice(skipped).map((c) => ({ ...c, command: brief(c.command) }));
  const failed = commands.filter((c) => !c.ok);
  return [
    "## Goal of the task",
    f.goal,
    "## Done so far",
    f.diffStat.trim()
      ? `Changed files:\n\`\`\`\n${f.diffStat.trim()}\n\`\`\``
      : "No files changed yet.",
    commands.length
      ? `Commands run${skipped ? ` (the last ${commands.length} of ${f.commands.length})` : ""}:\n${commands.map((c) => `- \`${c.command}\`${c.ok ? "" : " (failed)"}`).join("\n")}`
      : "",
    "## Current state",
    f.verifyOutput
      ? `Last verification:\n\`\`\`\n${f.verifyOutput.trim().slice(-2000)}\n\`\`\``
      : "Not verified yet.",
    f.lastText.trim()
      ? `The last session's final words:\n> ${f.lastText.trim().slice(-1000).replace(/\n/g, "\n> ")}`
      : "",
    "## Next steps",
    "Continue the task from the state above; run the verify commands before saying it is done.",
    "## Open questions",
    "None recorded.",
    "## Traps",
    failed.length ? failed.map((c) => `- \`${c.command}\` failed`).join("\n") : "None recorded.",
    "",
    "_Rebuilt by Oraknid from the session log: the session could not write its own handoff._",
  ]
    .filter((s) => s !== "")
    .join("\n\n");
}

/** What a session is asked for when it hands over (Silk → Handoff). */
export const HANDOFF_REQUEST = `Stop working and write a handoff for whoever continues this task. Use exactly these headings, briefly:
## Goal of the task
## Done so far
## Current state
## Next steps
## Open questions
## Traps
Name files, commands and exact errors. Do not continue the work.`;
