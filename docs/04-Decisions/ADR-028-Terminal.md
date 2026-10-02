# ADR-028 — A terminal in the web UI: xterm.js, node-pty and SSH

**Status:** Accepted · 2026-10-02 · [[Phase-9-Servers]]

## Context
I want a terminal in Oraknid's web UI: on this computer, or on one of
my servers. A terminal emulator is a large thing to write; xterm.js is
the standard one.

## Decision
- **xterm.js** in the browser (with its fit add-on), lazily loaded on
  the Terminal page only.
- **This computer**: a real pseudo-terminal from `node-pty`, my login
  shell, in my home folder, as me. **A server**: an SSH shell with a
  pty through the server's connection (ADR-026).
- **One WebSocket per terminal** (`/term`), authenticated like `/live`
  by the device's token; keystrokes and resizes in, output out.
- **Off by default**: a setting (Settings → Terminal) turns it on; with
  it off, `/term` refuses. Every terminal opened is audited (device,
  target, when; never what is typed). Not through The Nest yet.
- A terminal closes when its page does; nothing keeps running after.

## Consequences
- Anyone with a paired device and the setting on has a shell on this
  machine: pairing is the gate, as for everything else.

Related: [[Servers]] · [[Security]] · [[Web-UI]]
