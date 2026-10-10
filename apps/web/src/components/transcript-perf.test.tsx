import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./common";

// Web-UI → Performance: a conversation drawn again (a reload, a job's change) must not
// parse every message's Markdown again. 2026-10-08: the Eye tab spent 4 s a minute doing so.

afterEach(cleanup);

const reply = (i: number) =>
  `**Done ${i}.** The build passed and the next step reads the router.\n\n- one\n- two\n\n\`\`\`ts\nconst x = ${i};\n\`\`\``;

function Transcript({ texts }: { texts: string[] }) {
  return (
    <div>
      {texts.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list in a test
        <Markdown key={i} text={text} />
      ))}
    </div>
  );
}

describe("a transcript of 2,000 messages", () => {
  it("draws again in a fraction of its first drawing when its texts are the same", () => {
    const texts = Array.from({ length: 2000 }, (_, i) => reply(i));
    const t0 = performance.now();
    const view = render(<Transcript texts={texts} />);
    const first = performance.now() - t0;
    // A reload brings new message objects with the same texts.
    const again = texts.map((t) => `${t}`);
    const t1 = performance.now();
    view.rerender(<Transcript texts={again} />);
    const second = performance.now() - t1;
    expect(view.container.querySelectorAll("strong")).toHaveLength(2000);
    // A redraw with nothing changed costs far less than the first drawing; under load both
    // slow down, so the bound is generous (re-parsing 2,000 messages took seconds before).
    expect(second).toBeLessThan(Math.max(1000, first / 2));
  });

  it("draws a 3 MB text as its start, not all of it", () => {
    const view = render(<Markdown text={`start ${"x ".repeat(1_600_000)}`} />);
    expect(view.container.textContent?.length).toBeLessThan(70_000);
    expect(view.container.textContent).toContain("more characters");
  });
});
