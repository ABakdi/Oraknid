import { describe, expect, it } from "vitest";
import { ownRepoPage } from "../harness/gate.ts";

const repos = [{ github: { owner: "ABakdi", name: "oraknid-piano" } }, { github: null }];

describe("reading the project's own repo on GitHub isn't outside content (BR-15)", () => {
  it("knows the repo's page, its API and its raw files, and nothing else", () => {
    for (const url of [
      "https://github.com/ABakdi/oraknid-piano",
      "https://github.com/abakdi/oraknid-piano/tree/dev",
      "https://github.com/ABakdi/oraknid-piano.git",
      "https://api.github.com/repos/ABakdi/oraknid-piano/branches/dev",
      "https://raw.githubusercontent.com/ABakdi/oraknid-piano/dev/README.md",
    ])
      expect(ownRepoPage(url, repos), url).toBe(true);
    for (const url of [
      "https://github.com/someone/oraknid-piano",
      "https://github.com/ABakdi/other",
      "https://api.github.com/users/ABakdi",
      "https://example.com/ABakdi/oraknid-piano",
      "http://github.com/ABakdi/oraknid-piano",
      "https://github.com.evil.example/ABakdi/oraknid-piano",
      "not a url",
    ])
      expect(ownRepoPage(url, repos), url).toBe(false);
    expect(ownRepoPage(null, repos)).toBe(false);
  });
});
