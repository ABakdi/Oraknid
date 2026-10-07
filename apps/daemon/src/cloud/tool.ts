import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { bytesText } from "@oraknid/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool } from "../tools/registry.ts";
import type { Cloud } from "./service.ts";

// The storage tool (ADR-046 → As built, M-storage): my cloud storage for a
// job's agents, through the broker (ADR-021), only when its skill asks for
// it (`requires.tools: [storage]`). Listing and downloading into the job's
// folder read; uploading a file of the job's folder is a write, judged by
// the job's policy; a public link is published, so it always asks me
// (`send`). The providers' credentials never leave the daemon; what the
// tool returns (file names, a provider's words) is untrusted data.

export const STORAGE_TOOL: BuiltInTool = {
  name: "storage",
  description:
    "My cloud storage (the pool across my providers): list and search it, upload a file of the job, download a file into the job's folder, and a public link where the provider makes one (asks me first).",
  reads: ["list", "download"],
  held: [],
  untrusted: true,
  // A public link publishes the file: never automatic.
  judge: (_session, name) => (name === "share_link" ? "send" : undefined),
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
const str = (description: string) => ({ type: "string", description });

const TOOLS: { name: string; description: string; inputSchema: Schema }[] = [
  {
    name: "list",
    description:
      "One folder of the owner's cloud storage (all providers as one pool), or the files whose names hold some words. Each file with its provider's id, size and date.",
    inputSchema: {
      type: "object",
      properties: {
        path: str('A folder of the pool ("" or left out: the top).'),
        query: str("Words in the file names to search for, under that folder."),
      },
    },
  },
  {
    name: "upload",
    description:
      "Upload a file of the job's folder into the cloud storage: where the owner's placement rule puts it, or the provider named. The job's folder only; never hidden files or Git's.",
    inputSchema: {
      type: "object",
      properties: {
        file: str("The file, relative to the job's folder (e.g. dist/report.pdf)."),
        folder: str("The folder of the pool to put it in (the top when left out)."),
        provider: str(
          "A provider's id (from list) to put it there; the rule decides when left out.",
        ),
      },
      required: ["file"],
    },
  },
  {
    name: "download",
    description:
      "Download a file of the cloud storage into the job's folder. Never over an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("The file's path in the pool (from list)."),
        provider: str("Its provider's id, from list (needed when two providers hold that path)."),
        to: str("Where in the job's folder (relative); its name, at the top, when left out."),
      },
      required: ["path"],
    },
  },
  {
    name: "share_link",
    description:
      "A public link to a file of the cloud storage, where its provider makes one. Anyone with it can read the file: the owner is always asked first.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("The file's path in the pool."),
        provider: str("Its provider's id, from list."),
        expire: str("How long the link lasts where the provider takes it: 30m, 12h, 7d."),
      },
      required: ["path"],
    },
  },
];

/** The job's own folder: its worktree, or its project's folder. */
export function jobFolder(db: Db, jobId: string | null): string {
  if (!jobId) throw new Error("The storage tool works for a job only.");
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const project = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!project) throw new Error("The job's project is gone.");
  return job.worktree ?? project.workspacePath;
}

/** A path inside the job's folder, by real path; never Git's, Oraknid's or a hidden one. */
function inside(root: string, rel: string, mustExist: boolean): string {
  if (!rel || isAbsolute(rel)) throw new Error("Give a path relative to the job's folder.");
  const base = realpathSync(root);
  const full = resolve(base, rel);
  const parts = relative(base, full).split(sep);
  if (parts[0] === ".." || relative(base, full) === "")
    throw new Error(`${rel} is outside the job's folder.`);
  if (parts.some((p) => p.startsWith(".")))
    throw new Error(`${rel} is hidden, or in a hidden folder (.git, .oraknid…): not that one.`);
  if (!mustExist) {
    if (existsSync(full)) throw new Error(`${rel} exists already: name another place.`);
    const parent = dirname(full);
    if (existsSync(parent)) {
      const real = realpathSync(parent);
      if (real !== base && !real.startsWith(`${base}${sep}`))
        throw new Error(`${rel} is outside the job's folder.`);
    }
    return full;
  }
  if (!existsSync(full)) throw new Error(`There is no file ${rel} in the job's folder.`);
  const real = realpathSync(full);
  if (real !== base && !real.startsWith(`${base}${sep}`))
    throw new Error(`${rel} leads outside the job's folder.`);
  if (!lstatSync(real).isFile()) throw new Error(`${rel} isn't a file.`);
  return real;
}

