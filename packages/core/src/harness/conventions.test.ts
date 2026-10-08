import { describe, expect, it } from "vitest";
import { generatedFile } from "../harness.ts";
import { byProductOf, CONVENTIONS, conventionsSaid, ecosystemsOf } from "./conventions.ts";

// Known conventions (ADR-056 → Monitors suspect, a model confirms): what
// each ecosystem writes by itself, found from the project's marker files.

describe("a project's ecosystems, from its marker files", () => {
  it.each([
    [["package.json"], "js"],
    [["deno.json"], "js"],
    [["pyproject.toml"], "python"],
    [["requirements-dev.txt"], "python"],
    [["Cargo.toml"], "rust"],
    [["go.mod"], "go"],
    [["build.gradle.kts"], "gradle"],
    [["pom.xml"], "maven"],
    [["src/App/App.csproj"], "dotnet"],
    [["Gemfile"], "ruby"],
    [["composer.json"], "php"],
    [["mix.exs"], "elixir"],
    [["pubspec.yaml"], "dart"],
    [["Package.swift"], "swift"],
    [["CMakeLists.txt"], "c"],
    [["infra/main.tf"], "terraform"],
    [["stack.yaml"], "haskell"],
    [["build.zig"], "zig"],
  ])("%j → %s", (files, id) => {
    expect(ecosystemsOf(files)).toContain(id);
  });

  it("only those whose markers are there, and every project's own", () => {
    expect(ecosystemsOf(["go.mod", "main.go"])).toEqual(["go", "any"]);
    expect(ecosystemsOf([])).toEqual(["any"]);
    expect(ecosystemsOf(["apps/web/package.json", "api/pyproject.toml"])).toEqual([
      "js",
      "python",
      "any",
    ]);
  });
});

describe("what each writes by itself", () => {
  it.each([
    ["js", "node_modules/react/index.js"],
    ["js", "apps/web/node_modules/.pnpm/x/y.js"],
    ["js", "dist/index.js"],
    ["js", "pnpm-lock.yaml"],
    ["js", "packages/a/tsconfig.tsbuildinfo"],
    ["js", ".next/cache/x"],
    ["js", ".svelte-kit/output/x"],
    ["js", "playwright-report/index.html"],
    ["js", "storybook-static/index.html"],
    ["js", "coverage/lcov-report/index.html"],
    ["python", "src/pkg/__pycache__/m.cpython-312.pyc"],
    ["python", ".venv/bin/python"],
    ["python", "my_pkg.egg-info/PKG-INFO"],
    ["python", "dist/my_pkg-0.1-py3-none-any.whl"],
    ["python", ".pytest_cache/v/x"],
    ["python", "uv.lock"],
    ["rust", "target/debug/app"],
    ["rust", "Cargo.lock"],
    ["go", "go.sum"],
    ["gradle", "app/build/classes/Main.class"],
    ["gradle", ".gradle/8.0/x"],
    ["maven", "target/app.jar"],
    ["dotnet", "src/App/bin/Debug/App.dll"],
    ["dotnet", "src/App/obj/project.assets.json"],
    ["ruby", "vendor/bundle/ruby/3.3/x"],
    ["ruby", "Gemfile.lock"],
    ["php", "vendor/autoload.php"],
    ["php", "composer.lock"],
    ["elixir", "_build/dev/x"],
    ["elixir", "deps/plug/mix.exs"],
    ["dart", ".dart_tool/package_config.json"],
    ["swift", ".build/debug/x"],
    ["swift", "Pods/Alamofire/x"],
    ["c", "cmake-build-debug/CMakeCache.txt"],
    ["c", "build/CMakeFiles/x"],
    ["c", "src/main.o"],
    ["terraform", ".terraform/providers/x"],
    ["any", ".DS_Store"],
    ["any", "src/.DS_Store"],
    ["any", ".idea/workspace.xml"],
  ])("%s: %s", (id, path) => {
    expect(byProductOf(path, ecosystemsOf(markersOf(id)))?.convention).toBe(id);
  });

  it.each([
    ["js", "src/index.ts"],
    ["js", "README.md"],
    ["js", "package.json"],
    ["c", "conf.d/site.conf"],
    ["python", "src/pkg/module.py"],
    ["dotnet", "src/App/Program.cs"],
  ])("%s: %s is the work's own", (id, path) => {
    expect(byProductOf(path, ecosystemsOf(markersOf(id)))).toBeNull();
  });

  it("an ecosystem the project doesn't use explains nothing: a Go project's build/ is its own", () => {
    const go = ecosystemsOf(["go.mod"]);
    expect(byProductOf("build/package/Dockerfile", go)).toBeNull();
    expect(byProductOf("node_modules/x/index.js", go)).toBeNull();
    expect(byProductOf("build/package/Dockerfile")).not.toBeNull();
  });

  it("generatedFile reads the whole table", () => {
    expect(generatedFile("dist/index.js")).toBe(true);
    expect(generatedFile("target/release/app")).toBe(true);
    expect(generatedFile("src/index.ts")).toBe(false);
  });

  it("says each convention in words for the judge", () => {
    expect(conventionsSaid(["rust"])).toEqual(["Rust (cargo): target/, Cargo.lock"]);
  });
});

/** A marker of the convention: the project that uses it. */
function markersOf(id: string): string[] {
  const c = CONVENTIONS.find((x) => x.id === id);
  return c?.markers.length ? [(c.markers[0] as string).replace("*", "x")] : [];
}
