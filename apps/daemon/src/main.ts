#!/usr/bin/env node
// The entry (dist/cli.mjs): it only sizes the thread pool, before anything
// can use it, then loads the program (ADR-070). The pool is made at its
// first use, of UV_THREADPOOL_SIZE threads (4 unset): a few slow calls
// must never hold every file read, and the web UI with them. The service's
// unit sets it too; this covers a daemon started by hand.
process.env.UV_THREADPOOL_SIZE ||= "16";
await import("./cli.ts");

export {};
