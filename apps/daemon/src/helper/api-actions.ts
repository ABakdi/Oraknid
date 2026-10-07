import {
  DraftPatch,
  EyeModels,
  type FoundAgent,
  type GitHubRepoList,
  NewChat,
  ProjectDelete,
  ResourceSettings,
} from "@oraknid/contracts";
import { wrapUntrusted } from "@oraknid/core";
import { z } from "zod";
import type { ActionDef, HelperDeps, HelperWho } from "./service.ts";

// The helper's actions that are the web UI's own procedures (ADR-024): each
// is called through the API with my device's rights, so its validation, its
// audit and its home-only rule are the UI's. The Settings page's settings by
// name, a draft's options, waivers, chats, my GitHub repos, the inbox, and
// deleting what the UI can delete (always asked first).

/** The API, as the helper calls it: a procedure by its dotted path. */
const call = (d: HelperDeps, path: string, input: unknown, who?: HelperWho) => {
  if (!d.api) throw new Error("Oraknid's API isn't available to the helper here.");
  return d.api(path, input, who ?? { device: null, remote: false, full: true });
};

/**
 * The settings the Settings page changes, by name: the procedure each goes
 * to and how my value becomes its input. Its validation is the procedure's.
 */
export const SETTINGS: Record<
  string,
  { path: string; does: string; value: z.ZodType; input: (v: never) => unknown }
> = {
  jobs_at_once: {
    path: "settings.setMaxRunningJobs",
    does: "how many jobs run at once (a number, 1–20)",
    value: z.number(),
    input: (v: number) => ({ max: v }),
  },
  tasks_per_job: {
    path: "settings.setMaxTasksPerJob",
    does: "how many tasks of one job run at once (1–16, or null: as many as are admitted)",
    value: z.number().nullable(),
    input: (v: number | null) => ({ max: v }),
  },
  claude_share: {
    path: "settings.setClaudeShare",
    does: "every job's Claude share when its tasks climb (0–1, or null: as needed)",
    value: z.number().nullable(),
    input: (v: number | null) => ({ share: v }),
  },
  resources: {
    path: "settings.setResources",
    does: `tasks at once across every job, pausing for my own work, the machine's thresholds (part of ${JSON.stringify(z.toJSONSchema(ResourceSettings))})`,
    value: z.record(z.string(), z.unknown()),
    input: (v: Record<string, unknown>) => v,
  },
  interview_rounds: {
    path: "settings.setInterviewRounds",
    does: "how many rounds The Eye's interview may take (1–12)",
    value: z.number(),
    input: (v: number) => ({ rounds: v }),
  },
  same_provider_fallback: {
    path: "settings.setSameProviderFallback",
    does: 'whether a provider may fall back to another of my accounts after a usage limit ({"kind": a Leg kind, "enabled": true|false})',
    value: z.object({ kind: z.string(), enabled: z.boolean() }),
    input: (v: { kind: string; enabled: boolean }) => v,
  },
  terminal: {
    path: "settings.setTerminal",
    does: "the terminal in the web UI on or off (true|false)",
    value: z.boolean(),
    input: (v: boolean) => ({ enabled: v }),
  },
  eye_models: {
    path: "settings.setEyeModels",
    does: `The Eye's Leg model per kind of decision, Leg model ids or null (${JSON.stringify(z.toJSONSchema(EyeModels))})`,
    value: z.record(z.string(), z.unknown()),
    input: (v: Record<string, unknown>) => v,
  },
  eye_leg: {
    path: "settings.setEyeLeg",
    does: "the Leg model The Eye borrows for reasoning (a Leg model id, or null: routing chooses)",
    value: z.string().nullable(),
    input: (v: string | null) => ({ legModelId: v }),
  },
  notifications: {
    path: "notifications.update",
    does: "notifications: desktop, push, email (true|false), routes, quietHours (any of them)",
    value: z.record(z.string(), z.unknown()),
    input: (v: Record<string, unknown>) => v,
  },
  approvals_policy: {
    path: "policies.update",
    does: 'the approvals policy every job starts from ({"allow": [rules], "deny": [rules]}, the whole of it); asked first',
    value: z.record(z.string(), z.unknown()),
    input: (v: Record<string, unknown>) => v,
  },
};

