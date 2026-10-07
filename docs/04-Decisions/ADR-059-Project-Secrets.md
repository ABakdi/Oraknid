# ADR-059 — Secrets and environment variables per project and environment

**Status:** Accepted · 2026-10-07 · builds on [[Security]] (BR-13), [[ADR-006-Sandbox]], [[ADR-026-Servers]], [[ADR-049-Server-Chat-And-Server-Jobs]], [[ADR-021-Tools-Broker]]

## Context
My projects need their `.env` values: API keys, database URLs, tokens.
Today I paste them into a job's words (they then sit in Silk, events and
transcripts) or leave them in the project's `.env`, which the sandbox
hides from an agent anyway (reading a credential is refused, [[Security]]).
A deploy to a server needs the same values there, and the agent should
never type them. The values differ by where the work runs: my
development machine, a testing server, production.

## Decision
- **A secret** is a name and a value for one project and one
  **environment**: `dev`, `testing` or `production`. The name is an
  environment variable's (`^[A-Z_][A-Z0-9_]*$`, at most 128 characters;
  names Oraknid sets itself, like `PATH`, `HOME` or `ORAKNID_*`, are
  refused). The value (at most 64 KB) is in the keychain under
  `project.secret.<id>` (BR-13), never in SQLite; the row
  (`project_secrets`: project, environment, name, when set) only says it
  exists.
- **Never shown after save**: the API, the UI, the helper and the
  terminal app list names, environments and when each was set; a value
  is masked (`••••••••`) and can only be **replaced** or **removed**. A
  `.env` text can be pasted to set many at once (`KEY=value` lines,
  `export`, quotes and comments understood); nothing is read back.
- **A job's environment**: each job runs in one environment, `dev` by
  default; the project's default can be changed (the setting
  `project.environment.<project>`), and a job's own at its creation
  (`NewJob.environment`). A server job's environment follows its
  server: `production` when the server is production (its mark, or its
  role in the project), `testing` otherwise.
- **Given to the job's sessions as environment variables**, inside the
  sandbox (ADR-006), when each session starts: only that job's project's
  secrets, only its environment's. They are set in the sandbox's clean
  environment like a Leg's own variables; another project's never are.
  The job's events say which names it got (`project.secrets.used`), never
  a value. The Eye's planning, chats and the helper get none.
- **To a server, through Oraknid** (deploys): Oraknid's built-in tool
  `env` (answered in the daemon like `github` and `email`, ADR-021)
  offers `write_env_file {server, path, environment?}`. The daemon
  writes `NAME=value` lines (quoted when needed) over its own SSH
  connection to the server, under `umask 077` and then `chmod 600`, as a
  temporary file renamed into place; the values go on the command's
  stdin, never on a command line. The agent never sees them; the tool
  answers with the path and the names written. The server must be one of
  the job's; `production` values go only to a server that is production
  for this project, and a production server gets only `production`
  values. The call is an external write through the Gate like any
  tool's write (asks unless waived; on production it always asks,
  [[Approvals-and-Autonomy]]).
- **Redaction**: every value read is added to the known secrets
  (`Secrets.known()`), so the existing scrub (BR-13) removes it from
  events, Leg logs, Silk, results and exports.
- **Audited**: `project.secret.set` (name, environment, replaced or new),
  `project.secret.removed`, `project.secrets.used` (job, names),
  `project.secret.written` (job, server, path, names); never a value.
- **Away from home**: listing works; setting, replacing and removing
  need a device with full rights (like servers and tools).
- Removing a project removes its secrets (rows and keychain entries).

## Consequences
- An agent can use the values (it runs the code that needs them) and
  could print them; the scrub hides known values from what Oraknid
  stores and shows, but not from the provider's model. That is the
  price of letting it run the project; production values reach a
  session only in a production job.
- The project's own `.env` files stay out of reach of the agent as
  before: the managed values are the way in.

## Why not a `.env` file in the worktree
The sandbox refuses reading `.env` (a credential), and a file there could
be committed by mistake.

## Why the keychain per value
One place for every secret (BR-13), the encrypted file when there is no
keychain, and a move to another machine carries them ([[ADR-061-Moving-Oraknid]]).

Related: [[Security]] · [[Servers]] · [[Jobs-and-Projects]] · [[Data-Map]]
