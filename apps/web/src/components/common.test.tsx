import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { ErrorNote, Markdown, StateBadge } from "./common";

describe("Markdown", () => {
  it("renders headings, lists, code, bold and links, and nothing as raw HTML", () => {
    const { container } = render(
      <Markdown
        text={
          "## Title\n- one **two**\n1. `code`\n[site](https://oraknid.com)\n<img src=x onerror=alert(1)>\n```\nraw\n```"
        }
      />,
    );
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("two").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("site").getAttribute("href")).toBe("https://oraknid.com");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")?.textContent?.trim()).toBe("raw");
  });
});

describe("states and errors", () => {
  it("shows a running state with its pulse", () => {
    const { container } = render(<StateBadge state="running" />);
    expect(container.textContent).toBe("running");
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("shows an error as a sentence (BR-17)", () => {
    render(<ErrorNote error={{ message: "That code is wrong or has expired." }} />);
    expect(screen.getByRole("alert").textContent).toBe("That code is wrong or has expired.");
  });

  it("fills placeholders", () => {
    expect(t("{n} job(s) active", { n: 2 })).toBe("2 job(s) active");
  });
});
