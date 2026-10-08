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
