import { describe, expect, it } from "vitest";
import { cleanMailHtml, frameCsp, textMail } from "./mail-html";

const EVIL = `
<p onclick="steal()">Hello <b>there</b></p>
<script>alert(1)</script>
<img src="https://tracker.example/pixel.gif" width="1">
<img src="data:image/png;base64,AAAA" alt="inline">
<a href="javascript:alert(1)">bad</a>
<a href="https://example.com/doc">good</a>
<iframe src="https://evil.example"></iframe>
<form action="https://evil.example"><input name="password"></form>
<div style="background:url(https://tracker.example/bg.png)">styled</div>
<svg><script>alert(2)</script></svg>
`;

const parse = (doc: string) => new DOMParser().parseFromString(doc, "text/html");

describe("mail HTML (ADR-032)", () => {
  it("keeps what reads and drops what runs", () => {
    const { doc } = cleanMailHtml(EVIL, { allowImages: false });
    const d = parse(doc);
    expect(d.body.textContent).toContain("Hello there");
    expect(d.querySelector("script")).toBeNull();
    expect(d.querySelector("iframe")).toBeNull();
    expect(d.querySelector("form")).toBeNull();
    expect(d.querySelector("input")).toBeNull();
    expect(d.querySelector("[onclick]")).toBeNull();
    expect(doc).not.toContain("javascript:");
    const good = [...d.querySelectorAll("a")].find((a) => a.textContent === "good");
    expect(good?.getAttribute("target")).toBe("_blank");
    expect(good?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("blocks remote images until they are allowed, and keeps inline ones", () => {
    const blocked = cleanMailHtml(EVIL, { allowImages: false });
    const d = parse(blocked.doc);
    expect(blocked.blocked).toBe(2);
    expect(d.querySelector("img[src^='https']")).toBeNull();
    expect(d.querySelector("img[data-blocked-src]")?.getAttribute("data-blocked-src")).toBe(
      "https://tracker.example/pixel.gif",
    );
    expect(d.querySelector("img[src^='data:']")).not.toBeNull();
    expect(blocked.doc).not.toContain("url(https://tracker.example/bg.png)");
    // The frame's own policy loads nothing from outside, and runs nothing.
    expect(d.querySelector("meta[http-equiv]")?.getAttribute("content")).toBe(frameCsp(false));
    expect(frameCsp(false)).toMatch(/default-src 'none'.*img-src data:;/);
    expect(frameCsp(false)).not.toContain("script-src");

    // Allowed: the daemon's inline copies take their place; nothing is fetched from the frame.
    const remote = [...EVIL.matchAll(/src="(https?:\/\/[^"]+)"/g)].map((m) => m[1] as string);
    const images = Object.fromEntries(remote.map((u) => [u, "data:image/png;base64,AAAA"]));
    const allowed = cleanMailHtml(EVIL, { allowImages: true, images });
    expect(allowed.blocked).toBe(0);
    expect(parse(allowed.doc).querySelector("img[src^='http']")).toBeNull();
    expect(parse(allowed.doc).querySelector("img[src^='data:']")).not.toBeNull();
    expect(frameCsp(true)).not.toContain("https:");
  });

  it("shows plain text as text, links included", () => {
    const html = textMail("<b>not bold</b> see https://example.com/x");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain('<a href="https://example.com/x"');
  });
});
