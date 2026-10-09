import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QuestionAnswer, QuestionInput } from "@oraknid/contracts";
import { hasUi, parseSkill } from "@oraknid/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import { AwaitingOwner } from "../engine/effects.ts";
import type { JobContext } from "../engine/runner.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { Servers } from "../servers/service.ts";
import { JobServer, jobServerKey, readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { BrainStopped, type EyeBrain } from "./brain.ts";

// The Eye picks what the work needs (ADR-064 §6): from the goal, the job's
// skills (several: the method, a design skill for a UI, logo design for a
// brand), its tools, servers and Legs, each with a line of why, for one
// approval in the inbox: approve all, or untick. A skill Oraknid lacks is
// said, with "Make it" (a draft from the canon-driven template, mine to
// approve) or "Go on without". Asked once, before the interview; the
// controller is not touched: the job's extra skills reach its tasks as the
// guidance of other skills, its tools and Legs are the job's own fields.

const Item = z.object({
  name: z.string().trim().min(1).max(80),
  /** One line: why the work needs it. */
  why: z.string().trim().min(1).max(300),
});

export const NeedsProposal = z.object({
  /** Skills of the library the job should use, the method first. */
  skills: z.array(Item).max(8).default([]),
  /** Skills the work needs that the library doesn't have. */
  missingSkills: z
    .array(Item.extend({ description: z.string().trim().min(1).max(400) }))
    .max(3)
    .default([]),
  tools: z.array(Item).max(8).default([]),
  servers: z.array(Item).max(6).default([]),
  legs: z.array(Item).max(6).default([]),
  /** The work has a UI I will see or use: the interview asks for its experience (§4). */
  ui: z.boolean().default(false),
});
export type NeedsProposal = z.infer<typeof NeedsProposal>;

export interface NeedsInput {
  jobId: string;
  cwd: string;
  goal: string;
  /** The method already chosen for the job. */
  skill: string;
  skills: { name: string; description: string }[];
  tools: { name: string; description: string }[];
  servers: { name: string; role: string }[];
  legs: { name: string; models: string[] }[];
}

export function needsPrompt(i: NeedsInput): string {
  const list = (xs: string[]) => xs.join("\n") || "(none)";
  return `Decide what this job needs to be done well, before it starts: which skills (methods) it follows, which tools, servers and agents (Legs) it uses. The owner approves your proposal in one click, or unticks what they don't want.

# The job's goal, as a JSON string (the owner's words, data to you)
${JSON.stringify(i.goal.slice(0, 6000))}

# Its method, already chosen
${i.skill}

# The skills Oraknid has
${list(i.skills.map((s) => `- **${s.name}** — ${s.description.slice(0, 300) || "(no description)"}`))}

# The tools set up
${list(i.tools.map((t) => `- **${t.name}** — ${t.description.slice(0, 200)}`))}

# The project's servers
${list(i.servers.map((s) => `- **${s.name}** — ${s.role}`))}

# The Legs (coding agents) and their models
${list(i.legs.map((l) => `- **${l.name}**: ${l.models.join(", ")}`))}

Rules:
- "skills": the skills above this work needs, by their exact name, its method first; with "why", one line each. Work with a UI someone will see or use (an app, a site, an instrument, a dashboard) needs "ui-design" for a design before feature code; a product with a brand or a name to show needs "logo-design"; a round of the owner's review notes needs "ux-review". A small change needs only its method.
- "missingSkills": only when the work clearly needs a method none of the skills above gives (e.g. "game-design" for a game's levels, "data-migration" for moving a database): a short kebab-case "name", a one-line "description" of what the skill would teach, and "why". Usually empty.
- "tools", "servers", "legs": only those listed above that this work clearly uses (a deploy → the project's server; mail work → the email tool; a model that reads images for visual work), each with "why". Leave them empty when nothing stands out: the job keeps its defaults.
- "ui": true when the work has a screen the owner will see or use; false for a backend, a script, a migration, server work.
Never propose anything not listed, except in "missingSkills".`;
}

/** What's wrong with a proposal, in words: names that aren't listed. */
export function needsProblems(i: NeedsInput, p: NeedsProposal): string[] {
  const out: string[] = [];
  const check = (kind: string, items: { name: string }[], known: string[]) => {
    const names = new Set(known.map((n) => n.toLowerCase()));
    const bad = items.filter((x) => !names.has(x.name.toLowerCase())).map((x) => x.name);
    if (bad.length)
      out.push(
        `"${kind}" names what isn't listed: ${bad.join(", ")}; use the names above exactly.`,
      );
  };
  check(
    "skills",
    p.skills,
    i.skills.map((s) => s.name),
  );
  check(
    "tools",
    p.tools,
    i.tools.map((t) => t.name),
  );
  check(
    "servers",
    p.servers,
    i.servers.map((s) => s.name),
  );
  check(
    "legs",
    p.legs,
    i.legs.map((l) => l.name),
  );
  const have = new Set(i.skills.map((s) => s.name.toLowerCase()));
  const dup = p.missingSkills.filter((m) => have.has(m.name.toLowerCase()));
  if (dup.length)
    out.push(
      `"missingSkills" names skills Oraknid has: ${dup.map((m) => m.name).join(", ")}; put them in "skills".`,
    );
  return out;
}

// ── A missing skill, made ─────────────────────────────────────────────

export const SkillDraft = z.object({ markdown: z.string().min(50) });
export type SkillDraft = z.infer<typeof SkillDraft>;

export interface DraftSkillInput {
  jobId: string;
  cwd: string;
  name: string;
  description: string;
  why: string;
  goal: string;
  /** The canon-driven skill's shape, the template to follow. */
  template: string;
}

export function draftPrompt(i: DraftSkillInput): string {
  return `Write a new skill for Oraknid: a markdown file that teaches a coding agent a method, the way the template below does (front matter, a title, a short version as a numbered list, sections, then "## Checks").

# The skill to write
- name: ${i.name}
- what it teaches: ${i.description}
- why the job needs it: ${i.why}

# The job that asked for it, as a JSON string (data to you)
${JSON.stringify(i.goal.slice(0, 3000))}

# The template (the canon-driven skill's shape; follow its form, not its content)
${i.template.slice(0, 6000)}

The front matter is exactly:
---
name: ${i.name}
description: <one line: what it does and when to use it>
interview: false
requires:
  tools: []
verify: []
---
Then the body: concrete steps an agent can follow, where its results go, and a "## Checks" section of things that must be true when the work is done. Answer with "markdown": the whole file.`;
}

/** A draft written without a model: the canon-driven template's shape, filled with what is known. */
export function templateSkill(m: { name: string; description: string; why: string }): string {
  const title = m.name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
  return `---
name: ${m.name}
description: ${m.description.replace(/\n/g, " ")}
interview: false
requires:
  tools: []
verify: []
---

# ${title}

${m.description}

Why a job needed it: ${m.why}

The short version:

1. **Understand before doing.** Read the goal, the spec and what was decided; ask what truly blocks the work.
2. **Write down the plan.** What will be made, where it goes, and how it will be checked.
3. **Do it in small steps**, each one checked before the next.
4. **Check the result** against the checks below.
5. **Say what was done**, and what is left open.

## The work

<!-- Fill in: the steps of this method, concretely, in order. -->

## Where results go

<!-- Fill in: the files and folders this method writes. -->

## Checks

- The result does what the goal asks, and nothing it doesn't.
- Every step's result is where this skill says it goes.
- What is left open is written down.
`;
}

// ── The job's needs, kept ─────────────────────────────────────────────

/** The skills a job uses besides its method (ids), and whether its work has a UI. */
export const JobNeeds = z.object({
  skills: z.array(z.string()).default([]),
  ui: z.boolean().nullable().default(null),
});
export type JobNeeds = z.infer<typeof JobNeeds>;
export const jobNeedsKey = (jobId: string) => `job.needs.${jobId}`;

export function readNeeds(db: Db, jobId: string): JobNeeds {
  return readSetting(db, jobNeedsKey(jobId), JobNeeds, { skills: [], ui: null });
}

/** The job's own extra skills, latest versions, for its tasks' guidance and its plan. */
export function jobExtraSkills(db: Db, skills: SkillStore, jobId: string) {
  return readNeeds(db, jobId)
    .skills.map((id) => skills.latest(id))
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/** The work has a UI: what The Eye proposed, else the goal's words (ADR-064 §4). */
export function jobHasUi(db: Db, jobId: string, goal: string): boolean {
  return readNeeds(db, jobId).ui ?? hasUi(goal);
}

export const NEEDS_TITLE = "What this job needs";
export const APPROVE_ALL = "Approve all";
export const ADD_SKILL = "Add it to Oraknid's skills";
export const GO_WITHOUT = "Go on without";

export interface NeedsDeps {
  db: Db;
  silk: SilkStore;
  inbox: InboxStore;
  skills: SkillStore;
  brain: EyeBrain;
  registry: LegRegistry;
  tools?: { registry: ToolRegistry };
  servers?: Servers;
}

type Offer = {
  kind: "skill" | "tool" | "server" | "leg";
  id: string;
  name: string;
  why: string;
}[];
type Missing = NeedsProposal["missingSkills"];

/**
 * Asks once, before the interview: The Eye's proposal, my one approval,
 * then each missing skill I asked it to make, drafted for my approval.
 */
export async function chooseJobNeeds(d: NeedsDeps, ctx: JobContext, cwd: string): Promise<void> {
  const brain = d.brain;
  if (!brain.proposeNeeds) return;
  const job = d.db.select().from(jobs).where(eq(jobs.id, ctx.jobId)).get();
  if (!job) return;
  const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  // A server's own job has its method and its server (ADR-049).
  if (!project || project.serverId) return;
  const input = needsInput(d, job, project, cwd);
  const proposal = await ctx.step("needs:propose", { goal: job.goal }, async () => {
    try {
      return await (brain.proposeNeeds as NonNullable<EyeBrain["proposeNeeds"]>)(input);
    } catch (error) {
      if (error instanceof BrainStopped) throw error;
      // No model could say: the job goes on with its method, as before.
      return null;
    }
  });
  if (!proposal) return;
  // What is new to the job, as it was when asked: applying it changes the job, not this.
  const { offer, missing } = await ctx.step("needs:offer", null, async () =>
    offerOf(d, job, proposal),
  );
  if (!offer.length && !missing.length) {
    await ctx.step("needs:none", null, async () => {
      writeSetting(d.db, jobNeedsKey(job.id), JobNeeds, { skills: [], ui: proposal.ui });
    });
    return;
  }

  // The job leaves its draft for what comes next (the interview, or the plan), and waits there for me.
  if (ctx.state() === "draft")
    ctx.setState(
      d.skills.version(job.skillId, job.skillVersion)?.interview ? "interviewing" : "planning",
    );
  // One approval: everything ticked, untick what it shouldn't use; each missing skill, make it or not.
  const itemId = await ctx.step(
    "needs:ask",
    null,
    async () =>
      d.inbox
        .list({ jobId: job.id, kind: "question", state: "open" })
        .find((i) => i.title === NEEDS_TITLE)?.id ??
      d.inbox.open({
        kind: "question",
        jobId: job.id,
        raisedBy: "eye",
        title: NEEDS_TITLE,
        detail: needsDetail(offer, missing),
        options: [APPROVE_ALL],
        defaultOption: APPROVE_ALL,
        questions: needsQuestions(offer, missing),
      }),
  );
  const item = d.inbox.get(itemId);
  if (item?.state === "open")
    throw new AwaitingOwner(itemId, "Waiting for my approval of what this job needs.");
  const make = await ctx.step("needs:apply", null, async () =>
    applyNeeds(
      d,
      job,
      proposal.ui,
      offer,
      missing,
      item?.answer ?? APPROVE_ALL,
      item?.answers ?? null,
    ),
  );

  // Each skill I asked it to make: drafted from the canon-driven template, mine to approve.
  for (const m of make) {
    const draftItem = await ctx.step(`needs:draft:${m.name}`, null, async () => {
      const path = join(project.workspacePath, ".oraknid", "skills", `${m.name}.md`);
      const markdown = await draftSkill(d, job, m, cwd);
      mkdirSync(join(project.workspacePath, ".oraknid", "skills"), { recursive: true });
      writeFileSync(path, markdown);
      return d.inbox.open({
        kind: "approval",
        jobId: job.id,
        raisedBy: "eye",
        title: `Add the skill "${m.name}"?`,
        detail: `Oraknid has no skill for this: ${m.why}\n\nI drafted **${m.name}** from the canon-driven template, in \`${path}\`: edit it there before you approve, if you like.\n\n${"```"}markdown\n${markdown.slice(0, 6000)}\n${"```"}`,
        options: [ADD_SKILL, GO_WITHOUT],
        defaultOption: ADD_SKILL,
      });
    });
    const it = d.inbox.get(draftItem);
    if (it?.state === "open")
      throw new AwaitingOwner(draftItem, `Waiting for my approval of the skill "${m.name}".`);
    await ctx.step(`needs:add:${m.name}`, null, async () => {
      if (it?.answer !== ADD_SKILL) {
        d.silk.add({
          jobId: job.id,
          kind: "decision",
          title: `Without the skill ${m.name}`,
          body: `I chose to go on without a ${m.name} skill.`,
          authoredBy: "owner",
        });
        return null;
      }
      const path = join(project.workspacePath, ".oraknid", "skills", `${m.name}.md`);
      const markdown = existsSync(path) ? readFileSync(path, "utf8") : templateSkill(m);
      const { skill } = d.skills.upload(markdown, m.name);
      // Into the project's set and this job's skills.
      const p = d.db.select().from(projects).where(eq(projects.id, project.id)).get();
      if (p && !p.skillIds.includes(skill.id))
        d.db
          .update(projects)
          .set({ skillIds: [...p.skillIds, skill.id] })
          .where(eq(projects.id, project.id))
          .run();
      const needs = readNeeds(d.db, job.id);
      writeSetting(d.db, jobNeedsKey(job.id), JobNeeds, {
        ...needs,
        skills: [...new Set([...needs.skills, skill.id])],
      });
      d.silk.add({
        jobId: job.id,
        kind: "decision",
        title: `Skill made: ${skill.name}`,
        body: `I approved the new skill **${skill.name}** (${skill.description || m.description}); it is in Oraknid's skills, in this project's set, and this job uses it.`,
        authoredBy: "owner",
      });
      return skill.id;
    });
  }
}

function needsInput(
  d: NeedsDeps,
  job: typeof jobs.$inferSelect,
  project: typeof projects.$inferSelect,
  cwd: string,
): NeedsInput {
  const method = d.skills.version(job.skillId, job.skillVersion);
  const servers = d.servers
    ? project.serverIds.flatMap((id) => {
        try {
          return [
            { name: (d.servers as Servers).row(id).name, role: project.serverRoles[id] ?? "" },
          ];
        } catch {
          return [];
        }
      })
    : [];
  return {
    jobId: job.id,
    cwd,
    goal: job.goal,
    skill: method ? `**${method.name}** — ${method.description}` : "(none)",
    skills: d.skills.list().map((s) => ({ name: s.name, description: s.description })),
    tools: (d.tools?.registry.all() ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    })),
    servers: servers.map((s) => ({ name: s.name, role: String(s.role) })),
    legs: d.registry.all().map((l) => ({
      name: l.name,
      models: d.registry
        .models(l.id)
        .filter((m) => !m.hidden)
        .map((m) => m.model),
    })),
  };
}

