// The product site (ADR-033): static pages a Nest serves at its root, with
// the phone loader under /app/. The home page and the guide are written
// here and in docs/*.md; this script renders them into dist/ with one
// layout, self-hosted fonts (the app's: IBM Plex Sans, JetBrains Mono) and Phosphor icons. Nothing loads from
// elsewhere: the Nest's pages allow only themselves.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const mod = (p) => join(here, "node_modules", p);

export const SITE = {
  repo: "https://github.com/ABakdi/Oraknid",
  github: "https://github.com/ABakdi",
  linkedin: "https://www.linkedin.com/in/abderrahmane-bakdi-171b821bb",
  email: "a.bakdi@abakdi.com",
};

/** A Phosphor icon, inline. */
export function icon(name, cls = "icon") {
  const svg = readFileSync(mod(`@phosphor-icons/core/assets/regular/${name}.svg`), "utf8");
  return svg.replace("<svg ", `<svg class="${cls}" aria-hidden="true" focusable="false" `);
}

/** The guide's pages, in reading order: file, title, one line. */
const GUIDE = [
  ["getting-started", "Getting started", "Install it, open it, set your PIN, add a Leg."],
  ["jobs", "Jobs and The Eye", "Starting work, following it, talking to The Eye."],
  ["legs", "Legs", "The agents and models Oraknid hands work to."],
  ["projects", "Projects, repos and servers", "Where work happens, and what it may reach."],
  ["phone", "Your phone, from anywhere", "Pairing, the PIN, and The Nest."],
  ["mail", "Mail", "Your accounts, and agents that draft for you."],
  ["security", "Security", "What keeps your computer yours."],
  ["nest", "Hosting a Nest", "Your own relay, private or public, in one script."],
];

const nav = (active) => `
<header class="nav">
  <div class="wrap nav-row">
    <a class="brand" href="/" aria-label="Oraknid home">
      <img src="/logo.svg" alt="" width="30" height="30" />
      <span>Oraknid</span>
    </a>
    <nav aria-label="Main">
      <a href="/#how"${active === "how" ? ' aria-current="page"' : ""}>How it works</a>
      <a href="/docs/"${active === "docs" ? ' aria-current="page"' : ""}>Docs</a>
      <a href="/#install"${active === "install" ? ' aria-current="page"' : ""}>Install</a>
      <a class="nav-gh" href="${SITE.repo}" rel="noopener">${icon("github-logo")}<span>GitHub</span></a>
    </nav>
  </div>
</header>`;

const footer = () => `
<footer class="footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <img src="/logo.svg" alt="" width="40" height="40" />
      <p>Oraknid is built by Abderrahmane Bakdi. Questions, ideas, or a Leg you want supported: write to me.</p>
    </div>
    <ul class="footer-links">
      <li><a href="mailto:${SITE.email}">${icon("envelope-simple")}${SITE.email}</a></li>
      <li><a href="${SITE.github}" rel="noopener">${icon("github-logo")}github.com/ABakdi</a></li>
      <li><a href="${SITE.linkedin}" rel="noopener">${icon("linkedin-logo")}LinkedIn</a></li>
    </ul>
    <p class="footer-note">This server is also a public Nest: an Oraknid daemon can register on it to reach its owner's phone. It only ever carries encrypted traffic.</p>
  </div>
</footer>`;

