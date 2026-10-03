import {
  answerWords,
  completeAnswers,
  isAnswered,
  type Question,
  type QuestionAnswer,
} from "@oraknid/contracts";
import { Check, ChevronLeft, ChevronRight, Star } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Draft = Record<string, { options: string[]; text: string }>;

/** What a question starts with: its recommended option, selected (ADR-037). */
function initial(questions: Question[]): Draft {
  return Object.fromEntries(
    questions.map((q) => [q.id, { options: q.recommended ? [q.recommended] : [], text: "" }]),
  );
}

const short = (q: Question) => {
  const line = q.prompt.split("\n")[0] ?? q.prompt;
  return line.length > 28 ? `${line.slice(0, 26)}…` : line;
};

/**
 * Questions asked with options, answered one at a time (ADR-037): the
 * interview, in New work and the inbox, and The Eye's questions in its
 * conversation. Each question is a tab, a summary tab last. Keys: ↑/↓
 * between options, Space selects (toggles in a multi), Enter confirms and
 * goes on (Shift+Enter is a new line in a written answer), ←/→ or Tab
 * between questions, 1–9 pick an option. Rows are big enough for a thumb.
 */
export function QuestionsForm({
  questions,
  onSubmit,
  busy = false,
  disabled = false,
  extra,
  autoFocus = false,
}: {
  questions: Question[];
  onSubmit: (answers: QuestionAnswer[]) => void | Promise<void>;
  busy?: boolean;
  disabled?: boolean;
  /** More ways to answer, beside Submit (e.g. "Enough, start" in an interview). */
  extra?: ReactNode;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => initial(questions));
  const [current, setCurrent] = useState(0);
  // The row a Tab lands on: the recommended option, selected already.
  const [cursor, setCursor] = useState(() =>
    Math.max(0, questions[0]?.options.findIndex((o) => o.id === questions[0]?.recommended) ?? 0),
  );
  const rows = useRef<(HTMLElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const summary = questions.length;
  const q = questions[current];
  const otherRow = q && q.shape !== "text" && q.allowOther ? q.options.length : -1;
  const rowCount = q ? (q.shape === "text" ? 1 : q.options.length + (otherRow >= 0 ? 1 : 0)) : 0;

  // Focus follows the question shown; on first showing only when asked to (never stolen from what I type).
  const shown = useRef<number | null>(autoFocus ? null : current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus follows the question shown
  useLayoutEffect(() => {
    if (shown.current === current) return;
    shown.current = current;
    if (current < summary) focusRow(startRow(current));
    else box.current?.focus();
  }, [current]);

  /** On a question: the selected option (or the first); on a written answer, its box. */
  function startRow(i: number) {
    const x = questions[i];
    if (!x || x.shape === "text") return 0;
    const chosen = x.options.findIndex((o) => draft[x.id]?.options.includes(o.id));
    if (chosen >= 0) return chosen;
    if (x.allowOther && draft[x.id]?.text) return x.options.length;
    return 0;
  }

  function focusRow(i: number) {
    setCursor(i);
    rows.current[i]?.focus();
  }

  const go = (to: number) => {
    const next = Math.max(0, Math.min(summary, to));
    // The form keeps the keys while the next question is drawn; then its row takes the focus.
    box.current?.focus();
    setCurrent(next);
  };

  const choose = (x: Question, optionId: string) =>
    setDraft((d) => {
      const was = d[x.id] ?? { options: [], text: "" };
      if (x.shape === "multi") {
        const on = was.options.includes(optionId);
        return {
          ...d,
          [x.id]: {
            ...was,
            options: on ? was.options.filter((o) => o !== optionId) : [...was.options, optionId],
          },
        };
      }
      // One option: choosing it clears what was typed as "Other".
      return { ...d, [x.id]: { options: [optionId], text: "" } };
    });

  const type = (x: Question, text: string) =>
    setDraft((d) => {
      const was = d[x.id] ?? { options: [], text: "" };
      // Typing "Other" in a single choice is the answer instead of an option.
      const options = x.shape === "single" || x.shape === "confirm" ? [] : was.options;
      return { ...d, [x.id]: { options: text ? options : was.options, text } };
    });

  const submit = () => {
    if (busy || disabled) return;
    const given = questions.map((x) => ({
      questionId: x.id,
      options: draft[x.id]?.options ?? [],
      text: draft[x.id]?.text ?? "",
    }));
    void onSubmit(completeAnswers(questions, given));
  };

  const confirm = () => (current >= summary ? submit() : go(current + 1));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    const inText = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    const onRow = ["radio", "checkbox"].includes(el.getAttribute("role") ?? "");
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Tab") {
      // Between questions; past the summary (or before the first) the page's own order.
      const to = current + (e.shiftKey ? -1 : 1);
      if (to < 0 || to > summary) return;
      handled();
      go(to);
      return;
    }
    if (e.key === "Enter") {
      if (inText && e.shiftKey && el.tagName === "TEXTAREA") return;
      // Enter on a tab or a button of the page's own is theirs.
      if (!inText && !onRow && el !== box.current) return;
      handled();
      // On a single choice, Enter takes the option it is on.
      if (q && onRow && cursor < q.options.length && q.shape !== "multi") {
        const id = q.options[cursor]?.id;
        if (id && !draft[q.id]?.options.includes(id)) choose(q, id);
      }
      confirm();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (inText) return;
      handled();
      go(current + (e.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    if (!q) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (el.tagName === "TEXTAREA") return;
      handled();
      const n = Math.max(1, rowCount);
      focusRow((cursor + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return;
    }
    if (inText) return;
    if (e.key === " ") {
      if (!onRow && el !== box.current) return;
      handled();
      const id = q.options[cursor]?.id;
      if (id) choose(q, id);
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9 && q.options[n - 1]) {
      handled();
      choose(q, (q.options[n - 1] as { id: string }).id);
      focusRow(n - 1);
    }
  };

  const answered = (x: Question) =>
    isAnswered({
      questionId: x.id,
      options: draft[x.id]?.options ?? [],
      text: draft[x.id]?.text ?? "",
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys of the whole form (ADR-037)
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={onKey}
      className="min-w-0 space-y-2 rounded-md border bg-card p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="questions"
    >
      <div role="tablist" className="flex min-w-0 gap-1 overflow-x-auto pb-1">
        {questions.map((x, i) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={current === i}
            className={cn(
              "flex min-h-8 shrink-0 items-center gap-1 rounded-sm border px-2 text-xs pointer-coarse:min-h-11",
              current === i
                ? "border-primary bg-primary/10 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent",
            )}
            title={x.prompt}
            onClick={() => go(i)}
          >
            {answered(x) ? <Check className="size-3 text-primary" /> : null}
            <span className="font-mono">{i + 1}</span>
            <span className="max-w-[10rem] truncate">{short(x)}</span>
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={current === summary}
          className={cn(
            "flex min-h-8 shrink-0 items-center rounded-sm border px-2 text-xs pointer-coarse:min-h-11",
            current === summary
              ? "border-primary bg-primary/10 text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent",
          )}
          onClick={() => go(summary)}
        >
          {t("Summary")}
        </button>
      </div>

      {q ? (
        <div className="space-y-2" role="tabpanel">
          <div className="text-sm font-medium [overflow-wrap:anywhere]">{q.prompt}</div>
          {q.shape === "text" ? (
            <textarea
              ref={(el) => {
                rows.current = [el];
              }}
              rows={3}
              disabled={disabled}
              aria-label={q.prompt}
              className="w-full min-w-0 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={t("Your answer (Enter goes on, Shift+Enter for a new line)")}
              value={draft[q.id]?.text ?? ""}
              onChange={(e) => type(q, e.target.value)}
            />
          ) : (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a radiogroup or a group, both named
            <div
              role={q.shape === "multi" ? "group" : "radiogroup"}
              aria-label={q.prompt}
              className="space-y-1"
            >
              {q.options.map((o, i) => {
                const on = draft[q.id]?.options.includes(o.id) ?? false;
                return (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a radio or a checkbox, both checkable
                  <button
                    key={o.id}
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    type="button"
                    role={q.shape === "multi" ? "checkbox" : "radio"}
                    aria-checked={on}
                    disabled={disabled}
                    tabIndex={cursor === i ? 0 : -1}
                    onFocus={() => setCursor(i)}
                    onClick={() => {
                      setCursor(i);
                      choose(q, o.id);
                    }}
                    className={cn(
                      "flex min-h-11 w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                    )}
                  >
                    <span className="mt-0.5 w-4 shrink-0 font-mono text-xs text-muted-foreground">
                      {i < 9 ? i + 1 : ""}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                        q.shape === "multi" ? "rounded-sm" : "rounded-full",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {on ? <Check className="size-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="[overflow-wrap:anywhere]">{o.label}</span>
                        {q.recommended === o.id ? (
                          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-eye">
                            <Star className="size-3" />
                            {t("Recommended")}
                          </span>
                        ) : null}
                      </span>
                      {o.detail ? (
                        <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {o.detail}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {otherRow >= 0 ? (
                <label
                  className={cn(
                    "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                    draft[q.id]?.text ? "border-primary bg-primary/10" : "border-border",
                  )}
                >
                  <span className="w-4 shrink-0" />
                  <span className="shrink-0 text-muted-foreground">{t("Other")}</span>
                  <input
                    ref={(el) => {
                      rows.current[otherRow] = el;
                    }}
                    disabled={disabled}
                    tabIndex={cursor === otherRow ? 0 : -1}
                    onFocus={() => setCursor(otherRow)}
                    className="min-h-9 min-w-0 flex-1 rounded-sm border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder={t("Type another answer")}
                    aria-label={t("Other answer")}
                    value={draft[q.id]?.text ?? ""}
                    onChange={(e) => type(q, e.target.value)}
                  />
                </label>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-1.5" role="tabpanel">
          <ul className="space-y-1 text-sm">
            {completeAnswers(
              questions,
              questions.map((x) => ({
                questionId: x.id,
                options: draft[x.id]?.options ?? [],
                text: draft[x.id]?.text ?? "",
              })),
            ).map((a, i) => {
              const x = questions[i] as Question;
              return (
                <li key={x.id} className="min-w-0 [overflow-wrap:anywhere]">
                  <button type="button" className="text-left hover:underline" onClick={() => go(i)}>
                    <span className="text-muted-foreground">{x.prompt.split("\n")[0]}</span>
                    {" — "}
                    <span className={cn(!isAnswered(a) && "text-muted-foreground italic")}>
                      {answerWords(x, a)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <span className="mr-auto hidden text-[11px] text-muted-foreground sm:inline">
          {t("↑↓ choose · Space select · Enter next · ←→ questions")}
        </span>
        {extra}
        {current > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => go(current - 1)}
            aria-label={t("Previous question")}
          >
            <ChevronLeft />
          </Button>
        ) : null}
        {current < summary ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => go(current + 1)}>
            {t("Next")}
            <ChevronRight />
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={busy || disabled} onClick={submit}>
          {t("Submit")}
        </Button>
      </div>
    </div>
  );
}
