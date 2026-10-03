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
