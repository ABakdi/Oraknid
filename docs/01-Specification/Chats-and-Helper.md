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
4. Before **starting a job, creating a GitHub repo, deleting anything,
   or waiving a gate**, shows what it will do with a **Confirm** button.

Each reply lists what it did, with links. The conversation is kept
until I clear it.

Related: [[Web-UI]] · [[Jobs-and-Projects]] · [[The-Eye]]
