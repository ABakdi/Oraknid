# Jobs and The Eye

A **job** is one piece of work: a goal in a project. **The Eye** is the part of Oraknid that plans it and supervises the agents doing it.

## Starting a job

In a project, ask for it in the project's **The Eye** tab: The Eye starts a job, or adds the work to the one running. **New work** is for a first request, a new project, or a draft to keep and start later. The Eye may ask a few questions first, then writes the plan.

The questions come in at most three rounds (change it in **Settings → The Eye → Interview**), only what truly matters for the plan, each with a recommended answer you can take in one click. The Eye never asks the same thing twice; what it doesn't ask, it decides itself and tells you under **What I assumed**, so you can correct it later in the conversation. Say "enough, start", "start now" or "that's all" (in the round, or in the conversation) and it stops asking and plans with what it knows.

Each job works on its own branch, in its own worktree inside your project. Your branch is never touched until the job is merged, by you or by Oraknid at the end when you asked for it. In a project of several repos, the job's folder looks like the project's: each repo it works in is there at its folder, on the job's branch, and its tasks' checks run from that folder (`cd web && npm test`).

## A job's name

The Eye names each job by what it is ("Fix the login redirect loop"), with a sentence or two on what it's for, as soon as it's made; when the job ends, that line becomes what it did: what was built, its branch, where it was pushed, what's left to you. A name you type when you make the job is kept. Without a model the job keeps the first line of your request until one is there. The name and the description show in Work, Running now, the Workflow, the Inbox and the command palette; your request stays as you wrote it under **What I asked** in the job's header. The pencil beside the name renames it, or changes its description: what you write there is yours, and The Eye leaves it alone.

## What The Eye does

- **Plans** the goal into small tasks, each with checks that prove it is done, as a graph: each task waits for the ones it needs (the setup before the features, research before what uses it, integration and tests last), and tasks that don't need each other can run side by side. The same work is never planned twice. The **Workflow** tab draws it. It plans on the strongest model you have, not a cheap one.
- **Routes** each task to the Leg that fits it best: its strengths, its quota left, how busy your computer is.
- **Watches** every agent: drift, loops, edits outside the task, tokens burned without progress. It corrects, hands the task to another Leg, or asks you.
- **Checks** the work. A task is done when its checks pass, not when an agent says so.

## Following a job

Everything is in its project, in tabs: **The Eye** (one conversation for the whole project), **Workflow** (the jobs as a diagram: compact, a box per job you open for its tasks, or expanded, every job's tasks), **Work** (the jobs newest first; open one for its tasks, result, agents, activity, controls and settings), **Inbox**, **Silk** (what is known, by job), **Activity**, **Budget & stats** and **Settings**. Keys `1` to `9` switch tabs. **Running now** on the Overview lists every job running or waiting, across projects.

## Talking to The Eye

Write anything in the project's **The Eye** tab: an instruction, a new task, some context, a question, or "stop that". It decides what your message is and acts on it, then tells you what it did.

New work you ask for on a running job is planned into its graph, after the tasks it needs; asking twice doesn't add it twice. Before the job has a plan, what you ask for goes into the plan instead.

When the job is waiting for you (a question, an interview round, an approval), you can simply answer in the conversation: The Eye takes your message as the answer and the job goes on. If you write about something else, it does that and reminds you, in one line, what it's still waiting for.

The Eye also speaks up on its own, once per event and never to narrate: a line when a task is done (what it changed, its checks), a note when a task is left out (and which tasks go with it), when the job is blocked (why, and what it needs from you), when it waits for you (with the question right there), and when you denied something a task needed (what happens next). When the job is done it sums it up in a card: what was built, its branch, where it was merged and pushed, what's left to you, and a link to the result.

Committing, merging and pushing are Oraknid's own steps, not tasks. Ask for them in your request ("commit it into dev and push it to GitHub") or later in the conversation: when the job ends Oraknid merges it into your work branch (only if you asked for that in so many words), pushes it to the project's GitHub repo (asking which one, once, if none is linked), and says so. Agents never touch the job folder's `.git`, and if one does, Oraknid puts the folder back and starts the task again.

When a job has already ended and you ask for more ("add a volume control"), The Eye starts a **follow-up job** in the same project, starting from what the first one built, and links to it.

## Answering questions

The Eye asks with options, one question at a time, the one it recommends marked: **↑/↓** move, **Space** selects, **Enter** confirms and goes on, **←/→** or **Tab** move between questions, **1** to **9** pick, and you can always type your own answer. The last tab sums up your answers before you send them.

## Approvals

Some actions always wait for you: a deploy, sending mail, spending money, a push anywhere but the project's GitHub repo, or a force-push. Others depend on the job's **autonomy**: Supervised asks about anything unusual, Standard asks less, Full only for the actions above. Answer in the **Inbox**, from your computer or your phone.

Every answer says what it does: under **Approve** and **Deny** you read what follows (if you deny, the agent is told and tries another way, and you're asked if it can't). When a task keeps going wrong you choose between **Try again with my advice**, **Give it to another Leg**, **I'll do it myself**, **Leave it out** (the tasks that need it are listed and left out too) and **Stop the job** (the work stays on its branch).

## When it's done

The job's **Result**, in Work, shows where the work is (folder, branch, commits; for several repos, each repo's branch and commits). **Merge** puts it into your work branch, after you confirm; with several repos, each into its own work branch, and none if one of them conflicts.
