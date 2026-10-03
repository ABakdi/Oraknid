import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorOf, docHref, GUIDE, guideFor, searchGuide, terms } from "./guide";

// The guide inside Oraknid (ADR-041): the site's pages, searched and linked.

describe("the guide", () => {
  it("is the site's guide, in its order, with its headings", () => {
    const order = JSON.parse(
      readFileSync(join(__dirname, "../../../site/docs/guide.json"), "utf8"),
    ) as [string, string][];
    expect(GUIDE.map((p) => [p.slug, p.title])).toEqual(order.map(([s, t]) => [s, t]));
    const start = GUIDE[0];
    expect(start?.body.startsWith("# Getting started")).toBe(true);
    // The site's placeholder is filled in, as on the site.
    expect(start?.body).not.toContain("{{repo}}");
    expect(start?.headings.map((h) => h.id)).toContain("what-you-need");
  });

  it("makes anchors and maps the site's links to the app's pages", () => {
    expect(anchorOf("Your phone, from anywhere")).toBe("your-phone-from-anywhere");
    expect(anchorOf("Install `oraknid`")).toBe("install-oraknid");
    expect(docHref("jobs.html")).toBe("/docs/jobs");
    expect(docHref("/docs/nest.html#your-own")).toBe("/docs/nest/your-own");
    expect(docHref("/docs/")).toBe("/docs");
    expect(docHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(docHref("https://example.com/x.html")).toBe("https://example.com/x.html");
  });

  it("searches headings and text, headings first", () => {
    expect(terms("How do I pair my phone?")).toEqual(["pair", "phone"]);
    const hits = searchGuide("pair phone");
    expect(hits[0]?.slug).toBe("phone");
    expect(hits[0]?.href).toMatch(/^\/docs\/phone(\/[\w-]+)?$/);
    expect(hits[0]?.snippet.length).toBeGreaterThan(10);
    // A word in a heading outweighs the same word in passing.
    const secrets = searchGuide("secrets");
    expect(secrets[0]).toMatchObject({ slug: "security", heading: "Secrets" });
    expect(secrets[0]?.href).toBe("/docs/security/secrets");
    expect(secrets[1]?.slug).toBe("getting-started");
    expect(searchGuide("")).toEqual([]);
    expect(searchGuide("zzqxv")).toEqual([]);
  });

  it("gives the helper the related pages, the asked-from page first, or the whole guide", () => {
    const mail = guideFor("add an IMAP account for my email");
    expect(mail[0]?.slug).toBe("mail");
    expect(mail.length).toBeLessThanOrEqual(3);
    expect(mail[0]?.text).toContain("# Mail");
    expect(guideFor("imap account", "security")[0]?.slug).toBe("security");
    // Nothing stands out: all of it (it is small).
    expect(guideFor("zzqxv").map((p) => p.slug)).toEqual(GUIDE.map((p) => p.slug));
  });
});
