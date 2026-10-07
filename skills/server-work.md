---
name: server-work
description: Work on one of my servers over SSH — install, configure, upgrade, rotate, or find out why something is broken — reading its state document first, changing only what the goal needs, and checking the result on the server itself. Used by a server's own jobs, asked for in its Chat tab.
interview: false
requires:
  tools: []
verify: []
---

# Server work

The job's place is a server, not a repo. Its folder is a scratch
folder of Oraknid's, for notes and scripts; the work is done on the
server through its SSH alias (`ssh <alias>`, `scp`, `rsync`), given in
the context with the server's **state document**: what runs there and
what must not break. Read it before anything else.

The work, in this order:

1. **Look.** Read-only commands first: the service's status, its logs,
   its configuration, the package's version. A question ("why does
   nginx return 502 for x.com") is answered from this alone: write the
   findings to `findings.md` in the folder, with the commands and what
   they printed, and change nothing.
2. **Say what will change.** Before a change, the plan says it in
   plain words: the packages, files, services and ports it touches.
   Nothing else on the server is the job's.
3. **Change, carefully.** Keep a copy of a configuration file before
   editing it (`cp nginx.conf nginx.conf.oraknid-<date>`), test a
   configuration before reloading (`nginx -t`, `sshd -t`), reload
   rather than restart when the service can, and never stop what the
   state document says must keep running. Root commands go through
   `sudo -n`; when the user can't, say so rather than look for a way
   around it.
4. **Check on the server.** Each task that changes something has
   checks that run there: `ssh <alias> systemctl is-active fail2ban`,
   `ssh <alias> nginx -t`, `ssh <alias> curl -sf http://localhost/health`.
   Oraknid runs them itself over its own connection; a check only
   reads. A check names the alias alone: never `HOME=…`, `-F`, `-i`,
   `-o` or the job's own paths (its home, its ssh config), which are
   not where checks run. A check that guards what must keep running
   ends with `# guard`, passes before the work too, and says "still
   running" by name rather than an exact count:
   `ssh <alias> '[ "$(docker ps -q --filter name=harvest- | wc -l)" -ge 1 ]' # guard`.
   A check that seems wrong is The Eye's to fix: say why, never make
   it pass another way (a file of your own that stands in for a tool).
5. **Say what changed.** The task's last words list what was changed
   on the server, a line each ("installed fail2ban 1.1.0", "enabled
   the sshd jail", "edited /etc/nginx/sites-enabled/x.com"). Oraknid
   discovers the server again when the job ends and writes it into the
   state document.

A small job is one task: "install fail2ban" is install, enable, check.
Every command on a server goes through Oraknid's approvals; on a
server marked production, every change asks me first.

## Checks

- Nothing outside the goal was changed on the server.
- Every changed configuration was tested before it was loaded.
- The services the state document says must keep running still run.