/** What is new to the job in the proposal: its method, its tools, its Legs as they are left out. */
function offerOf(d: NeedsDeps, job: typeof jobs.$inferSelect, p: NeedsProposal) {
  const offer: Offer = [];
  const library = d.skills.list();
  for (const s of p.skills) {
    const row = library.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
    if (!row || row.id === job.skillId) continue;
    if (offer.some((o) => o.kind === "skill" && o.id === row.id)) continue;
    offer.push({ kind: "skill", id: row.id, name: row.name, why: s.why });
  }
  const tools = d.tools?.registry.all() ?? [];
  for (const t of p.tools) {
    const row = tools.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (!row || job.tools.includes(row.name)) continue;
    offer.push({ kind: "tool", id: row.name, name: row.name, why: t.why });
  }
  const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  for (const s of p.servers) {
    const id = (project?.serverIds ?? []).find((x) => {
      try {
        return d.servers?.row(x).name.toLowerCase() === s.name.toLowerCase();
      } catch {
        return false;
      }
    });
    if (id) offer.push({ kind: "server", id, name: s.name, why: s.why });
  }
  for (const l of p.legs) {
    const leg = d.registry.all().find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    if (!leg) continue;
    if (job.allowedLegIds.length && !job.allowedLegIds.includes(leg.id)) continue;
    offer.push({ kind: "leg", id: leg.id, name: leg.name, why: l.why });
  }
  const have = new Set(library.map((x) => x.name.toLowerCase()));
  const missing = p.missingSkills.filter((m) => !have.has(m.name.toLowerCase()));
  return { offer, missing };
}

