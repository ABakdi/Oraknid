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
