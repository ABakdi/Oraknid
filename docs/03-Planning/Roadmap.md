# Roadmap

Written 2026-10-01. Phases follow the order I'll actually use the
product in: first replace babysitting Claude Code, then widen the pool,
then run several things at once, then reach it from anywhere.

```mermaid
flowchart LR
    P1[Phase 1<br/>MVP] --> P2[Phase 2<br/>OpenCode]
    P2 --> P3[Phase 3<br/>Parallelism]
    P3 --> P4[Phase 4<br/>The Nest]
    P4 --> P5[Phase 5<br/>Antigravity]
    P5 --> P6[Phase 6<br/>Non-coding skills]
    P6 --> P7[Phase 7<br/>Eye decision models]
    P7 --> P8[Phase 8<br/>Daily use]
    P8 --> P9[Phase 9<br/>Servers]
    P9 --> P10[Phase 10<br/>Lockdown]
    P10 --> L[Later<br/>containers · teams]
    L --> W[Final phase<br/>Windows]
```

| Phase | Delivers | Exit criterion |
| :-- | :-- | :-- |
| [[Phase-1-MVP]] · built; a reboot mid-job and a quota window still to try | Claude Code + OpenAI-compatible adapters, one job at a time, live UI, lossless pause/resume and crash recovery, sleep inhibition, the canon-driven skill with its interview, Linux service. | I run a real job on a real project with the canon-driven skill, from interview to verified completion, without touching a terminal. It survives a pause/resume, a `kill -9` of the daemon and a reboot without redoing work. |
| [[Phase-2-OpenCode]] · done: a job handed a task from Claude Code to OpenCode through Silk and completed verified (2026-10-02) | OpenCode adapter. Routing across three kinds. | A job uses Claude Code and OpenCode, with at least one cross-Leg handoff through Silk, and completes verified. |
| [[Phase-3-Parallelism]] · done: two jobs, four tasks at once, merged cleanly (2026-10-02) | Several tasks per job and several jobs at once, worktree isolation, merges, conflict handling. | Two jobs and four parallel tasks run together, merge cleanly or raise conflicts as tasks, and the machine stays responsive. |
| [[Phase-4-The-Nest]] · built and deployed (oraknid.abakdi.com); the phone test is mine | Self-hosted relay, E2E device-to-daemon, remote push. | From my phone on mobile data, I approve an action and answer a question on a job running at home. |
| [[Phase-5-Antigravity]] · done: a real job on an Antigravity Leg completed verified (2026-10-02) | Antigravity adapter, or a documented workaround. | An Antigravity Leg completes a verified task unattended, or an ADR records why that isn't possible and what replaces it. |
| [[Phase-6-Non-Coding-Skills]] · built ([[ADR-021-Tools-Broker]]); my real inbox to try | Skills declaring MCP tools, credentials scoped per job, the email flow. | The email skill runs read → classify → draft → approve → send → log on my real inbox, with every send approved. |
| [[Phase-7-Eye-Decision-Models]] · done ([[ADR-022-Eye-Decision-Models]]); The Eye on Claude, Jev not connected yet | Jev / Kev (or similar) behind `EyeBrain`. | The Eye runs a job with a dedicated decision model, and plan quality is compared against a pool Leg on the same job. |
| [[Phase-8-Daily-Use]] · built; GitHub with my token to try | The New work page with the interview in it and drafts, skills per project, GitHub repos, markdown everywhere, readable screens, Chats, the Oraknid helper. | I start a project from a new GitHub repo through the page or the helper, go through the interview there, leave it as a draft and start it later; every log is readable; I talk to a model about it in Chats. |
| [[Phase-9-Servers]] · built; a job deploying to my server is mine to try | My servers over SSH: Oraknid's own key, read-only discovery, a state document kept current, servers per project, oraknid-monitor, a terminal in the web UI. | I add my VPS, it is discovered and documented, monitored, deployed to by a job through approvals with its document updated after, and I open a terminal on it from the web UI. |
| [[Phase-10-Lockdown]] ← **now** | A PIN on every device checked by the daemon ([[ADR-029-App-Lock]]), [[Audit-2]] and its fixes, settings in tabs, pairing my phone in one step. | From my phone I open Oraknid with my PIN, and nobody without it can; a job can't reach anything on my computer outside its sandbox. |
| Later | Containers per job, teams and roles. | Planned when they come up. |
| Final phase — Windows | Windows service, inhibitor, Credential Manager, metrics, sandbox equivalent. | The Phase 1 exit criterion passes on Windows. |

Status as of 2026-10-02: Phases 1 to 7 are built and tested on `dev`;
what's left in each is hands-on (mine), named in its phase note. Next:
those hands-on runs, then Later.

Phase notes for Later and the Windows phase are written when their turn comes.

## Changes of order

**2026-10-02 — Phase 9, Servers, added before Later.** Where my work
ends: servers known, documented, monitored and reachable from Oraknid.

**2026-10-02 — Phase 8, Daily use, added before Later.** From my list
of what gets in the way when I use Oraknid every day: starting work,
repos, readability, chats and a helper come before containers and teams.

**2026-10-01 — Windows moved to the very end.** It was Phase 7, ahead
of the Eye decision models and of containers and teams. Now it comes
after everything else. I want a fully working system on Linux first.
The Windows parts (service, inhibitor, keychain, metrics, sandbox) are
added last, for Windows developers. The OS interfaces in `packages/os`
stay, so nothing Linux-specific leaks into the rest of the code in the
meantime. The Eye decision models become Phase 7.

**2026-10-02 — Phase 10, Lockdown, added after Phase 9.** The Nest put
Oraknid on the internet: before anything else, nobody but me drives it,
on any device, and a job stays inside its sandbox.

Related: [[Vision]] · [[Product-Requirements]] · [[Phase-1-MVP]]