const KIND_LABEL = { skill: "Skill", tool: "Tool", server: "Server", leg: "Leg" } as const;
const optionId = (o: Offer[number]) => `${o.kind}:${o.id}`.slice(0, 80);
const makeId = (name: string) => `make:${name}`.slice(0, 80);

function needsQuestions(offer: Offer, missing: Missing): QuestionInput[] {
  const qs: QuestionInput[] = [];
  if (offer.length)
    qs.push({
      id: "use",
      shape: "multi",
      prompt: "This job will use these. Untick what it shouldn't.",
      options: offer.slice(0, 9).map((o) => ({
        id: optionId(o),
        label: `${KIND_LABEL[o.kind]}: ${o.name}`,
        detail: o.why,
      })),
      preselected: offer.slice(0, 9).map(optionId),
      allowOther: false,
    });
  for (const m of missing)
    qs.push({
      id: makeId(m.name),
      shape: "single",
      prompt: `Oraknid has no ${m.name} skill (${m.description}). ${m.why}`,
      options: [
        {
          id: "make",
          label: "Make it",
          detail: "I draft it from the canon-driven template; you approve it before it is added.",
        },
        { id: "without", label: GO_WITHOUT, detail: "The job goes on with the skills it has." },
      ],
      recommended: "make",
      allowOther: false,
    });
  return qs;
}