const SettingInput = z.object({
  name: z.enum(Object.keys(SETTINGS) as [string, ...string[]]),
  value: z.unknown(),
});
type SettingInput = { name: string; value: unknown };

const ById = z.object({ id: z.string().min(1) });
type ById = z.infer<typeof ById>;

/** Deleting what the UI deletes: always asked first, with the UI's own procedure. */
const remove = (path: string, what: string, link: string, input: z.ZodType = ById): ActionDef => ({
  description: `Delete ${what}. Asked first.`,
  input,
  path,
  confirm: () => true,
  run: async (d, i: ById, who) => {
    await call(d, path, i, who);
    return { result: "Deleted.", link };
  },
});

export const API_ACTIONS: Record<string, ActionDef> = {
  find_agents: {
    kind: "read",
    description:
      "Find the agents and model servers on this computer (Claude Code, OpenCode, Codex, Ollama, …), as Legs → Find agents does: each with the config add_leg takes, and the Legs already using it.",
    input: z.object({}),
    path: "legs.discover",
    confirm: () => false,
    run: async (d, _i, who) => {
      const found = (await call(d, "legs.discover", undefined, who)) as FoundAgent[];
      return {
        result: `${found.length} found.`,
        link: "/legs",
        data: wrapUntrusted(
          "the agents found on this computer",
          found
            .map(
              (f) =>
                `- ${f.label} (kind ${f.kind}) at ${f.where}: ${f.detail}; add as "${f.suggestedName}" with config ${JSON.stringify(f.config)}${f.usedBy.length ? `; already used by ${f.usedBy.join(", ")}` : ""}`,
            )
            .join("\n") || "Nothing found.",
        ),
      };
    },
  },
  set_setting: {
    description: `Change a setting, as the Settings page does, by its name: ${Object.entries(
      SETTINGS,
    )
      .map(([n, s]) => `${n}: ${s.does}`)
      .join("; ")}. The value is checked as the page's is.`,
    input: SettingInput,
    path: (i: SettingInput) => SETTINGS[i.name]?.path ?? "",
    // The approvals policy widens what agents may do: mine to confirm.
    confirm: (i: SettingInput) => i.name === "approvals_policy",
    run: async (d, i: SettingInput, who) => {
      const s = SETTINGS[i.name];
      if (!s) throw new Error(`No setting "${i.name}".`);
      const v = s.value.safeParse(i.value);
      if (!v.success)
        throw new Error(
          `Its value was wrong for ${i.name}: ${v.error.issues.map((x) => x.message).join("; ")}`,
        );
      await call(d, s.path, s.input(v.data as never), who);
      return { result: `${i.name} set to ${JSON.stringify(i.value)}.`, link: "/settings" };
    },
  },
  edit_draft: {
    description:
      "Change a draft job (not started yet): its goal, autonomy, Legs it may use, budget, checks, inputs, skill (null: the project's). Only what is given changes.",
    input: DraftPatch,
    path: "jobs.updateDraft",
    confirm: () => false,
    run: async (d, i: z.infer<typeof DraftPatch>, who) => {
      await call(d, "jobs.updateDraft", i, who);
      return { result: "Draft changed.", link: `/new/${i.id}` };
    },
  },
  waive_gate: {
    description:
      'Waive gates for a job, so those actions no longer wait for me: the full list of waived ones (send, push, merge, deploy, delete, spend, external-write, install; [] waives none). Audited. Asked first. Input: {"jobId", "waived": [...]}',
    input: z.object({ jobId: z.string(), waived: z.array(z.string()) }),
    path: "jobs.setWaivers",
    confirm: () => true,
    run: async (d, i: { jobId: string; waived: string[] }, who) => {
      await call(d, "jobs.setWaivers", { id: i.jobId, waived: i.waived }, who);
      return {
        result: i.waived.length ? `Waived: ${i.waived.join(", ")}.` : "No gate waived.",
        link: `/jobs/${i.jobId}`,
      };
    },
  },
  open_chat: {
    description:
      "Start a chat with one of my models (a Leg model id from legs_usage or Oraknid now), optionally with projects attached, and send it my first message.",
    input: NewChat,
    path: "chats.create",
    confirm: () => false,
    run: async (d, i: z.infer<typeof NewChat>, who) => {
      const chat = (await call(d, "chats.create", i, who)) as { id: string; title: string };
      return { result: `Chat "${chat.title}" opened.`, link: `/chats/${chat.id}` };
    },
  },
  continue_chat: {
    description: "Send a message in one of my chats (by its id), which its model answers there.",
    input: z.object({ chatId: z.string(), text: z.string().min(1) }),
    path: "chats.send",
    confirm: () => false,
    run: async (d, i: { chatId: string; text: string }, who) => {
      await call(d, "chats.send", { id: i.chatId, text: i.text }, who);
      return { result: "Sent.", link: `/chats/${i.chatId}` };
    },
  },
  list_chats: {
    kind: "read",
    description: "Read my chats: id, title, model, attached projects.",
    input: z.object({}),
    path: "chats.list",
    confirm: () => false,
    run: async (d, _i, who) => {
      const chats = (await call(d, "chats.list", undefined, who)) as {
        id: string;
        title: string;
        modelLabel: string;
        projectIds: string[];
      }[];
      return {
        result: `${chats.length} chat${chats.length === 1 ? "" : "s"}.`,
        link: "/chats",
        data: wrapUntrusted(
          "the owner's chats",
          chats
            .map(
              (c) =>
                `- "${c.title}" (id ${c.id}) with ${c.modelLabel}${c.projectIds.length ? `, projects ${c.projectIds.join(", ")}` : ""}`,
            )
            .join("\n") || "No chats.",
        ),
      };
    },
  },
  github_repos: {
    kind: "read",
    description:
      "Read my GitHub repositories, as the Repos page lists them (every connected account, or one by its login): visibility, last push, description, the project it is linked to.",
    input: z.object({ account: z.string().optional() }),
    path: "github.repoList",
    confirm: () => false,
    run: async (d, i: { account?: string }, who) => {
      const list = (await call(d, "github.repoList", i, who)) as GitHubRepoList;
      const lines = [
        ...list.repos
          .slice(0, 200)
          .map(
            (r) =>
              `- ${r.fullName} (${r.visibility}${r.archived ? ", archived" : ""}${r.fork ? ", fork" : ""}, account ${r.account})${r.pushedAt ? `, pushed ${r.pushedAt.slice(0, 10)}` : ""}${r.project ? `, project ${r.project.name}` : ""}${r.description ? `: ${r.description.slice(0, 200)}` : ""}`,
          ),
        ...list.errors.map((e) => `${e.account} not read: ${e.error}`),
        ...(list.truncated || list.repos.length > 200 ? ["(more on GitHub)"] : []),
      ];
      return {
        result: `${list.repos.length} repo${list.repos.length === 1 ? "" : "s"}.`,
        link: "/repos",
        data: wrapUntrusted(
          "the owner's GitHub repositories (descriptions written by anyone)",
          lines.join("\n") || "No repositories.",
        ),
      };
    },
  },
  answer_inbox: {
    description:
      "Answer an item in my inbox (by its id from inbox_items): one of its options, or my words. Answering an approval is asked first; a question's answer is sent at once.",
    input: z.object({ id: z.string(), answer: z.string().min(1) }),
    path: "inbox.answer",
    // An approval lets an agent do something: mine to confirm (ADR-024).
    confirm: (i: { id: string }, d?: HelperDeps) => d?.inbox.get(i.id)?.kind !== "question",
    run: async (d, i: { id: string; answer: string }, who) => {
      await call(d, "inbox.answer", i, who);
      return { result: `Answered "${i.answer}".`, link: `/inbox/${i.id}` };
    },
  },
  delete_chat: remove("chats.remove", "a chat (by its id)", "/chats"),
  delete_skill: remove(
    "skills.remove",
    "a skill (by its id); refused while a job uses it",
    "/skills",
  ),
  delete_project: remove(
    "projects.delete",
    "a project (by its id) with its jobs' history; deleteFolder also deletes its folder on this computer, deleteRepos (owner/name) its GitHub repos, stopJobs cancels its running jobs first",
    "/projects",
    ProjectDelete,
  ),
  remove_leg: remove("legs.remove", "a Leg (by its id)", "/legs"),
  remove_server: remove(
    "servers.remove",
    "a server (by its id) from Oraknid; what Oraknid put on it is cleaned up",
    "/servers",
  ),
};
