import type { SilkEntry, SilkKind } from "@oraknid/contracts";

// Silk's pure rules (docs/01-Specification/Silk.md): what a session is
// told, how the mirror reads, and how a handoff is rebuilt when a Leg
// could not write one.

/** Roughly four characters a token; packs are capped, not billed, on this. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** The latest version of every entry: superseded ones drop out. */
export function current(entries: SilkEntry[]): SilkEntry[] {
  const superseded = new Set(entries.map((e) => e.supersedes).filter((x): x is string => !!x));
  return entries.filter((e) => !superseded.has(e.id));
}

export interface PackInput {
  task: { id: string; title: string; instructions: string; scope: string[]; verify: string[] };
  goal: string;
  /** The relevant part of the skill, not the whole file. */
  skill: string;
  entries: SilkEntry[];
  /** A small digest of the files in scope. */
  digest: string;
  /** The job's inputs, already rendered (untrusted ones wrapped as data). */
  inputs?: string;
  /** Default: 15% of the receiving model's context window. */
  capTokens: number;
}

export interface Pack {
  text: string;
  tokens: number;
  /** Entries included in full. */
  included: string[];
  /** Entries cut down to their title to fit: candidates for a summary entry. */
  shortened: string[];
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

  const taskPart = [
    `# Your task: ${p.task.title}`,
    p.task.instructions,
    `**You may change only:** ${p.task.scope.length ? p.task.scope.join(", ") : "(nothing — this task changes no files)"}`,
    p.task.verify.length
      ? `**It is done when these pass (Oraknid runs them itself):**\n${p.task.verify.map((v) => `- \`${v}\``).join("\n")}`
      : "",
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
  ];
  const full = new Set(ranked.map((e) => e.id));
  let digest = p.digest;

  const render = () => {
    const show = (e: SilkEntry) =>
      full.has(e.id) ? `## ${e.title}\n${e.body}` : `## ${e.title} (shortened)`;
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
      digest ? `# The files in scope\n${digest}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  let text = render();
  // Shorten from the least important, oldest end.
  for (let i = ranked.length - 1; i >= 0 && estimateTokens(text) > p.capTokens; i--) {
    const entry = ranked[i] as SilkEntry;
    if (entry.authoredBy === "owner" && entry.kind !== "issue") continue; // my words are kept whole
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
    shortened: ranked.filter((e) => !full.has(e.id)).map((e) => e.id),
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
};

const TITLES: Record<string, string> = {
  "decisions.md": "Decisions",
  "architecture.md": "Architecture",
  "progress.md": "Progress",
  "issues.md": "Issues",
  "facts.md": "Facts",
  "interview.md": "Interview",
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

/**
 * A handoff rebuilt from the event log and the diff, for when the
 * outgoing Leg cannot write one (it crashed, was killed, or ran out of
 * quota). Same shape as the one a Leg is asked for.
 */
export function reconstructHandoff(f: HandoffFacts): string {
  const failed = f.commands.filter((c) => !c.ok);
  return [
    "## Goal of the task",
    f.goal,
    "## Done so far",
    f.diffStat.trim()
      ? `Changed files:\n\`\`\`\n${f.diffStat.trim()}\n\`\`\``
      : "No files changed yet.",
    f.commands.length
      ? `Commands run:\n${f.commands.map((c) => `- \`${c.command}\`${c.ok ? "" : " (failed)"}`).join("\n")}`
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