function needsDetail(offer: Offer, missing: Missing): string {
  const lines = offer.map((o) => `- **${KIND_LABEL[o.kind]}: ${o.name}** — ${o.why}`);
  const lacks = missing.map(
    (m) => `- **${m.name}** — ${m.description} (${m.why}): I can make it, or go on without.`,
  );
  return [
    lines.length ? `From the goal, this job needs:\n${lines.join("\n")}` : "",
    lacks.length ? `Oraknid has no skill for:\n${lacks.join("\n")}` : "",
    `**${APPROVE_ALL}** takes everything as proposed; or untick what it shouldn't use.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** My answer applied: the job's skills, tools, Legs and server; the missing skills to make. */
function applyNeeds(
  d: NeedsDeps,
  job: typeof jobs.$inferSelect,
  ui: boolean,
  offer: Offer,
  missing: Missing,
  answer: string,
  answers: QuestionAnswer[] | null,
): Missing {
  // Said in words (the chat): "no", "none", "go on without" takes nothing; anything else, all of it.
  const none = !answers?.length && /^\s*(no|none|nothing|skip|go on without)\b/i.test(answer);
  const all = !none && (answer === APPROVE_ALL || !answers?.length);
  const use = all
    ? new Set(offer.map(optionId))
    : new Set(answers?.find((a) => a.questionId === "use")?.options ?? []);
  const kept = none ? [] : offer.filter((o) => use.has(optionId(o)));
  const dropped = offer.filter((o) => !kept.includes(o));
  const make = missing.filter((m) => {
    if (none) return false;
    if (all) return true;
    const a = answers?.find((x) => x.questionId === makeId(m.name));
    return (a?.options[0] ?? "make") === "make";
  });

  writeSetting(d.db, jobNeedsKey(job.id), JobNeeds, {
    skills: kept.filter((o) => o.kind === "skill").map((o) => o.id),
    ui,
  });
  const tools = kept.filter((o) => o.kind === "tool").map((o) => o.id);
  const legsOut = dropped.filter((o) => o.kind === "leg").map((o) => o.id);
  const set: Partial<typeof jobs.$inferInsert> = {};
  if (tools.length) set.tools = [...new Set([...job.tools, ...tools])];
  // A Leg I unticked is left out of the job; the rest stay as they were.
  if (legsOut.length) {
    const allowed = job.allowedLegIds.length
      ? job.allowedLegIds
      : d.registry.all().map((l) => l.id);
    const left = allowed.filter((id) => !legsOut.includes(id));
    if (left.length) set.allowedLegIds = left;
  }
  if (Object.keys(set).length) d.db.update(jobs).set(set).where(eq(jobs.id, job.id)).run();
  const servers = kept.filter((o) => o.kind === "server");
  if (servers.length === 1) {
    const now = readSetting(d.db, jobServerKey(job.id), JobServer, {
      serverId: null,
      declined: [],
    });
    if (!now.serverId)
      writeSetting(d.db, jobServerKey(job.id), JobServer, {
        ...now,
        serverId: (servers[0] as Offer[number]).id,
      });
  }
  const said = (xs: Offer) =>
    xs.map((o) => `- ${KIND_LABEL[o.kind]}: **${o.name}** — ${o.why}`).join("\n");
  d.silk.add({
    jobId: job.id,
    kind: "decision",
    title: "What this job uses",
    body: [
      kept.length ? `I approved:\n${said(kept)}` : "I approved none of The Eye's proposal.",
      dropped.length ? `Left out:\n${said(dropped)}` : "",
      missing.length
        ? `Missing skills: ${missing.map((m) => `${m.name} (${make.includes(m) ? "make it" : "go on without"})`).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    authoredBy: "owner",
  });
  return make;
}

async function draftSkill(
  d: NeedsDeps,
  job: typeof jobs.$inferSelect,
  m: Missing[number],
  cwd: string,
): Promise<string> {
  const fallback = templateSkill(m);
  if (!d.brain.draftSkill) return fallback;
  const canon = d.skills.list().find((s) => s.name === "canon-driven-development");
  try {
    const r = await d.brain.draftSkill({
      jobId: job.id,
      cwd,
      name: m.name,
      description: m.description,
      why: m.why,
      goal: job.goal,
      template: canon?.body ?? fallback,
    });
    const parsed = parseSkill(r.markdown, m.name);
    return parsed.name === m.name && !parsed.ignored.length ? r.markdown : fallback;
  } catch (error) {
    if (error instanceof BrainStopped) throw error;
    return fallback;
  }
}

/** Whether the skill drafted parses as the name asked, for the brain's check. */
export function draftProblems(name: string, d: SkillDraft): string[] {
  const p = parseSkill(d.markdown, name);
  const out = [...p.ignored];
  if (p.name !== name) out.push(`The front matter's name must be "${name}".`);
  if (!/^## Checks\b/m.test(p.body)) out.push('The body needs a "## Checks" section.');
  return out;
}
