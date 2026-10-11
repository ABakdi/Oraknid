import { ALL_LOCKFILES } from "@oraknid/contracts";
import { globToRegExp } from "../web.ts";

// What each common ecosystem writes by itself (ADR-056 → Monitors suspect,
// a model confirms): installed dependencies, build output, caches, test
// reports, lockfiles. Hard-coded and broad, the fast path: a changed path
// one of these explains is never a suspicion of drift, and no model is
// asked about it. An ecosystem applies to a project when one of its marker
// files is there, so a Go project's own `build/` isn't taken for a
// JavaScript bundle; the conventions with no markers apply to every one.
// What the table doesn't know, a model judges (drift-judge.ts), and what it
// finds is learned per project.

export interface Convention {
  id: string;
  name: string;
  /** File names (globs over a file's name) that say a project uses it; none: every project. */
  markers: readonly string[];
  /**
   * What it writes by itself, under any folder of the project: `name/` a
   * folder and everything in it, otherwise a file name (a glob).
   */
  writes: readonly string[];
}

export const CONVENTIONS: readonly Convention[] = [
  {
    id: "js",
    name: "JavaScript and TypeScript (npm, pnpm, yarn, bun; Vite, Next, Nuxt, SvelteKit, Astro, Remix, Angular; Jest, Vitest, Playwright; Storybook)",
    markers: ["package.json", "deno.json", "deno.jsonc", "bunfig.toml"],
    writes: [
      "node_modules/",
      ".pnpm-store/",
      ".yarn/cache/",
      ".yarn/unplugged/",
      ".yarn/install-state.gz",
      ".pnp.cjs",
      ".pnp.loader.mjs",
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "bun.lockb",
      "bun.lock",
      "deno.lock",
      "dist/",
      "build/",
      "out/",
      ".next/",
      "next-env.d.ts",
      ".nuxt/",
      ".output/",
      ".svelte-kit/",
      ".astro/",
      ".angular/",
      ".remix/",
      ".vercel/",
      ".netlify/",
      ".wrangler/",
      ".expo/",
      ".docusaurus/",
      ".turbo/",
      ".vite/",
      "vite.config.*.timestamp-*",
      ".parcel-cache/",
      ".eslintcache",
      ".stylelintcache",
      "*.tsbuildinfo",
      "storybook-static/",
      "playwright-report/",
      "test-results/",
      "blob-report/",
      ".nyc_output/",
      "coverage/",
    ],
  },
  {
    id: "python",
    name: "Python (pip, uv, poetry, pdm; venvs; pytest, mypy, ruff, tox; wheels)",
    markers: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements*.txt",
      "Pipfile",
      "poetry.lock",
      "uv.lock",
      "tox.ini",
      "*.py",
    ],
    writes: [
      "__pycache__/",
      "*.pyc",
      "*.pyo",
      ".venv/",
      "venv/",
      "__pypackages__/",
      ".tox/",
      ".nox/",
      ".pytest_cache/",
      ".mypy_cache/",
      ".ruff_cache/",
      ".pytype/",
      ".hypothesis/",
      ".ipynb_checkpoints/",
      "build/",
      "dist/",
      "*.egg-info/",
      ".eggs/",
      "*.whl",
      "htmlcov/",
      ".coverage",
      ".coverage.*",
      "coverage.xml",
      "poetry.lock",
      "uv.lock",
      "Pipfile.lock",
      "pdm.lock",
      ".pdm-python",
    ],
  },
  { id: "rust", name: "Rust (cargo)", markers: ["Cargo.toml"], writes: ["target/", "Cargo.lock"] },
  {
    id: "go",
    name: "Go",
    markers: ["go.mod", "go.work"],
    writes: ["go.sum", "go.work.sum", "bin/", "vendor/"],
  },
  {
    id: "gradle",
    name: "Java and Kotlin (Gradle)",
    markers: [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "gradlew",
    ],
    writes: ["build/", ".gradle/", ".kotlin/", "out/"],
  },
  { id: "maven", name: "Java (Maven)", markers: ["pom.xml", "mvnw"], writes: ["target/"] },
  {
    id: "scala",
    name: "Scala (sbt)",
    markers: ["build.sbt"],
    writes: ["target/", ".bsp/", ".bloop/", ".metals/"],
  },
  {
    id: "dotnet",
    name: ".NET",
    markers: ["*.csproj", "*.fsproj", "*.vbproj", "*.sln", "global.json"],
    writes: ["bin/", "obj/", "TestResults/"],
  },
  {
    id: "ruby",
    name: "Ruby (bundler)",
    markers: ["Gemfile", "*.gemspec", "Rakefile"],
    writes: ["vendor/bundle/", ".bundle/", "Gemfile.lock", "tmp/", "log/*.log", ".yardoc/", "pkg/"],
  },
  {
    id: "php",
    name: "PHP (composer)",
    markers: ["composer.json"],
    writes: [
      "vendor/",
      "composer.lock",
      ".phpunit.cache/",
      ".phpunit.result.cache",
      ".php-cs-fixer.cache",
    ],
  },
  {
    id: "elixir",
    name: "Elixir (mix)",
    markers: ["mix.exs"],
    writes: ["_build/", "deps/", "mix.lock", ".elixir_ls/", "cover/"],
  },
  {
    id: "dart",
    name: "Dart and Flutter",
    markers: ["pubspec.yaml"],
    writes: [
      ".dart_tool/",
      "build/",
      "pubspec.lock",
      ".packages",
      ".flutter-plugins",
      ".flutter-plugins-dependencies",
    ],
  },
  {
    id: "swift",
    name: "Swift and Xcode (SwiftPM, CocoaPods)",
    markers: ["Package.swift", "*.xcodeproj", "*.xcworkspace", "Podfile"],
    writes: [".build/", "DerivedData/", "Package.resolved", "Pods/", "Podfile.lock", "xcuserdata/"],
  },
  {
    id: "c",
    name: "C and C++ (CMake, Meson, make, Conan, vcpkg)",
    markers: [
      "CMakeLists.txt",
      "meson.build",
      "Makefile",
      "configure.ac",
      "conanfile.txt",
      "conanfile.py",
      "vcpkg.json",
    ],
    writes: [
      "build/",
      "builddir/",
      "cmake-build-*/",
      "CMakeFiles/",
      "CMakeCache.txt",
      "cmake_install.cmake",
      "compile_commands.json",
      "vcpkg_installed/",
      "*.o",
      "*.obj",
      "*.d",
    ],
  },
  {
    id: "haskell",
    name: "Haskell (stack, cabal)",
    markers: ["stack.yaml", "*.cabal", "cabal.project"],
    writes: [".stack-work/", "dist-newstyle/", "stack.yaml.lock"],
  },
  {
    id: "zig",
    name: "Zig",
    markers: ["build.zig"],
    writes: ["zig-cache/", ".zig-cache/", "zig-out/"],
  },
  {
    id: "terraform",
    name: "Terraform",
    markers: ["*.tf"],
    writes: [".terraform/", ".terraform.lock.hcl"],
  },
  { id: "nix", name: "Nix", markers: ["flake.nix"], writes: ["result", "result-*", "flake.lock"] },
  {
    id: "any",
    name: "Every project (caches, IDE folders, OS files)",
    markers: [],
    writes: [
      ".cache/",
      ".idea/",
      ".vs/",
      ".history/",
      "*.swp",
      "*.swo",
      ".DS_Store",
      "._*",
      "Thumbs.db",
      "desktop.ini",
      "lcov.info",
    ],
  },
];

