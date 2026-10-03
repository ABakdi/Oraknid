import { describe, expect, it } from "vitest";
import { legLocalPorts } from "./plan.ts";

describe("a Leg's own local services (Sandboxing → network)", () => {
  it("finds the ports on this computer its settings name", () => {
    expect(legLocalPorts({ baseUrl: "http://localhost:11434/v1" })).toEqual([11434]);
    expect(
      legLocalPorts({ providers: [{ url: "https://127.0.0.1" }, { url: "http://[::1]:8000" }] }),
    ).toEqual([443, 8000]);
    expect(legLocalPorts({ baseUrl: "https://api.example.com/v1" })).toEqual([]);
  });
});
