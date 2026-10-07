# Phase 8 — Daily use

Touches [[Jobs-and-Projects]], [[Skills]], [[Web-UI]],
[[Chats-and-Helper]], [[Security]].
Written 2026-10-02, from my list of what gets in the way when I use
Oraknid every day.

## Why

Oraknid works, but starting work is a form, the interview happens in
the inbox, a project is only a folder I already have, logs are raw
text, some screens are hard to read, and there's no place to just talk
to a model or to ask Oraknid to do things for me.

## Milestones

### M8.1 — Starting work in one place
- [x] **New work** page: options on the left (project: an existing one, or a new one from an existing folder, a new empty folder, a new GitHub repo or a cloned one; skills; Legs; autonomy; budget), my prompt and a conversation with The Eye on the right
- [x] The interview and any extra context happen in that conversation, before Start; answers go to Silk as before, so a started job doesn't ask again
- [x] A draft is saved as I go: I can leave it, come back to it from Jobs, start it later, or delete it

### M8.2 — Skills per project
- [x] A project has a set of skills; The Eye picks the one that fits a job, and may use another one's guidance for a task
- [x] Add a skill from the project settings without leaving them; upload a `.md` file as well as pasting

### M8.3 — Repositories
- [x] Settings → GitHub: a token I paste (keychain), checked, with the account it belongs to ([[ADR-023-GitHub-By-Token]])
- [x] New project from a new GitHub repo (created, cloned) or an existing one (listed, cloned)
- [x] Pushing stays a gated action (BR-5); the token never reaches a Leg
- [x] Any public git URL, cloned
- [x] GitLab and other hosts with an account (create, private repos): GitLab (gitlab.com or my own), Gitea and Forgejo by token, behind one GitHost interface GitHub's client fills too; read in Repos, linked, cloned and pushed to by Oraknid ([[ADR-062-Git-Hosts]], 2026-10-07)

### M8.4 — Markdown everywhere
- [x] What the agents and The Eye say, in session logs, the activity stream and the Eye's conversation, is rendered as markdown

### M8.5 — Screens
- [x] Overview: a Leg links to its card on the Legs page
- [x] Legs: cards collapsed by default, opened to see and configure
- [x] Inbox: items readable at any width, nothing spilling out of its card
- [x] Skills: upload a `.md` file

### M8.6 — Chats
- [x] A Chats page: new chat, pick the Leg and model, talk; mostly talk and research, with projects I attach readable ([[ADR-025-Chats]])
- [x] Chats kept, renamed, deleted

### M8.7 — The Oraknid helper
- [x] A floating chat at the bottom left that does things for me through Oraknid's own API: creating a project or a draft, changing settings, finding things; it asks what it needs, and asks before starting a job, creating a repo or deleting ([[ADR-024-Oraknid-Helper]])
- [ ] Checked live 2026-10-02: from one sentence it made a project from a new folder, a draft in it, and proposed the start, which ran on my Confirm. Still to add: more of the API as actions (Chats, GitHub repos list, inbox answers)

## Exit criterion

I start a new project from a fresh GitHub repo through the New work page
or by asking the helper, go through the interview in its conversation,
leave it as a draft, start it later, and follow it to completion with
every log readable; I talk to a model in Chats about that project.

Related: [[Roadmap]] · [[Web-UI]] · [[Chats-and-Helper]]