/** A glob as a whole path's match: a file pattern names the file, not a folder of that name. */
const exactly = (glob: string) => {
  const source = globToRegExp(glob).source;
  // globToRegExp ends every glob with "(?:/.*)?$": a folder's contents; cut here.
  return new RegExp(`${source.slice(0, source.lastIndexOf("(?:"))}$`);
};

const compiled = CONVENTIONS.map((c) => ({
  c,
  markers: c.markers.map(exactly),
  writes: c.writes.map((w) => ({
    pattern: w,
    // A folder and everything in it, at any depth; a file by its name, at any depth.
    re: w.endsWith("/") ? globToRegExp(`**/${w.slice(0, -1)}`) : exactly(`**/${w}`),
  })),
}));

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * The conventions a project's files say it follows: each whose marker is
 * one of `files` (paths relative to the project, its top and a little
 * below, and what changed), and those that apply to every project.
 */
export function ecosystemsOf(files: readonly string[]): string[] {
  const names = [...new Set(files.map(basename))];
  return compiled
    .filter(({ markers }) => !markers.length || names.some((n) => markers.some((m) => m.test(n))))
    .map(({ c }) => c.id);
}

/**
 * Which convention explains a changed path, and by what it writes; null
 * when none. `ecosystems`: the project's (`ecosystemsOf`); left out, all.
 */
