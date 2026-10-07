import type { Question } from "@oraknid/contracts";
import { and, desc, eq, like, or } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import {
  events,
  eyeMessages,
  jobs,
  projects,
  serverStates,
  servers,
  silkEntries,
} from "../db/schema.ts";

// Resolving what The Eye doesn't know (The-Eye → Resolving what it
// doesn't know, after the piano chat of 2026-10-07): a name my message
// uses that this project doesn't know is looked up across Oraknid —
// servers' state documents, other projects' and servers' jobs, Silk and
// conversations — locally, with no model. Where it clearly belongs, The
// Eye takes the request there; where it could be several places, it asks
// which, with those places as options.

/** A place work can go: a server (its own chat) or a project of mine. */
export interface Place {
  kind: "server" | "project";
  /** The server's id, or the project's. */
  id: string;
  name: string;
}

/** Where a name was found, and how strongly. */
export interface Finding {
  place: Place;
  /** The names of my message found there. */
  terms: string[];
  /** In words, what was found there: "its state document", "the job “…” (cancelled)". */
  evidence: string[];
  score: number;
}

export interface Lookup {
  /** The names of my message this project doesn't know. */
  unknown: string[];
  /** Where they were found, most likely first. */
  findings: Finding[];
  /** The one place they clearly belong, if any. */
  clear: Finding | null;
  /** Several places as likely as each other, when none is clear. */
  several: Finding[];
}

/** The place a key stands for in the triage and in the question's options: "server:<id>". */
export const placeKey = (p: Place) => `${p.kind}:${p.id}`;

// Words that name nothing in particular: English and the everyday words of software work.
const COMMON = new Set(
  `able about above after again against also another anything around asked away back because been
before being below between both build built cannot change changed check could data delete deleted
does doing done down during each else even every everything fine first from further going gone have
having here into itself just keep kept know last later like look made make many maybe more most much
must need needs never next once only other others over please really related remove removed rest
same says should show since some something start started still stop stopped such sure take than
that their them then there these they thing things this those through today together until upon
used using very want wants well were what when where which while will with without work works would
your yours also again anyway really thanks thank another anything create created delete update
updated install installed uninstall upgrade restart running run runs stop start setup set fix fixed
broken break error errors issue issues problem problems logs log file files folder folders directory
directories path paths config configuration configure settings setting service services server
servers container containers image images volume volumes network networks compose docker stack
project projects app apps application applications site sites website web page pages database
databases table tables backup backups restore copy copies data user users account accounts password
passwords token tokens secret secrets port ports domain domains host hosts process processes job
jobs task tasks plan plans test tests code repo repos repository branch branches commit commits
merge push pull release releases version versions deploy deployed deployment staging production
prod local remote machine machines disk memory space clean cleanup prune purge drop wipe everything
old new current latest available enable disable enabled disabled script scripts command commands
system systems package packages dependency dependencies library libraries module modules feature
features part parts thing whole entire again retry rerun redo once more time times today yesterday
tomorrow week now then soon right left also add added adding make making want please related
relating regarding about into onto from`.split(/\s+/),
);

