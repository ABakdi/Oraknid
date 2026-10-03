# Audit 2 — nobody else drives my computer

Opened 2026-10-02 on `dev`, after The Nest went live on a public server.
Whoever drives Oraknid drives my computer: this audit looks for every
way someone else could. It is finished when every finding is **Fixed**
(and how) or **Open** (and why, and what comes next).

## How it was run

Four read-only reviews side by side, each hostile, each on one surface:
- **Remote (`R`)**: The Nest relay, the end-to-end tunnel, the daemon's
  side of it, the loader. A replay was reproduced in a test.
- **Local surface (`L`)**: the HTTP API, the sockets, pairing, the CLI,
  probed against the running daemon without a token.
- **Containment (`C`)**: the sandbox, the command policy, secrets given
  to Legs. The sandbox escape was reproduced with bwrap.
- **Web client (`W`)**: what renders agent-made content, token storage,
  headers, confirmation steps.

Then [[ADR-029-App-Lock]]: a PIN on every device, checked by the daemon.

## Findings

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| S2-01 (C) | Critical | `packages/os` bwrap | `--share-net` keeps the host's network namespace, where abstract unix sockets live: from a job, a terminal's single-instance socket or X11 ran code outside the sandbox. | Fixed: every sandbox runs under a Landlock domain scoping abstract sockets and signals; a test connects to a host abstract socket and is refused. |
| S2-02 (R, W) | Critical | loader | A broken-into Nest can serve a changed loader, which holds the device's keys and token; one script in the UI could read them too. | Partly fixed: the UI runs in a sandboxed frame (opaque origin) behind a message port, so a UI injection can't reach the keys; the PIN guards the token; away from home nothing opens a new way in. Open: a changed loader still catches the PIN as I type it. A native app or an installed loader with pinned code would close it. |
| S2-03 (R) | High | `packages/tunnel` | The stream header could be accepted again: The Nest could replay recorded requests inside a live tunnel. | Fixed: one handshake and one header per tunnel; a test replays both. |
| S2-04 (R, L) | High | API | Every device, also away from home, had every right: pair more devices, revoke mine, turn the terminal on, change policies, add tools, Legs, servers, projects anywhere. | Fixed: a PIN and an unlocked session on every call (ADR-029); away from home, those calls are refused, and so is a job outside the sandbox; the helper's project and Leg actions are confirmed, and not from away. |
| S2-05 (R, L) | High | live, terminal | A revoked or locked device kept its open live socket, terminal and tunnel, and its push subscription. | Fixed: sockets are checked at every heartbeat and at once on a lock or a revocation; the tunnel ends; push subscriptions belong to a device and go with it. The terminal never opens away from home. |
| S2-06 (C) | High | `core/shell.ts` | `bash -c '…'`, `find -exec`, `xargs`, `env`, `timeout`… hid the programs they run from the policy: `bash -c 'curl …'` was allowed. | Fixed: wrappers are read through; tests for each. |
| S2-07 (W) | High | Markdown | An image in an agent's message made my browser fetch any address: a way out for what an agent read. | Fixed: images show as text. |
| S2-08 (C) | Medium | `eye/attempt.ts` | Server keys stayed in the Leg's home after a job, for the next job of another project. | Fixed: the Leg's `~/.ssh` is emptied at every attempt. Open: two jobs running at once on one Leg share its home. |
| S2-09 (W, L) | Medium | daemon, Nest | No security headers: any site could frame the UI (clickjacking an Approve). | Fixed: CSP, `frame-ancestors 'none'`, `X-Frame-Options`, no-sniff, no referrer, `no-store` on the API; cross-site requests other than a page load are refused; HSTS on The Nest. |
| S2-10 (W) | Medium | terminal | A link printed in the terminal could be `javascript:`. | Fixed: only http(s) links open. |
| S2-11 (W) | Medium | helper | The Confirm card showed only the model's summary. | Fixed: the action and its exact input show. |
| S2-12 (W) | Medium | approvals | A command with a line of backticks could close its code block and render a fake "safe" line. | Fixed: the fence is longer than any backticks inside. |
| S2-13 (W) | Medium | UI | Approve all, the terminal switch and the like were one click. | Fixed for the terminal (a confirm step); open for "Approve all like this", which names its scope in its label. |
| S2-14 (R) | Medium | relay | Anyone could fill a daemon's device slots: no Origin check, no deadline for the handshake, IPv6 counted per address. | Fixed: Origin, ten seconds and three small frames before the daemon answers, IPv6 by /64. |
| S2-15 (R) | Medium | pairing link | The link (its QR code) was a lasting credential. | Fixed: it expires unused after ten minutes, and needs the PIN after. Open: the keys are made at home; made on the phone, the link would carry none. |
| S2-16 (L) | Medium | CLI | `oraknid open` put the pairing code in a command line, readable by every user (`/proc`). | Fixed: the code stays in the terminal. |
| S2-17 (L) | Low | events | Scrubbing the JSON of an event could run across fields and drop them. | Fixed: each string is scrubbed alone. |
| S2-18 (L) | Low | job inputs | A file input could be a link out of the project (to my keys). | Fixed: its real path must stay in the project. |
| S2-19 (L) | Low | data | The database files were 0644 (in a 0700 folder). | Fixed: 0600. |
| S2-20 (R) | Low | relay | A daemon secret could be empty; the 502 said too much; push could post to any address. | Fixed: 32 characters at least; a plain message; push only to the browsers' push services. |
| S2-21 (C) | Medium | sandbox | TCP on the host's loopback is reachable from a job (the API needs a token; other local services may not). | Fixed 2026-10-03: every sandbox has a network namespace of its own through pasta; this computer's services are reachable only on the ports a project lists or a Leg's own local model; a test checks both. |
| S2-22 (L) | Low | port | On a machine with other users, another user could take the port while the daemon is down. | Open: Oraknid assumes a computer that is mine alone; documented in [[Security]]. |
| S2-23 | Low | secrets | Two Oraknid daemons of one user (a second data folder, for a test) share the keychain's entries: configuring one's Nest replaced the other's secret (seen while testing this audit; put back). | Fixed 2026-10-03: each data folder's entries are under a service of its own, `oraknid:<id>`, the id kept in the folder; the default folder's daemon moves the entries of before under its own at start, without logging a value; tests on a fake keychain and on a real Secret Service in a throwaway D-Bus session (`apps/daemon/scripts/secret-service-test.sh`) show two folders don't see each other's secrets ([[Security]]). |

## Where it stands (2026-10-03)

23 findings: 17 fixed, 4 fixed in part (S2-02, S2-08, S2-13, S2-15),
2 open (S2-22, S2-23). Every critical and high finding is fixed except S2-02 (critical, fixed in part);
S2-21 closed on 2026-10-03 with a network of its own for every sandbox
([[Sandboxing]]). Still to come: the loader's code pinned or a native
app (S2-02), a home per job on a shared Leg (S2-08), keychain entries
named per data folder (S2-23). [[ADR-030-Device-Rights]] later let a
device I choose do away from home what S2-04 kept at home; what stays
home only is listed there.

## Checked and not possible

DNS rebinding and cross-origin calls to the API; a token in the address
for the API; reading `daemon.json` or the database from a job; a Leg
pushing with my GitHub token; git hooks or config from a worktree; The
Nest reading or forging tunnel traffic, or a replayed hello or welcome;
a stolen token riding another device's tunnel; XSS through Markdown
(raw HTML is escaped, `javascript:` links blanked).

Related: [[Audit-1]] · [[Security]] · [[ADR-029-App-Lock]] · [[Phase-10-Lockdown]]
