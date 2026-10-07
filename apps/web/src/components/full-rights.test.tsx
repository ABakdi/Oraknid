import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FullRightsBadge } from "./full-rights";

// Full rights are shown on the device itself (ADR-030).

afterEach(cleanup);

const show = (status: { full: boolean; remote: boolean } | null) =>
  render(
    <TooltipProvider>
      <FullRightsBadge status={status} />
    </TooltipProvider>,
  );

describe("the full rights badge", () => {
  it("shows on a device with full rights, saying when it is away", () => {
    show({ full: true, remote: false });
    expect(screen.getByTestId("full-rights").textContent).toContain("Full rights");
    cleanup();
    show({ full: true, remote: true });
    expect(screen.getByTestId("full-rights").textContent).toContain("Full rights, away");
  });

  it("shows nothing on a standard device, or before the status is known", () => {
    show({ full: false, remote: true });
    expect(screen.queryByTestId("full-rights")).toBeNull();
    cleanup();
    show(null);
    expect(screen.queryByTestId("full-rights")).toBeNull();
  });
});