/** The provider holding a path: the one named, else the only one that has it. */
async function holder(cloud: Cloud, path: string, provider: string | undefined): Promise<string> {
  if (provider) {
    if (!cloud.providers().some((p) => p.id === provider))
      throw new Error(`No provider ${provider}: list gives their ids.`);
    return provider;
  }
  const clean = path.replace(/^\/+|\/+$/g, "");
  const folder = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
  const l = await cloud.list(folder);
  const found = l.entries.filter((e) => !e.isDir && e.path === clean);
  if (!found.length) throw new Error(`No file ${clean} in the cloud storage.`);
  if (found.length > 1)
    throw new Error(`${clean} is in several providers: name one with provider (list gives ids).`);
  return found[0]?.providerId as string;
}

/** One call of the storage tool, for a job's session. */
export async function storageCall(
  d: { db: Db; cloud: Cloud },
  jobId: string | null,
  name: string,
  a: Record<string, unknown>,
): Promise<string> {
  const s = (k: string) => (typeof a[k] === "string" && a[k] ? (a[k] as string) : undefined);
  const cloud = d.cloud;
  const label = (id: string | null) => (id ? cloud.label(id) : "?");
  if (name === "list") {
    const path = s("path") ?? "";
    const q = s("query");
    const l = q ? await cloud.search(q, path) : await cloud.list(path);
    const lines = l.entries.map((e) =>
      e.isDir
        ? `- folder ${e.path}/`
        : `- ${e.path}: ${bytesText(e.size ?? 0)}, in ${label(e.providerId)} (provider ${e.providerId})${e.modTime ? `, ${e.modTime}` : ""}`,
    );
    return [
      q ? `Files matching "${q}" under /${l.path}:` : `/${l.path}:`,
      ...(lines.length ? lines : ["(empty)"]),
      ...l.errors.map((e) => `${e.name} couldn't be read: ${e.error}`),
    ].join("\n");
  }
  const root = jobFolder(d.db, jobId);
  if (name === "upload") {
    const rel = s("file");
    if (!rel) throw new Error("Name the file, relative to the job's folder.");
    const file = inside(root, rel, true);
    const to = [s("folder") ?? "", basename(file)].filter(Boolean).join("/");
    const put = await cloud.putFile(file, to, {
      providerId: s("provider") ?? null,
      actor: "agent",
    });
    return `Uploaded ${rel} to ${put.path} in ${label(put.providerId)} (${bytesText(put.size)}).`;
  }
  if (name === "download") {
    const path = s("path");
    if (!path) throw new Error("Name the file's path in the pool.");
    const providerId = await holder(cloud, path, s("provider"));
    const rel = s("to") ?? basename(path);
    const dest = inside(root, rel, false);
    mkdirSync(dirname(dest), { recursive: true });
    await cloud.getFile(providerId, path, dest);
    return `Downloaded ${path} from ${label(providerId)} to ${relative(realpathSync(root), dest) || rel}.`;
  }
  if (name === "share_link") {
    const path = s("path");
    if (!path) throw new Error("Name the file's path in the pool.");
    const providerId = await holder(cloud, path, s("provider"));
    const link = await cloud.shareLink(providerId, path, s("expire"));
    return `A public link to ${path} (${label(providerId)}): ${link}`;
  }
  throw new Error(`The storage tool has no ${name}.`);
}

const text = (id: Rpc["id"], t: string, isError = false): Rpc => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: t }], isError },
});

/** The storage tool as the broker runs it, for one session of a job. */
export function storageServer(d: { db: Db; cloud: Cloud }): BuiltInServer {
  return (session) => {
    const handle: McpHandler = async (m) => {
      if (m.method === "initialize")
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "oraknid-storage", version: "1.0.0" },
          },
        };
      if (m.id === undefined) return null;
      if (m.method === "ping") return { jsonrpc: "2.0", id: m.id, result: {} };
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      if (m.method !== "tools/call")
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return text(m.id, await storageCall(d, session.jobId, name, args));
      } catch (error) {
        return text(m.id, error instanceof Error ? error.message : String(error), true);
      }
    };
    return handle;
  };
}
