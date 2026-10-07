import { SecretEnvironment } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool, McpDeclaration } from "../tools/registry.ts";
import type { ProjectSecrets } from "./service.ts";

// The env tool (ADR-059): a job's project's secrets written on one of its
// servers by Oraknid itself, never typed by the agent. `list_env` names
// what the job's environment has (no value); `write_env_file` writes them
// over Oraknid's own SSH connection as a file only the login can read.

export const ENV_TOOL_NAME = "env";

const TOOLS = [
  {
    name: "list_env",
    description:
      "The names of the project's secrets for this job's environment (dev, testing or production), which your sessions already have as environment variables. Never the values.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "write_env_file",
    description:
      "Write the project's secrets as an env file (NAME=value lines, mode 0600) on one of this job's servers, for a deploy. Oraknid writes it over its own SSH connection; the values never pass through you. Don't echo, cat or copy the file's contents.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The server: its name or SSH alias (oraknid-…).",
        },
        path: {
          type: "string",
          description:
            "The file on the server: a full path (/srv/app/.env) or under the login's home (~/app/.env).",
        },
        environment: {
          type: "string",
          enum: ["dev", "testing", "production"],
          description:
            "Whose values: the job's environment when left out. Production values go only to a production server.",
        },
      },
      required: ["server", "path"],
    },
  },
];

/** Whether a job's project has servers, for offering the tool. */
export function jobHasServers(db: Db, jobId: string): boolean {
  const job = db.select({ p: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get();
  const p = job ? db.select().from(projects).where(eq(projects.id, job.p)).get() : undefined;
  return !!p && (!!p.serverId || p.serverIds.length > 0);
}

/** Its declaration: listing reads; writing is an external write, a deploy on production. */
export function envTool(secrets: ProjectSecrets): BuiltInTool {
  return {
    name: ENV_TOOL_NAME,
    description:
      "Oraknid's env: the project's secrets written as an env file on one of the job's servers, without the values passing through the agent.",
    reads: ["list_env"],
    held: [],
    untrusted: false,
    judge: (session, name, args): McpDeclaration | undefined => {
      if (name !== "write_env_file") return undefined;
      const env =
        typeof args.environment === "string"
          ? args.environment
          : session.jobId
            ? secrets.jobEnvironment(session.jobId)
            : "dev";
      return env === "production" ? "deploy" : "external-write";
    },
  };
}

const text = (id: Rpc["id"], t: string, isError = false): Rpc => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: t }], isError },
});

/** The env tool as the broker runs it, for one session of a job. */
export function envServer(secrets: ProjectSecrets): BuiltInServer {
  return (session) => {
    const handle: McpHandler = async (m) => {
      if (m.method === "initialize")
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "oraknid-env", version: "1.0.0" },
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
        return text(m.id, await envCall(secrets, session.jobId, name, args));
      } catch (error) {
        return text(m.id, error instanceof Error ? error.message : String(error), true);
      }
    };
    return handle;
  };
}

export async function envCall(
  secrets: ProjectSecrets,
  jobId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!jobId) throw new Error("The env tool works for a job only.");
  if (name === "list_env") {
    const environment = secrets.jobEnvironment(jobId);
    const names = await secrets.namesForJob(jobId, environment);
    return names.length
      ? `This job's environment is ${environment}: ${names.join(", ")}.`
      : `This job's environment is ${environment}, and the project has no secrets for it.`;
  }
  if (name === "write_env_file") {
    const env =
      args.environment === undefined ? undefined : SecretEnvironment.parse(args.environment);
    if (typeof args.server !== "string" || typeof args.path !== "string")
      throw new Error("Give the server and the path.");
    return secrets.writeEnvFile(jobId, { server: args.server, path: args.path, environment: env });
  }
  throw new Error(`The env tool has no ${name}.`);
}
