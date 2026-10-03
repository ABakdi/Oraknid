# Jobs and The Eye

A **job** is one piece of work: a goal in a project. **The Eye** is the part of Oraknid that plans it and supervises the agents doing it.

## Starting a job

In a project, ask for it in the project's **The Eye** tab: The Eye starts a job, or adds the work to the one running. **New work** is for a first request, a new project, or a draft to keep and start later. The Eye may ask a few questions first, then writes the plan.

Each job works on its own branch, in its own worktree inside your project. Your branch is never touched until you merge.

## What The Eye does

- **Plans** the goal into small tasks, each with checks that prove it is done.
- **Routes** each task to the Leg that fits it best: its strengths, its quota left, how busy your computer is.
- **Watches** every agent: drift, loops, edits outside the task, tokens burned without progress. It corrects, hands the task to another Leg, or asks you.
- **Checks** the work. A task is done when its checks pass, not when an agent says so.

## Following a job

Everything is in its project, in tabs: **The Eye** (one conversation for the whole project), **Workflow** (the jobs as a diagram: compact, a box per job you open for its tasks, or expanded, every job's tasks), **Work** (the jobs newest first; open one for its tasks, result, agents, activity, controls and settings), **Inbox**, **Silk** (what is known, by job), **Activity**, **Budget & stats** and **Settings**. Keys `1` to `9` switch tabs. **Running now** on the Overview lists every job running or waiting, across projects.

## Talking to The Eye

Write anything in the project's **The Eye** tab: an instruction, a new task, some context, a question, or "stop that". It decides what your message is and acts on it, then tells you what it did.

When a job has already ended and you ask for more ("add a volume control"), The Eye starts a **follow-up job** in the same project, starting from what the first one built, and links to it.

## Answering questions

The Eye asks with options, one question at a time, the one it recommends marked: **↑/↓** move, **Space** selects, **Enter** confirms and goes on, **←/→** or **Tab** move between questions, **1** to **9** pick, and you can always type your own answer. The last tab sums up your answers before you send them.

## Approvals

Some actions always wait for you: a push, a merge, a deploy, sending mail, spending money. Others depend on the job's **autonomy**: Supervised asks about anything unusual, Standard asks less, Full only for the actions above. Answer in the **Inbox**, from your computer or your phone.

## When it's done

The job's **Result**, in Work, shows where the work is (folder, branch, commits). **Merge** puts it into your work branch, after you confirm.
