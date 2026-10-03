import { choiceQuestion, type EyeMessage, type EyeReport } from "@oraknid/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EyeReportView } from "./eye-report";
import { choiceOf, OptionChoices } from "./option-choices";

// ADR-045: The Eye's own messages, and every answer saying what it does.

afterEach(cleanup);

const message = (text: string, report: EyeReport): EyeMessage => ({
  id: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
  jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D5",
  projectId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D6",
  author: "eye",
  text,
  action: { intent: "report", did: [], silkIds: [], taskIds: [], jobId: null, report },
  questions: null,
  itemId: null,
  answers: null,
  replyTo: null,
  createdAt: Date.now(),
});

const show = (text: string, report: EyeReport) =>
  render(<EyeReportView message={message(text, report)} report={report} resultHref="/jobs/x" />);

describe("The Eye's reports in the conversation (ADR-045)", () => {
  it("shows a task done as one compact line", () => {
    show("Done: **Write hello.sh** — changed `hello.sh`; its checks pass.", {
      kind: "task-done",
      taskId: null,
      facts: [{ label: "Commit", value: "abc1234", href: null }],
      todo: [],
    });
    const line = screen.getByTestId("report-task-done");
    expect(line.textContent).toContain("Done: Write hello.sh");
    expect(line.querySelector("strong")?.textContent).toBe("Write hello.sh");
    expect(line.textContent).toContain("abc1234");
  });

  it("shows the job done as a card: where its work is, links, what's left to me, the result", () => {
    show("The job is done: 2 tasks done.", {
      kind: "job-done",
      taskId: null,
      facts: [
        { label: "Branch", value: "oraknid/hello-abc123 · 2 commits", href: null },
        { label: "Merged into", value: "dev", href: null },
        {
          label: "Pushed",
          value: "dev → me/piano",
          href: "https://github.com/me/piano/tree/dev",
        },
      ],
      todo: ["No job-level check ran: try the result by hand."],
    });
    const card = screen.getByTestId("report-job-done");
    expect(card.textContent).toContain("Job done");
    expect(card.textContent).toContain("Merged intodev");
    const pushed = screen.getByRole("link", { name: /dev → me\/piano/ });
    expect(pushed.getAttribute("href")).toBe("https://github.com/me/piano/tree/dev");
    expect(pushed.getAttribute("target")).toBe("_blank");
    expect(card.textContent).toContain("Left to you");
    expect(card.textContent).toContain("try the result by hand");
    expect(screen.getByRole("link", { name: "Open the result" }).getAttribute("href")).toBe(
      "/jobs/x",
    );
  });

  it("marks anything else by its kind", () => {
    show("The job is blocked: no Leg can take it.", {
      kind: "blocked",
      taskId: null,
      facts: [],
      todo: ["Add a Leg"],
    });
    expect(screen.getByTestId("report-blocked").textContent).toContain("Blocked");
  });
});

describe("an approval's answers with what each leads to (ADR-045)", () => {
  const options = ["Approve", "Deny"];
  const q = choiceQuestion("Approve the plan?", [
    { label: "Approve", detail: "Work starts on these tasks." },
    { label: "Deny", detail: "Nothing runs and the job stops." },
  ]);

  it("knows the question that only explains the item's own options", () => {
    expect(choiceOf([q], options)).toBe(q);
    expect(choiceOf([q], ["Send"])).toBeNull();
    expect(choiceOf(null, options)).toBeNull();
  });

  it("shows each option's detail under it, and answers with the option in one press", () => {
    const onAnswer = vi.fn();
    render(<OptionChoices options={options} question={q} busy={false} onAnswer={onAnswer} />);
    expect(screen.getByText("Nothing runs and the job stops.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledWith("Deny");
  });
});
