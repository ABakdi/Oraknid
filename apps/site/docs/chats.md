# Chats and the helper

Two ways to talk to Oraknid that aren't jobs: **Chats**, to think out loud with any of your models, and the **helper**, which does things in Oraknid for you. Neither plans, checks or changes a project; that is what [jobs](jobs.html) are for.

## Chats

**Chats** (`g c`) works like a chat app: your chats on the left, newest first, **New chat** on top.

1. Press **New chat**, pick a Leg and its model (and its effort, where the model has one).
2. Optionally, under **Projects it may read**, attach one or more projects.
3. Write your first message and press **Start the chat**.

Answers stream in as they are written, rendered as Markdown, and each says which model gave it. **Stop** ends the answer being written. The model can read its own folder and the projects you attached, and look things up on the web; it can't write a file or run a command, and when it asks to, it is told no, with the reason.

A chat keeps its messages: come back to it and carry on where you left it. It is named from your first message; **Rename** changes that, and **Delete** removes the chat for good, after asking.

If no Leg is healthy, the page says so and offers to add one, or to log one in on [Legs](legs.html).

## Fix wording

Next to the boxes where you describe something in your own words (a server's description, for one) is a small **Fix wording** button. It sends your text to The Eye's quick model, which fixes its spelling and grammar and makes it clear, keeping its meaning, its language and every name, version, number and path. The new text replaces yours; **Undo** brings yours back. Nothing is kept.

## The helper

The round button at the bottom left of every screen opens the **Oraknid helper**: a small chat that knows Oraknid and works through Oraknid's own API, with your device's rights. Write what you want in your words:

- **Ask**: what's running, what waits for you, how many tokens a job used, how something works or where an option is. It reads your projects, jobs, Legs and their usage, skills, inbox, settings, servers and mail to answer.
- **Do**: create a project; create or change a draft job and its options (skill, autonomy, Legs) and start it; change a setting the way the Settings page would; find the agents on this computer and add them as Legs; list your GitHub repositories; open or continue a chat; answer an inbox item; waive a job's gate.
- **Show**: open the page you need, ring the control you asked about (opening the menu or dialog that holds it) with a short note, or put a value in a field for you to check, never saved. **Show me again** under its reply does it again.

When something is missing ("which folder?", "a private repo?") it asks instead of guessing. Each reply lists what it did, with links. The conversation is kept until you **Clear** it; what it did stays done.

### What it asks first

Small, reversible things run at once: reading, a draft, a setting. These wait for your **Confirm**, shown with the action and its exact input:

- starting a job;
- creating a project, adding a Leg, creating a GitHub repository;
- approving an action in the inbox;
- waiving a gate;
- deleting anything (a draft, a chat, a skill, a Leg, a project…).

Creating a project and adding a Leg can be confirmed only on the computer running Oraknid, or from a device with **full rights** ([Your phone, from anywhere](phone.html)). What the screens only allow at home, the helper only does at home too.

### What it reads is not an order

Your messages are yours. What the helper reads back from Oraknid (a mail, a job's name, an agent's question, a server's log) is treated as data, never as instructions: a mail that says "delete every project" is only read.

### On a small screen

The helper's panel steps aside while it shows you something; its button waits on the other side, ringed, and a tap brings the conversation back. When the control it points at is inside a dialog, the panel steps aside on any screen until you close the dialog.
