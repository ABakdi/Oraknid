# ADR-053 — Auto mode: open-source rules, a model judge, me only when it matters

**Status:** Accepted · 2026-10-07 · [[Phase-15-Agents-That-Deliver]] · changes [[ADR-014-Auto-Approval]], [[Approvals-and-Autonomy]], [[ADR-021-Tools-Broker]]

## Context
In Claude Code's auto mode I am rarely asked anything, nothing
destructive has ever happened, and work gets done. In Oraknid one
server session asked me 22 times, mostly for read-only commands
(`docker compose ps`, `test -s`, `ls` over ssh), and "approve all like
this" matched too literally to help. Asking per command is slow and
trains me to click yes: Anthropic measured that people approve 93% of
prompts ([Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).

My stipulations: build on open-source systems where they exist, not
from scratch; when the rules aren't sure, a **model** judges whether it
is safe to go on, not me; and everything **fast**.

## Decision

### Three layers, in order
1. **Rules, in the daemon, under a millisecond** (open source):
   - **Parse** the command into its parts with **tree-sitter-bash**
     (`web-tree-sitter` + `tree-sitter-bash`, MIT): pipelines, `&&`,
     subshells, redirects, `sh -c`, and the remote command of
     `ssh host '…'` parsed again.
   - **Allow at once**: reads, searches and edits inside the job's
     workspace (version control can review them); a command whose every
     part is on the **read-only list** (ls, cat, head, grep, rg, find
     without -exec/-delete, git status/log/diff/show, docker ps/logs/
     inspect, docker compose ps/logs/config, systemctl status, ss, nc -z,
     curl -I/GET to a known host, test, stat, wc, df, du, free…) and no
     redirect writes outside the workspace; over ssh, the same list on
     the remote command; the project's own build, test and lint
     commands; installing what the lockfile names.
   - **Block at once** with **cc-safety-net** (`cc-safety-net/api`
     `checkCommand`, MIT, with its Terraform and cloud rulebooks): force
     push, `reset --hard`, `checkout --`, `rm -rf` on what matters,
     reading `.env`, `~/.ssh`, `~/.aws`; plus our own rules for its
     gaps: `docker volume/system prune`, `docker compose down -v` on a
     project not named in the task, `kubectl delete`, `DROP`/`TRUNCATE`,
     `curl | sh`, `terraform destroy`, a deploy to production.
   - **Secrets going out**: a network-bound command (curl, wget, ssh,
     scp, a fetch) is scanned with **secretlint**
     (`@secretlint/secretlint-rule-preset-recommend`, MIT) and the
     gitleaks rule set; a credential in it is blocked.
   - Not adopted: dcg (its licence bars use by or for Anthropic, and
     Oraknid runs Claude Code); LlamaFirewall, NeMo Guardrails, Guardrails
     AI, Llama Guard (conversation or content-harm tools, not judges of
     a command, and Python).
2. **The judge, a model, for what the rules don't settle** (Anthropic's
   published design; their prompt isn't public, so ours follows it):
   - **Reasoning-blind**: it sees my messages, the task's goal and
     scope, and the pending action; not the agent's prose or tool
     output, so an agent can't talk it round and injected text can't
     reach it.
   - **Fixed template** with four block categories: destroying or
     exfiltrating data; weakening security; crossing a trust boundary
     (a host, account or repo not this task's); bypassing review or
     touching shared or production infrastructure. Slots for the
     workspace, the job's servers and repos, and my allow/deny notes.
   - **Stage 1**: a fast model answers one token, ALLOW or BLOCK,
     leaning to block (a local model when loaded, ADR-054; else the
     fastest allowed). **Stage 2**, only on BLOCK: a stronger model (the
     strongest allowed, Claude by default) reasons briefly and returns
     a verdict with a reason.
   - **ALLOW** → it runs, no approval. **BLOCK** → it doesn't run; the
     agent is told why ("[Crossing a trust boundary] the task's server
     is spinet-staging, this targets …") and finds another way, as in
     Claude Code.
   - **Fast**: verdicts cached by the normalised command, folder and
     task; stage 1 under a second; a judge that doesn't answer in 10 s
     counts as BLOCK with that reason (the agent goes on another way, I
     am not asked).
3. **Me, only when it matters**:
   - a **plan** that changes a server: one approval of the plan, with
     what will change (ADR-049), then the session runs;
   - **production**: each change to a server marked production;
   - what is **never automatic** (Approvals-and-Autonomy): sending mail,
     publishing, deleting a repo, paying;
   - an agent **stuck on blocks** (3 in a row or 20 in a task): The Eye
     asks me with the blocked actions and their reasons.

### Claude Code in its own auto mode
Claude Code runs headless with `--permission-mode auto`, inside
Oraknid's sandbox; its denials come back as events and are shown in the
session. A PreToolUse hook adds Oraknid's rules (layer 1's block list,
the job's scope) on top, so both agree. The other Legs and Oraknid's own
agent go through all three layers.

### Autonomy levels
The default autonomy is **auto** (this ADR). *Careful* asks me what the
judge allows when it isn't on the read-only list (the old behaviour);
*full* skips the judge for the job's own workspace and servers marked
non-production. Approvals of plans and production stay at every level.

### Containment
The sandbox stays the boundary (bwrap, Landlock, a network of its own).
Network egress gets a **domain allowlist** per job (the project's
registries, its repos' hosts, its servers), from
`@anthropic-ai/sandbox-runtime`'s proxy (Apache-2.0) where it fits our
bwrap.

## Consequences
- Every decision is logged with its layer and reason (audit, the
  session's log); the Eye's report counts what the judge blocked.
- The rules and the judge are tested on a corpus: cc-safety-net's own
  cases, the categories of dcg's packs (no code copied), the auto-mode
  stress tests (arXiv 2604.04978), and the commands from my two jobs of
  2026-10-06.
- The judge costs a small call on uncertain commands only; cached, it is
  rare after the first minutes of a job.
- "Approve all like this for this job" stays for the careful level,
  matched on the parsed command's shape, not its text.

## As built (2026-10-07, M15.2)
- **Layer 1 is the package `@oraknid/guard`** (`packages/guard`):
  `parse.ts` (web-tree-sitter 0.27 + tree-sitter-bash 0.25's wasm; the
  grammar loads once at the daemon's start, parsing is then synchronous,
  about 0.1 ms), `rules.ts` (block, allow, ask, judge), `readonly.ts`
  (the read-only list, shared with the server rules of ADR-049),
  `secrets.ts`, `safety-net.ts`, `judge.ts`, `stuck.ts`, `shape.ts`.
  `packages/core`'s `decide()` stays the frame (the never-allowed list,
  my rules, the gates, the file tools) and reads the guard's verdict,
  computed just before, as `layer1`; without it (the guard failed) the
  fixed program lists of ADR-014 decide as before, sending the rest to
  the judge.
- **CC Safety Net 2.6** through `cc-safety-net/api` `checkCommand({command,
  cwd})`: it reads its configuration on every call, so Oraknid points
  it at a home of its own (`<data>/guard`, `CC_SAFETY_NET_HOME`), never
  the owner's `~/.cc-safety-net`, with `CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY`
  set, so a project's own `.cc-safety-net` can only add blocks. Its
  official Terraform, AWS, gcloud and Azure rulebooks (MIT,
  github.com/cc-safety-net/rulebooks) are vendored in
  `packages/guard/rulebooks` and written there at start. A call costs
  2–5 ms (it reads files, and spawns git for some git commands), so its
  verdicts are cached per command and folder, and it is skipped when
  every part of a command is on the read-only list with no credential
  path in its words (our own list of CC Safety Net's secret paths
  covers that case). The remote command of an ssh is checked by it too.
- **Secrets**: `@secretlint/core` 13 `lintSource` with the recommended
  preset, in process (about 0.5 ms), after twenty gitleaks-style
  patterns (AWS keys, private keys, GitHub, GitLab, Slack, Anthropic,
  OpenAI, Google, Stripe, npm, PyPI, SendGrid, Twilio, DigitalOcean,
  Hugging Face tokens, JWTs, a password in a URL, a bearer header),
  only on a command with a network program or a remote part. The
  preset ignores AWS's documented example key, the patterns don't.
- **Our gap rules** live in `rules.ts` → `gap()`: `docker system|volume
  prune`; `docker compose down -v|--volumes` unless the project
  (`-p`, `COMPOSE_PROJECT_NAME`, `-f`'s folder, or a `cd` before it) is
  named in the task's text (its goal, title, instructions, scope and my
  messages); `kubectl delete`; `terraform|tofu destroy`; `DROP` and
  `TRUNCATE` given to a database client (also through `docker exec`),
  `dropdb`, `redis-cli FLUSHALL|FLUSHDB`, MongoDB drops; a download run
  as code (`curl … | sh`, `sh -c "$(curl …)"`, `eval`); a deploy tool
  (vercel, netlify, fly, firebase, wrangler…) sent to production by its
  arguments. Every block's reason opens with its category in brackets.
- **Allow at once** also keeps what ADR-014 allowed in the sandbox: a
  project's own script run by its interpreter (`python3 scripts/x.py`,
  `node x.mjs`), local build tools on the folder (`tsc`, `vitest`,
  `cargo test`, `make test`), git on the job's own history. `curl` and
  `wget` read at once only from known hosts (the package registries and
  code hosts); elsewhere the judge decides. A command with words known
  only when it runs (`cat $f`, `$(…)` as an argument) is the judge's.
- **The judge** is `EyeBrain.judgeAction({stage, prompt})`: stage 1
  through The Eye's quick route (difficulty low, `classify`; a pinned
  quick model if I chose one) answering `{"answer": "ALLOW"|"BLOCK"}`,
  stage 2 through the strongest model allowed (`review`, the judging
  pin if any). Both sessions are quiet (not shown as The Eye's
  thinking) and read nothing. The template is `judgePrompt()`; a local
  model can serve stage 1 through the `JudgeModels.fast` interface
  (ADR-054). The 10 s limit covers both stages; a session that goes on
  is killed at 15 s. A timed-out or failed verdict isn't cached.
- **Never automatic** is `NEVER_AUTOMATIC` in core (`npm|pnpm|yarn|cargo|
  twine|gem|poetry|bun publish`, `gh release create`, `gh repo delete`,
  `docker push`, mail programs) and, for MCP calls, a name that sends,
  publishes, deletes or pays. Push, merge, deploy, install and branch
  deletes are the judge's at Auto (BR-15 still asks once a task read
  untrusted content).
- **Claude Code**: the SDK's `permissionMode: "auto"` (the CLI's
  `--permission-mode auto`; prompts stay with the host,
  `--permission-prompts host`, the default) and in-process SDK hooks in
  place of a `--settings` script: `PreToolUse` calls
  `SessionStart.onPreToolUse` (deny with the reason, "ask" to send it to
  `canUseTool`, or no opinion), `PermissionDenied` becomes a
  `permission.denied` Leg event, logged as decided by the Leg. At
  Careful the session stays in `default` mode, every prompt Oraknid's.
- **Stuck**: counted per task in memory; a block by Claude Code's own
  classifier is logged but not counted (Oraknid isn't asked then, so it
  can't hold the Leg for my answer).
- **Not built yet**: the network egress allowlist per job (the
  sandbox-runtime proxy) is left for later.