/** The names in a message: words that could name something, not everyday ones. */
export function namesIn(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    const n = w.toLowerCase();
    if (n.length < 4 || /^\d+$/.test(n) || COMMON.has(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out.slice(0, 12);
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The name as a word of its own in a text, any case. */
const hasWord = (hay: string | null | undefined, term: string) =>
  !!hay && new RegExp(`(^|[^\\p{L}\\p{N}])${literal(term)}($|[^\\p{L}\\p{N}])`, "iu").test(hay);

/** How much each kind of place's knowledge counts. */
const WEIGHT = { name: 6, document: 4, job: 3, silk: 2, talk: 1 } as const;
type Source = keyof typeof WEIGHT;

const ENDED_WORDS: Record<string, string> = {
  cancelled: "was cancelled",
  completed: "was done",
  failed: "failed",
  blocked: "is blocked",
  paused: "is paused",
};

/** Why a job stopped, in its own words: the reason of its last state change. */
export function stopReason(db: Db, jobId: string): string | null {
  const e = db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.jobId, jobId), eq(events.type, "job.state")))
    .orderBy(desc(events.seq))
    .get();
  const reason = (e?.payload as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

/**
 * Looks the names of my message up across Oraknid. `here` is the project
 * the message was written in (a server's own project for its chat).
 */
export function lookUp(db: Db, text: string, here: { projectId: string }): Lookup {
  const terms = namesIn(text);
  const none: Lookup = { unknown: [], findings: [], clear: null, several: [] };
  if (!terms.length) return none;
  const allProjects = db.select().from(projects).all();
  const serverRows = db.select().from(servers).all();
  const serverName = new Map(serverRows.map((s) => [s.id, s.name]));
  // Each project's place: a server's own project is its server's.
  const placeOf = new Map<string, Place>();
  for (const p of allProjects) {
    if (p.archivedAt && !p.serverId) continue;
    placeOf.set(
      p.id,
      p.serverId
        ? { kind: "server", id: p.serverId, name: serverName.get(p.serverId) ?? p.name }
        : { kind: "project", id: p.id, name: p.name },
    );
  }
  const hereProject = allProjects.find((p) => p.id === here.projectId);
  const hereKey = hereProject
    ? placeKey(placeOf.get(hereProject.id) ?? { kind: "project", id: hereProject.id, name: "" })
    : "";
  // The servers this project uses are part of it: what they hold is known here.
  const hereServers = new Set(hereProject?.serverIds ?? []);
  if (hereProject?.serverId) hereServers.add(hereProject.serverId);

  // Hits: place key → term → the strongest source and its words.
  const hits = new Map<string, { place: Place; terms: Map<string, { w: number; says: string }> }>();
  const hit = (place: Place, term: string, source: Source, says: string) => {
    const k = placeKey(place);
    const entry = hits.get(k) ?? { place, terms: new Map() };
    hits.set(k, entry);
    const was = entry.terms.get(term);
    if (!was || was.w < WEIGHT[source]) entry.terms.set(term, { w: WEIGHT[source], says });
  };
  // Known here: what the project itself holds (not what was merely said in its conversation).
  const knownHere = new Set<string>();

  const latestState = new Map<string, string>();
  for (const s of db
    .select({ serverId: serverStates.serverId, body: serverStates.body })
    .from(serverStates)
    .orderBy(desc(serverStates.version))
    .all())
    if (!latestState.has(s.serverId)) latestState.set(s.serverId, s.body);

  for (const term of terms) {
    for (const s of serverRows) {
      const place: Place = { kind: "server", id: s.id, name: s.name };
      const inName = hasWord(s.name, term);
      const inDoc = hasWord(latestState.get(s.id), term) || hasWord(s.description, term);
      if ((inName || inDoc) && hereServers.has(s.id)) knownHere.add(term);
      if (inName) hit(place, term, "name", "its name");
      else if (inDoc) hit(place, term, "document", "its state document");
    }
    for (const p of allProjects) {
      const place = placeOf.get(p.id);
      if (!place || p.serverId) continue;
      if (hasWord(p.name, term)) {
        if (p.id === here.projectId) knownHere.add(term);
        hit(place, term, "name", "its name");
      }
    }
    const pattern = `%${term}%`;
    for (const j of db
      .select({
        id: jobs.id,
        projectId: jobs.projectId,
        title: jobs.title,
        goal: jobs.goal,
        state: jobs.state,
      })
      .from(jobs)
      .where(or(like(jobs.title, pattern), like(jobs.goal, pattern)))
      .orderBy(desc(jobs.createdAt))
      .limit(40)
      .all()) {
      if (j.state === "draft") continue;
      if (!hasWord(j.title, term) && !hasWord(j.goal, term)) continue;
      if (j.projectId === here.projectId) {
        knownHere.add(term);
        continue;
      }
      const place = placeOf.get(j.projectId);
      if (place)
        hit(
          place,
          term,
          "job",
          `the job “${j.title}”${ENDED_WORDS[j.state] ? ` ${ENDED_WORDS[j.state]} there` : ""}`,
        );
    }
    for (const e of db
      .select({ projectId: jobs.projectId, title: silkEntries.title, body: silkEntries.body })
      .from(silkEntries)
      .innerJoin(jobs, eq(jobs.id, silkEntries.jobId))
      .where(or(like(silkEntries.title, pattern), like(silkEntries.body, pattern)))
      .limit(60)
      .all()) {
      if (!hasWord(e.title, term) && !hasWord(e.body, term)) continue;
      if (e.projectId === here.projectId) {
        knownHere.add(term);
        continue;
      }
      const place = placeOf.get(e.projectId);
      if (place) hit(place, term, "silk", "what its jobs learned (Silk)");
    }
    for (const m of db
      .select({ projectId: eyeMessages.projectId, text: eyeMessages.text })
      .from(eyeMessages)
      .where(like(eyeMessages.text, pattern))
      .orderBy(desc(eyeMessages.createdAt))
      .limit(60)
      .all()) {
      if (m.projectId === here.projectId || !hasWord(m.text, term)) continue;
      const place = placeOf.get(m.projectId);
      if (place) hit(place, term, "talk", "its conversation");
    }
  }

  const unknown = terms.filter((t) => !knownHere.has(t));
  if (!unknown.length) return { ...none };
  // A name found in many places names nothing in particular here.
  const placesPer = new Map<string, number>();
  for (const [k, h] of hits)
    for (const t of h.terms.keys())
      if (k !== hereKey) placesPer.set(t, (placesPer.get(t) ?? 0) + 1);
  const findings: Finding[] = [];
  for (const [k, h] of hits) {
    if (k === hereKey) continue;
    const mine = [...h.terms].filter(([t]) => unknown.includes(t) && (placesPer.get(t) ?? 0) <= 3);
    if (!mine.length) continue;
    const evidence = [...new Set(mine.map(([, v]) => v.says))];
    findings.push({
      place: h.place,
      terms: mine.map(([t]) => t),
      evidence,
      score: mine.reduce((n, [, v]) => n + v.w, 0),
    });
  }
  findings.sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name));
  const [top, second] = findings;
  // Talk alone is too little: a name only said somewhere is not where it lives.
  const clear = top && top.score >= 2 && (!second || top.score >= 2 * second.score) ? top : null;
  const several = clear
    ? []
    : findings.filter((f) => f.score >= 2 && top && f.score * 2 > top.score).slice(0, 4);
  return { unknown, findings, clear, several: several.length >= 2 ? several : [] };
}

