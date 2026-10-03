# Phase 13 — Projects first

Touches [[Web-UI]], [[Jobs-and-Projects]], [[The-Eye]], [[Silk]], [[Budgets-and-Quotas]], [[The-Nest]].
Written 2026-10-03.

## Why

A job page beside a project page confused me: the work I asked for on
the piano project went to a job I wasn't looking at. I work in a
project; jobs should be its history. And my Nests showed too little
(public) or too much (private).

## Milestones

### M13.1 — The project is the place ([[ADR-034-Projects-First]])
- [ ] The Eye's conversation per project; talking from the project starts or feeds its jobs
- [ ] The project page: The Eye, The Web across its jobs, Work (the jobs as a timeline, each opened in place), Inbox, Silk by job, Activity, Budget & stats, Settings
- [ ] No job page and no Jobs page: their links open the project at Work, "Running now" on the Overview
- [ ] New work lands in the project's Eye tab
- [ ] A project budget across its jobs, and the default for a new job in it
- [ ] Context packs take earlier jobs' standing Silk

### M13.2 — What a Nest shows ([[ADR-035-Nest-Pages-By-Mode]])
- [x] Public: Open Oraknid in the site's header and hero, and a strip under the hero saying this is a public Nest (open, or invite needed, from `/info`) with Pair or open a device
- [x] Private: no site, a bare 404 everywhere but the loader and the relay, `X-Robots-Tag: noindex` on everything, robots.txt disallowing all; the loader page `noindex` on both kinds
- [x] My private Nest's address out of the canon and the repository's files (old commits still have it)

Tested (M13.2): `apps/nest/src/relay.test.ts` (a public Nest's site
indexable and its loader not; a private Nest's root, site pages and
unknown paths a bare 404, its loader served, robots.txt); both kinds
run locally and the public site checked at 1440 and 390 px.

## Exit criterion

I ask for new work on the piano project from its Eye tab and follow it
there to the end, without a job page; a search engine and a visitor
find nothing on my private Nest.

Related: [[Roadmap]] · [[Phase-11-Workspace]]
