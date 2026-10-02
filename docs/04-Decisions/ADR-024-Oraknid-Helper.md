# ADR-024 — The Oraknid helper acts through Oraknid's own API

**Status:** Accepted · 2026-10-02 · [[Phase-8-Daily-Use]]

## Context
I want to ask Oraknid in words to do what I'd otherwise click through:
"create a project for my new site in ~/Dev/site, as a new private GitHub
repo, and start a job to set up Astro". It must ask for what's missing,
never do something big without my yes, and never get around Oraknid's
own rules.

## Decision
- **A floating chat** at the bottom left of every screen, with its own
  conversation (kept, and cleared when I want).
- **One reasoning call per turn** on The Eye's Leg (the quick-decision
  pin, ADR-022, else the Eye Leg, else the pool), as stateless JSON like
  The Eye's other calls: given the conversation and a catalogue of
  actions, it answers with a reply to me and at most a few actions.
- **Actions are Oraknid's API, nothing else**: the same procedures the
  web UI calls (list projects and jobs, create a project, create or edit
  a draft, set a job's options, change settings, find agents, …), run
  by the daemon with my device's own rights, each validated by the
  procedure's own schema. The helper can't run commands or touch files.
- **Confirmation**: small and reversible actions run at once (reading,
  creating a draft or a project from an existing folder, changing a
  setting). **Starting a job, creating a GitHub repo, deleting anything,
  and waiving a gate** are proposed in the chat with a Confirm button,
  and run only when I press it.
- What it did is shown under its reply, with links, and audited as done
  by me through the helper.
- What I type to it is mine; what it reads back from Oraknid (job
  names, Silk, logs) is data to it, never instructions (BR-15).

## Added after the first live run (2026-10-02)
- After its actions run, the helper takes another turn with the new
  state (up to three), so one sentence can go from a project to a draft
  in it to a proposed start, without me asking twice.
- Its reasoning session works in an empty folder of its own under
  Oraknid's data, never my home: a reasoning session's working folder
  is writable in its sandbox. Every Eye reasoning call now has a time
  limit (the helper's: three minutes), past which its session is killed.

## Consequences
- Everything the helper can do, I can do in the UI, and the other way
  round as actions are added.
- Its quality depends on the model behind it; a wrong action is caught
  by the procedure's validation or by my confirmation.

Related: [[Chats-and-Helper]] · [[ADR-008-Eye-Brain]] · [[ADR-022-Eye-Decision-Models]]
