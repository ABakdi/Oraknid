# Reviews

Tests passing is not the same as getting what you meant. For anything you will see or use, a job stops at its **evaluation steps** and shows you the work: first a **design** (clickable screens, before the features are built), later **the running app**. You look at it on a phone, a tablet and a desktop, point at what you like or don't, and the notes go back to the job as work.

## When a review opens

Before it shows you anything, Oraknid loads it itself, the way the review page will, on a phone-sized and a desktop-sized screen, and looks at whether it rendered: something drawn on the page, no error thrown, not raw source code or a list of files. A review never opens on a blank page.

To run the app it tries, in order: the plan's command, the project's `dev` (or `start`) script, the command in its README, its `build` script with the built files served, and a plain `index.html`. Each command is given its port (a Vite or Next dev server gets `--port`, `pnpm dev` included), and if the app prints another address ("Local: http://localhost:5173/"), that one is used. When none of them renders, an agent looks at what went wrong in the job's folder (missing packages, its configuration, the port) and says how to start it, twice at most.

When a design or the app is ready, Oraknid opens the **review page in a new tab**. If your browser blocks the tab (browsers do when nothing was clicked), you get a notification and a message with **Open**, the project's page shows **A design is ready for your review** with **Open** under its current work, and the [inbox](inbox.html) has an item with **Open the review**.

## When the app didn't start

If nothing renders, the review still opens, but on why instead of a page: **The app didn't start**, the reason in plain words, and **Oraknid tried** with each way it ran the app and what it said. The job waits on it, and you get one notification. Fix what's wrong (or let a task of the job do it), then press **Try again**, or write "try again" in the project's chat: Oraknid runs the whole list again and the review shows the app as soon as it renders. You can still **Approve** without looking, or write notes in words.

A review left open when Oraknid stops is made ready again when it starts: its app is started again, and a review from an earlier version that showed the project's folder instead of the app is prepared again, with nothing for you to do.

## The review page

The top bar names the project, what is reviewed and the round, with **Send notes (n)** and **Approve**; **checked: renders on phone, desktop** says Oraknid saw it render before showing it. Under it:

- **Device**: Phone 390×844, Tablet 820×1180, Laptop 1440×900, Desktop 1920×1080, each turned to landscape with the turn button, or a width and height of your own. The page is shown at that size, zoomed to fit (**Fit**, or **100%** to see it at its real size and scroll).
- **Screen**: a design made of one page per device (say `phone-portrait.html`, `phone-landscape.html` and `desktop.html`) shows the page that fits the device you picked, each time you change it. **Screen** lists all its pages, so you can open any of them; your pick stays until you change the device, or pick **Match device**.
- **Select**: point at the page and its parts are outlined; click one to note it. While selecting, the page's own buttons don't react; **Esc** stops.
- **General note**: a note about the whole of it.

A note has a kind and your words:

| Kind | Means |
| :-- | :-- |
| Keep | I like this: keep it. Kept as a rule for the work after. |
| Change | A suggestion. |
| Problem | Something wrong. |
| General | About the whole, on no part in particular. |

Each note keeps the device it was written on, the part you clicked (found again by its place on the page), its text and a small picture of it. Reviewing the running app, the app's console errors and failed requests up to that moment are attached too, so the agents see what went wrong.

Notes show as numbered **pins** on the page, for the device you wrote them on. The **Notes** list on the right (a bottom sheet on a phone) groups them by device; filter by kind, click one to see its part (the page switches to its device), edit or delete it while the round is open. **Earlier rounds** shows the notes you sent before.

## Send notes or Approve

- **Send notes** ends the round: The Eye turns your notes into work (on the design, or on the plan if a note changes what is built) and opens the next round when it is ready, in a new tab again.
- **Approve** ends the review and the work goes on. Keep notes travel with it. Approving with other notes asks first: they would only be kept, not worked on.

## Notes from the chat

While one review is open in a project, a message in its [Eye chat](jobs.html) about how it looks or feels ("the knobs are too small on the phone") is added to the review as a general note, and The Eye says so. Orders ("stop", "cancel") and questions go to The Eye as usual.

## Away from home

Through [The Nest](phone.html), a phone can read a review and its notes. Writing notes, sending and approving need a device with full rights. Away from home the page comes through the tunnel as one document: a design shows as at home; an app under development may show only its HTML (its scripts can't load that way), and the page says what it couldn't show.

## What it touches

Nothing in your project is changed. The design is read from its folder, inside the project, and nothing outside it; the app is reached on its own port on this computer only. What you review runs on an address of its own (`rv-….localhost`), apart from Oraknid's, so a page made by an agent can't act as you in Oraknid. More in [Security](security.html).