const page = ({ title, description, body, active, path }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="theme-color" content="#0E0C16" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="https://oraknid.abakdi.com/og.png" />
<meta property="og:url" content="https://oraknid.abakdi.com${path}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="https://oraknid.abakdi.com${path}" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="preload" href="/fonts/plex-sans.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/site.css" />
<script src="/site.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
${nav(active)}
<main id="main">
${body}
</main>
${footer()}
</body>
</html>
`;

function build() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "fonts"), { recursive: true });
  mkdirSync(join(out, "docs"), { recursive: true });
  copyFileSync(
    mod("@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2"),
    join(out, "fonts/plex-sans.woff2"),
  );
  copyFileSync(
    mod("@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"),
    join(out, "fonts/jetbrains-mono.woff2"),
  );
  cpSync(join(here, "public"), out, { recursive: true });
  copyFileSync(join(here, "src/site.css"), join(out, "site.css"));
  copyFileSync(join(here, "src/site.js"), join(out, "site.js"));

  // The home page: its sections are in src/home.html.
  const home = readFileSync(join(here, "src/home.html"), "utf8").replace(
    /\{\{icon:([a-z-]+)(?::([a-z -]+))?\}\}/g,
    (_, n, c) => icon(n, c ?? "icon"),
  );
  const guideCards = GUIDE.map(
    ([slug, t, line]) =>
      `<a class="doc-card" href="/docs/${slug}.html"><span class="doc-title">${t}</span><span class="doc-line">${line}</span>${icon("arrow-right", "icon arrow")}</a>`,
  ).join("\n");
  writeFileSync(
    join(out, "index.html"),
    page({
      title: "Oraknid: coding agents that finish the job",
      description:
        "A self-hosted supervisor for Claude Code, OpenCode, Antigravity and local models. It plans, runs agents in a sandbox, checks their work, and asks you only when it matters.",
      body: home.replace("{{guide}}", guideCards).replaceAll("{{repo}}", SITE.repo),
      active: "",
      path: "/",
    }),
  );

  // The guide: one page per file, with a side list of every page.
  const side = (current) =>
    `<nav class="doc-side" aria-label="Guide"><a href="/docs/"${current === "" ? ' aria-current="page"' : ""}>Overview</a>${GUIDE.map(([slug, t]) => `<a href="/docs/${slug}.html"${current === slug ? ' aria-current="page"' : ""}>${t}</a>`).join("")}</nav>`;
  writeFileSync(
    join(out, "docs/index.html"),
    page({
      title: "The Oraknid guide",
      description: "How to install, run and use Oraknid.",
      active: "docs",
      path: "/docs/",
      body: `<div class="wrap doc-layout">${side("")}<article class="doc"><h1>The guide</h1><p class="lead">Everything you need to run Oraknid on your own computer. Start with Getting started; the rest you can read when you need it.</p><div class="doc-grid">${guideCards}</div><p>The design notes behind every part of Oraknid (its specification, architecture and decisions) live in the repository, under <a href="${SITE.repo}/tree/dev/docs">docs/</a>.</p></article></div>`,
    }),
  );
  GUIDE.forEach(([slug, t, line], i) => {
    const md = readFileSync(join(here, "docs", `${slug}.md`), "utf8").replaceAll(
      "{{repo}}",
      SITE.repo,
    );
    const prev = GUIDE[i - 1];
    const next = GUIDE[i + 1];
    const pager = `<nav class="pager" aria-label="Next and previous">${prev ? `<a href="/docs/${prev[0]}.html"><span>Previous</span>${prev[1]}</a>` : "<span></span>"}${next ? `<a class="next" href="/docs/${next[0]}.html"><span>Next</span>${next[1]}</a>` : ""}</nav>`;
    writeFileSync(
      join(out, `docs/${slug}.html`),
      page({
        title: `${t}: the Oraknid guide`,
        description: line,
        active: "docs",
        path: `/docs/${slug}.html`,
        body: `<div class="wrap doc-layout">${side(slug)}<article class="doc">${marked.parse(md)}${pager}</article></div>`,
      }),
    );
  });

  // Every placeholder was filled.
  if (/\{\{/.test(readFileSync(join(out, "index.html"), "utf8")))
    throw new Error("A {{placeholder}} is left on the home page");
  // Nothing on any page may carry a long dash: the house style uses hyphens and full stops.
  for (const f of readdirSync(out)
    .filter((f) => f.endsWith(".html"))
    .map((f) => join(out, f))
    .concat(readdirSync(join(out, "docs")).map((f) => join(out, "docs", f))))
    if (/[–—]/.test(readFileSync(f, "utf8"))) throw new Error(`A long dash in ${f}`);
  console.log(`site built into ${out}`);
}

build();

// The Nest's build copies the site into its public folder (an argument: the target).
const target = process.argv[2];
if (target) {
  mkdirSync(target, { recursive: true });
  // The Nest's public folder: the loader's app/ stays, everything else is the site's.
  for (const f of readdirSync(target))
    if (f !== "app") rmSync(join(target, f), { recursive: true, force: true });
  const copy = (from, to) => {
    for (const f of readdirSync(from, { withFileTypes: true })) {
      if (f.isDirectory()) {
        mkdirSync(join(to, f.name), { recursive: true });
        copy(join(from, f.name), join(to, f.name));
      } else copyFileSync(join(from, f.name), join(to, f.name));
    }
  };
  if (existsSync(out)) copy(out, target);
}