/** The findings, for The Eye's triage: each place with its key, what was found there. */
export function findingsText(l: Lookup): string {
  return l.findings
    .slice(0, 5)
    .map(
      (f) =>
        `- [${placeKey(f.place)}] ${f.place.kind === "server" ? "the server" : "the project"} ${f.place.name}: ${f.terms.map((t) => `“${t}”`).join(", ")} found in ${f.evidence.join("; ")}`,
    )
    .join("\n");
}

/**
 * Where my request goes, from the lookup and The Eye's verdict: the place
 * The Eye named; else, only when The Eye would ask me what something is,
 * the one place it clearly belongs, or a question when it could be several.
 * Null: handled here as usual (nothing found, or The Eye acted on it here).
 */
export function routeOf(
  l: Lookup,
  said: { place: string | null; asks: boolean },
): { to: Finding } | { ask: Finding[] } | null {
  if (said.place && said.place !== "here") {
    const f = l.findings.find((x) => placeKey(x.place) === said.place);
    if (f) return { to: f };
  }
  if (said.place === "here" || !said.asks) return null;
  if (l.clear) return { to: l.clear };
  if (l.several.length >= 2) return { ask: l.several };
  return null;
}

/** The id of the question "which one is this about?". */
export const WHERE = "where";

/** "Which one is this about?": the places found, then here (ADR-037). */
export function whereQuestion(several: Finding[], hereName: string): Question {
  return {
    id: WHERE,
    shape: "single",
    prompt: "Which one is this about?",
    options: [
      ...several.map((f) => ({
        id: placeKey(f.place),
        label: f.place.name,
        detail:
          `${f.place.kind === "server" ? "A server" : "A project"}: ${f.evidence.join("; ")}`.slice(
            0,
            600,
          ),
      })),
      { id: "here", label: `Here, in ${hereName}`, detail: "None of those: this is new here." },
    ],
    recommended: null,
    allowOther: false,
  };
}

