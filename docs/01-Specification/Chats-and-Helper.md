# Chats and the Oraknid helper

**Is:** two ways to talk: free chats with my models, and a helper that
does things in Oraknid for me.
**Is not:** jobs. Neither plans, verifies or changes a project.

## Chats ([[ADR-025-Chats]])

The **Chats** page, like a chat app:

- A list of my chats on the left (newest first), **New chat** on top.
- A new chat: pick the Leg and model (and effort where it has one),
  optionally attach projects; then talk.
- Messages render as markdown, stream as they come, and say which model
  answered. Stop ends the current answer.
- The model can read its folder and the attached projects, and research
  the web; it can't write or run anything. When it asks for something
  else, it is told no, with the reason.
- A chat keeps its messages; it is named from its first message,
  renamable and deletable. Coming back to a chat continues it.

## Fix wording (2026-10-04)

A small button, **Fix wording**, next to a textarea where I describe
something in my words (first a server's description): one call to The
Eye's quick model (`text.polish({text, kind})`, `polishText` in The
Eye's brain, the same pick of model as a job's name) rewrites the text
with its spelling and grammar fixed and made clear, keeping its
meaning, its language and every fact (names, versions, numbers,
addresses, paths). The text goes to the model as data, never as
instructions; nothing is kept by the daemon. The rewrite replaces my
text, and **Undo** (in the toast, and next to the button until I
change the text again) brings mine back. With no model, it says so
plainly ("No model can rephrase text right now: add a Leg, or choose
The Eye's quick model"). The web app's `PolishButton` puts it on any
textarea.

## The Oraknid helper ([[ADR-024-Oraknid-Helper]])

A round button at the bottom left of every screen opens a small chat
panel. I write what I want in my words; the helper:

1. Answers questions about Oraknid and my work (what's running, what's
   waiting for me, how much a job used).
2. Does things through Oraknid's own API: creates a project, a draft
   job with its options, changes a setting, finds agents and adds Legs,
   opens the page I need.
3. Asks for what's missing ("which folder?", "a private repo?") rather
   than guessing.
4. Before **creating a project, adding a Leg, starting a job, creating
   a GitHub repo, deleting anything, or waiving a gate**, shows what it
   will do, the action and its exact input, with a **Confirm** button.
   Creating a project and adding a Leg are confirmed only at home, or
   from a device with full rights ([[ADR-030-Device-Rights]]).

Each reply lists what it did, with links. The conversation is kept
until I clear it.

### What it can do, as built (2026-10-07)

Its actions call the web UI's own procedures by name, with my device's
rights: the same validation, the same audit and the same home-only rule
as the screens (`helper/api-actions.ts`).

| Asked in words | Action | Asks first |
| :-- | :-- | :-- |
| Find the agents on this computer | `find_agents` (then `add_leg`) | adding a Leg |
| Change a setting the Settings page changes, by name (jobs and tasks at once, Claude's share, resources, interview rounds, same-provider fallback, the terminal, The Eye's models and Leg, notifications, the approvals policy) | `set_setting` | the approvals policy |
| Make or change a draft and its options | `create_draft`, `edit_draft` | no |
| Waive a job's gates | `waive_gate` | yes |
| Open a chat, continue one, list them | `open_chat`, `continue_chat`, `list_chats` | no |
| List my GitHub repos | `github_repos` | no |
| Answer an inbox item | `answer_inbox` | an approval |
| Delete a job or draft, a chat, a skill, a project; remove a Leg or a server | `delete_job`, `delete_chat`, `delete_skill`, `delete_project`, `remove_leg`, `remove_server` | always |

What a standard device may not do away from home it may not do through
the helper either: run at once, it fails saying so; proposed, its
Confirm is refused. With full rights it runs, and is in the audit log as
used away from home through the helper.

### It knows Oraknid, and shows me ([[ADR-041-Docs-And-A-Guiding-Helper]], 2026-10-03)

- **The guide**: with each message the web app sends the guide's pages
  most related to it (a search over headings and text; the whole guide
  when none stands out), and the page I asked from when I pressed **Ask
  the helper about this** on the Docs page.
- **The screens**: a map of every page, its tabs and its options (an
  id, a name, what it does, where), kept in one file in the web app
  (`src/lib/help-map.ts`); the controls carry the same id as
  `data-help`, and a test checks every id is in the screens.
- **My data, through the API**: besides projects, jobs, Legs and skills,
  it reads my mail (accounts, folders, a search of conversations, one
  conversation), my servers, the Legs' usage windows, the inbox and the
  settings. What it reads comes back to it in the next round, wrapped as
  untrusted data (BR-15); the conversation keeps only a short result.
- **Showing me**, in my browser: `navigate` (a page, its item, a tab),
  `highlight` (a control by its id: its page opens, a menu, dialog or
  drawer holding it opens, the page scrolls to it and a ring pulses
  around it with a short note until I click, press Esc or move on; still
  when I prefer less motion), `fill` (a value put in a field for me to
  check, never saved). Each has **Show me again** under the reply.
- **On a phone** the panel steps aside while it shows me something; the
  round button waits on the other edge, ringed, and a tap brings the
  conversation back.

Mail: chats don't take the `email` tool yet, and the helper only reads
mail; jobs do the rest ([[ADR-032-Email]]).

Related: [[Web-UI]] · [[Jobs-and-Projects]] · [[The-Eye]]
