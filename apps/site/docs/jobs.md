# Jobs and The Eye

A **job** is one piece of work: a goal in a project. **The Eye** is the part of Oraknid that plans it and supervises the agents doing it.

## Starting a job

**New work** opens a page with the options on one side and a conversation on the other. Describe the goal; The Eye may ask a few questions first, then writes the plan. You can keep a draft and start it later.

Each job works on its own branch, in its own worktree inside your project. Your branch is never touched until you merge.

## What The Eye does

- **Plans** the goal into small tasks, each with checks that prove it is done.
- **Routes** each task to the Leg that fits it best: its strengths, its quota left, how busy your computer is.
- **Watches** every agent: drift, loops, edits outside the task, tokens burned without progress. It corrects, hands the task to another Leg, or asks you.
- **Checks** the work. A task is done when its checks pass, not when an agent says so.

## Following a job

A job's page is in tabs: **The Web** (its tasks as a graph; click one for its details and diff), **The Eye** (your conversation with it), **Agents** (every session, live), **Activity**, **Silk** (what is known), **Inbox**, **Budget & stats**, **Settings**. Keys `1` to `9` switch tabs.

## Talking to The Eye

Write anything in **The Eye** tab: an instruction, a new task, some context, a question, or "stop that". It decides what your message is and acts on it, then tells you what it did.

When a job has already ended and you ask for more ("add a volume control"), The Eye starts a **follow-up job** in the same project, starting from what the first one built, and links to it.

## Approvals

Some actions always wait for you: a push, a merge, a deploy, sending mail, spending money. Others depend on the job's **autonomy**: Supervised asks about anything unusual, Standard asks less, Full only for the actions above. Answer in the **Inbox**, from your computer or your phone.

## When it's done

The **Result** tab shows where the work is (folder, branch, commits). **Merge** puts it into your work branch, after you confirm.
