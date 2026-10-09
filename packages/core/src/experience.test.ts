import { describe, expect, it } from "vitest";
import { hasUi } from "./experience.ts";

describe("hasUi (ADR-064 §4)", () => {
  it("sees work I will see or use", () => {
    for (const goal of [
      "Keys: a piano in the browser with knobs I can hear and a phone layout.",
      "A dashboard of my servers' disk use.",
      "Redesign the landing page.",
      "A mobile app to log my runs.",
      "Make a logo for Harvest.",
    ])
      expect(hasUi(goal), goal).toBe(true);
  });

  it("sees none in a backend, a script or server work", () => {
    for (const goal of [
      "Add a REST API endpoint that exports invoices as CSV, with a test.",
      "A cron script that backs up the database every night.",
      "Install fail2ban on the staging server and enable the sshd jail.",
      "Migrate the users table to the new database schema.",
      "Fix the flaky test in the billing module.",
    ])
      expect(hasUi(goal), goal).toBe(false);
  });

  it("sees a UI named beside backend words", () => {
    expect(hasUi("An API endpoint for scores, and a dashboard page that shows them.")).toBe(true);
  });
});