/** "misahaty is on spinet-staging (its state document; the job “…” was cancelled there)". */
export function whereFound(f: Finding): string {
  const names = f.terms.map((t) => `**${t}**`).join(", ");
  const verb = f.place.kind === "server" ? "runs on" : "belongs to";
  return `${names} ${verb} ${f.place.name} (${f.evidence.join("; ")})`;
}

// What this conversation's jobs did (after the misahaty job, 2026-10-07): the
// triage knows them, and "start another job", "again", "retry" carry an
// earlier job's goal and what it learned into the new one.

const OUTCOME: Record<string, string> = {
  completed: "done",
  cancelled: "cancelled",
  failed: "failed",
  blocked: "blocked",
  paused: "paused",
  waiting: "waiting for the owner",
};

/** How a job stands or ended, and why, in a few words. */
function outcome(db: Db, j: typeof jobs.$inferSelect): string {
  const state = OUTCOME[j.state] ?? j.state;
  const why =
    j.state === "cancelled" || j.state === "completed"
      ? stopReason(db, j.id)
      : (j.blockedReason ?? j.pauseReason);
  return `${state}${why ? `: ${why.replace(/\.$/, "").slice(0, 300)}` : ""}`;
}

/** The project's recent jobs, newest first: each title, how it stands or ended and why. */
export function recentJobs(db: Db, projectId: string, n = 5): string {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .filter((j) => j.state !== "draft")
    .slice(0, n)
    .map(
      (j) =>
        `- “${j.title}” (${outcome(db, j)})${j.description ? ` — ${j.description.slice(0, 300)}` : ""}`,
    )
    .join("\n");
}

/** A request that refers back to an earlier job: "start another job", "again", "retry". */
export const REFERS_BACK =
  /\b(another (job|try|go|attempt)|again|retry|re-?try|re-?run|redo|once more|one more time|try it)\b/i;

const PARKED = new Set(["completed", "cancelled", "failed", "blocked", "paused"]);

/**
 * The earlier job my message refers back to, in this project: of its jobs
 * that ended or stopped, the newest that shares a name with my message,
 * else the newest. Null when my message doesn't refer back.
 */
export function earlierJob(db: Db, projectId: string, text: string) {
  if (!REFERS_BACK.test(text)) return null;
  const list = db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .filter((j) => PARKED.has(j.state));
  const names = namesIn(text);
  const named = list.find((j) => names.some((n) => hasWord(j.title, n) || hasWord(j.goal, n)));
  if (named) return named;
  // "Another job" with nothing in common is new work; "again", "retry" is the last one's.
  return /\b(again|retry|re-?try|re-?run|redo|once more|one more time|try it)\b/i.test(text)
    ? (list[0] ?? null)
    : null;
}

/** What a new job takes from the earlier one: its goal, how it ended, what it learned. */
export function carryOver(db: Db, j: typeof jobs.$inferSelect): string {
  const learned = db
    .select()
    .from(silkEntries)
    .where(eq(silkEntries.jobId, j.id))
    .orderBy(desc(silkEntries.createdAt))
    .all()
    .filter((e) => ["fact", "issue", "decision", "progress", "architecture"].includes(e.kind))
    .slice(0, 8)
    .reverse()
    .map((e) => `- ${e.title}: ${e.body.replace(/\s+/g, " ").slice(0, 400)}`);
  const report = db
    .select({ text: eyeMessages.text, action: eyeMessages.action })
    .from(eyeMessages)
    .where(and(eq(eyeMessages.jobId, j.id), eq(eyeMessages.author, "eye")))
    .orderBy(desc(eyeMessages.createdAt), desc(eyeMessages.id))
    .all()
    .find((m) => (m.action as { intent?: string } | null)?.intent === "report");
  return [
    `This is another try at an earlier job, “${j.title}” (${outcome(db, j)}). Its goal was:`,
    j.goal
      .slice(0, 2000)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
    learned.length ? `What it learned:\n${learned.join("\n")}` : "",
    report ? `How it ended, as The Eye said:\n${report.text.slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