export function byProductOf(
  path: string,
  ecosystems?: readonly string[],
): { convention: string; pattern: string } | null {
  const p = path.replace(/^\.\//, "");
  for (const { c, writes } of compiled) {
    if (ecosystems && !ecosystems.includes(c.id)) continue;
    const w = writes.find((x) => x.re.test(p));
    if (w) return { convention: c.id, pattern: w.pattern };
  }
  return null;
}

/** What the project's conventions write, in words, for the drift judge. */
export function conventionsSaid(ecosystems: readonly string[]): string[] {
  return CONVENTIONS.filter((c) => ecosystems.includes(c.id)).map(
    (c) => `${c.name}: ${c.writes.join(", ")}`,
  );
}

// ── Generated files in a repository (ADR-067 §1, §2) ───────────────

/**
 * Folders no repository tracks on purpose: installed dependencies and
 * caches. Found tracked in git, they are untracked, whatever the
 * repository's ignore file says.
 */
export const NEVER_TRACKED: Readonly<Record<string, readonly string[]>> = {
  js: [
    "node_modules/",
    ".pnpm-store/",
    ".next/",
    ".nuxt/",
    ".svelte-kit/",
    ".astro/",
    ".angular/",
    ".turbo/",
    ".vite/",
    ".parcel-cache/",
    ".nyc_output/",
    ".wrangler/",
    ".vercel/",
    ".netlify/",
    ".expo/",
    ".docusaurus/",
  ],
  python: [
    "__pycache__/",
    ".venv/",
    "__pypackages__/",
    ".tox/",
    ".nox/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".pytype/",
    ".hypothesis/",
  ],
  gradle: [".gradle/", ".kotlin/"],
  scala: [".bsp/", ".bloop/", ".metals/"],
  ruby: [".bundle/"],
  elixir: ["_build/", ".elixir_ls/"],
  dart: [".dart_tool/"],
  swift: [".build/", "DerivedData/"],
  haskell: [".stack-work/", "dist-newstyle/"],
  zig: ["zig-cache/", ".zig-cache/"],
  terraform: [".terraform/"],
  any: [".cache/"],
};

/**
 * Build output: some repositories commit theirs on purpose (a GitHub
 * Action's `dist/`), so a tracked one is untracked only in a repository
 * that has no ignore file of its own, one whose first commit took
 * everything. New build output is never committed.
 */
export const BUILD_OUTPUT: Readonly<Record<string, readonly string[]>> = {
  js: [
    "dist/",
    "build/",
    ".output/",
    "storybook-static/",
    "coverage/",
    "playwright-report/",
    "test-results/",
  ],
  python: ["dist/", "build/", ".eggs/", "htmlcov/"],
  rust: ["target/"],
  maven: ["target/"],
  scala: ["target/"],
  gradle: ["build/"],
  dotnet: ["bin/", "obj/"],
  dart: ["build/"],
  zig: ["zig-out/"],
};

const NEVER = new Set(Object.values(NEVER_TRACKED).flat());

/** The ecosystems of a repository's own files, read outside what it installed. */
export function ownEcosystems(paths: readonly string[]): string[] {
  return ecosystemsOf(
    paths.filter((p) => p.split("/").length <= 3 && !p.split("/").some((s) => NEVER.has(`${s}/`))),
  );
}

export interface TrackedGenerated {
  /** The folder, relative to the repository (`node_modules`, `web/dist`). */
  folder: string;
  /** The ignore-file line that keeps it out (`node_modules/`). */
  pattern: string;
  /** How many tracked files are in it. */
  files: number;
}

/**
 * The generated folders a repository tracks (ADR-067 §1): installed
 * dependencies and caches always, build output only when the repository
 * has no ignore file of its own (`ignoreFile` false). `paths`: what
 * `git ls-files` lists. Outermost folders only (`node_modules`, never
 * `node_modules/x/dist`), in path order.
 */
export function trackedGenerated(
  paths: readonly string[],
  o: { ignoreFile: boolean },
): TrackedGenerated[] {
  const names = new Set<string>(["node_modules/"]);
  for (const id of ownEcosystems(paths)) {
    for (const n of NEVER_TRACKED[id] ?? []) names.add(n);
    if (!o.ignoreFile) for (const n of BUILD_OUTPUT[id] ?? []) names.add(n);
  }
  const found = new Map<string, TrackedGenerated>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      const pattern = `${segs[i]}/`;
      if (!names.has(pattern)) continue;
      const folder = segs.slice(0, i + 1).join("/");
      const f = found.get(folder) ?? { folder, pattern, files: 0 };
      f.files++;
      found.set(folder, f);
      break;
    }
  }
  return [...found.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

const LOCKFILE_NAMES = new Set(ALL_LOCKFILES);
const isLockfile = (path: string) =>
  LOCKFILE_NAMES.has(basename(path)) ||
  /(^|\/)(npm-shrinkwrap\.json|go\.work\.sum|Package\.resolved|Podfile\.lock|pubspec\.lock|mix\.lock|pdm\.lock|deno\.lock|flake\.lock|\.terraform\.lock\.hcl|stack\.yaml\.lock)$/.test(
    path,
  );

/**
 * Whether a file is one the project's tools write again by themselves
 * (ADR-067 §1): a change to it in Oraknid's own checkout is never work,
 * and is never allowed to stop a merge.
 */
export function regenerated(path: string, ecosystems?: readonly string[]): boolean {
  return byProductOf(path, ecosystems) !== null;
}

/**
 * Whether a new file is generated and stays out of a commit (ADR-067 §5):
 * what the conventions say a tool writes, except lockfiles, which a
 * project commits. The ignore line that keeps it out comes with it.
 */
export function generatedForCommit(
  path: string,
  ecosystems?: readonly string[],
): { pattern: string } | null {
  if (isLockfile(path)) return null;
  const hit = byProductOf(path, ecosystems);
  // `next-env.d.ts` and the like are written once and kept by many projects: only folders and caches.
  if (!hit) return null;
  return { pattern: hit.pattern };
}

/**
 * The ignore file for a repository that has none (ADR-067 §6): what the
 * ecosystems it uses write by themselves (lockfiles kept), local secrets
 * and the operating system's files.
 */
export function ignoreTemplate(ecosystems: readonly string[]): string {
  const lines: string[] = [];
  const add = (l: string) => {
    if (!lines.includes(l)) lines.push(l);
  };
  for (const c of CONVENTIONS) {
    if (!ecosystems.includes(c.id) || c.id === "any") continue;
    for (const w of c.writes) if (!isLockfile(w)) add(w);
  }
  const any = CONVENTIONS.find((c) => c.id === "any");
  return [
    "# Written by Oraknid: what the project's tools make by themselves, never committed.",
    ...lines,
    "",
    "# Local secrets",
    ".env",
    ".env.*",
    "!.env.example",
    "!.env.sample",
    "!.env.template",
    "*.pem",
    "*.key",
    "",
    "# Editors and the operating system",
    ...(any?.writes ?? []),
    "",
  ].join("\n");
}

/**
 * The ignore lines a repository's existing file lacks for generated
 * folders that are there (ADR-067 §6): `present` are the folders found in
 * the work tree, `text` the ignore file. A line counts in any of its
 * usual spellings (`node_modules`, `/node_modules/`, `**\/node_modules`).
 */
export function missingIgnoreLines(text: string, present: readonly string[]): string[] {
  const have = new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) =>
        l
          .replace(/^\*\*\//, "")
          .replace(/^\//, "")
          .replace(/\/$/, ""),
      ),
  );
  return [...new Set(present)].filter((p) => !have.has(p.replace(/\/$/, ""))).map((p) => p);
}
