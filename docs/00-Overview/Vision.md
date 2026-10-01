# Vision

*Oraknid: oracle + arachnid. Always watching, many legs.*

## Where it comes from

Today I babysit Claude Code. I start a session and watch it work. I
re-prompt it when it stops and copy context into a new session when
the old one gets too long. I catch it when it drifts, loops, or says
it's done when it isn't. I wait when a quota window runs out. Most of
that work is mechanical. It needs attention, not judgement, and it
keeps me tied to the machine.

I want a background service that does the babysitting for me. I give
it a goal and a methodology. It plans the work, hands each piece to
the best agent or model I have, checks the results itself, and keeps
going until the job is verified done, blocked, or out of budget. When
it needs me, it tells me.

## What it must feel like

- **I can walk away.** A job keeps going without me, through quota
  resets, crashes, reboots and power cuts. I can always see where it is
  at a glance.
- **Nothing happens behind my back.** Anything irreversible or external
  waits for my approval unless I have said otherwise. Everything is in
  the audit log.
- **It is honest.** "Done" means tests, builds and checks actually
  passed. A Leg saying so doesn't count.
- **It is economical.** Sessions stay short. Context comes from Silk,
  never from long transcripts. Cheap Legs do cheap work.
- **It is mine to shape.** Which agents, which accounts, which local
  models, which skills, which rules. Oraknid adapts to what I give it
  and assumes nothing about what I have.
- **Everything is at my fingertips.** One dense, live dashboard,
  usable from my phone.

## Pillars

1. **The Eye.** A supervisor that plans, routes, monitors, verifies,
   and self-prompts until the job is done.
2. **Leg-agnostic.** Any number of agents, accounts and local models,
   none required. Adding a Leg means writing an adapter and a
   capability profile.
3. **Silk.** Job memory lives outside every Leg's session. Any Leg
   picking up a task, whether continuing its own work or taking over
   from another Leg, reads what it needs from Silk.
4. **Durable.** Lossless pause and resume. Crash recovery that never
   repeats work or external side effects. Sleep inhibition while jobs run.
5. **Human in the loop by design.** Autonomy levels, approval gates,
   and inline answers to a Leg's questions.

## Scope discipline

**The MVP** is the smallest thing I would use every day instead of
babysitting Claude Code:

- Adapters for Claude Code and OpenAI-compatible local models (any
  number of each, none required)
- One job at a time
- A local web UI with live monitoring
- Lossless pause and resume, and crash recovery
- Sleep inhibition
- The canon-driven full-stack skill as the first built-in, including
  its interview step
- Linux (systemd) only

**After the MVP, in this order:** OpenCode → parallelism → The Nest
(remote relay) → Antigravity → non-coding skills. Then dedicated
decision models for The Eye (Jev, Kev), then containers and teams.
Windows comes last, once the system works fully on Linux. See [[Roadmap]].

**Not in Oraknid at all:** a hosted multi-tenant service, or Oraknid's
own model training.

Related: [[Product-Requirements]] · [[Glossary]] · [[Roadmap]]
