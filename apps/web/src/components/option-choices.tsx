import { CHOICE, type Question } from "@oraknid/contracts";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * The question that only says what each of an item's own options does
 * (ADR-045), when it is that: its options are the item's options.
 */
export function choiceOf(
  questions: Question[] | null | undefined,
  options: string[],
): Question | null {
  const q = questions?.length === 1 ? questions[0] : null;
  return q?.id === CHOICE && q.options.every((o) => options.includes(o.label)) ? q : null;
}

/**
 * An approval's answers as buttons, each with the line saying what it
 * leads to under it (ADR-045): approving is one press, as before.
 */
export function OptionChoices({
  options,
  question,
  busy,
  onAnswer,
}: {
  options: string[];
  question: Question | null;
  busy: boolean;
  onAnswer: (option: string) => void;
}) {
  const detail = (o: string) => question?.options.find((x) => x.label === o)?.detail;
  return (
    <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
      {options.map((o) => (
        <div key={o} className="min-w-0">
          <Button
            className="w-full"
            disabled={busy}
            variant={o === "Approve" ? "default" : o === "Deny" ? "destructive" : "secondary"}
            onClick={() => onAnswer(o)}
          >
            <span className="truncate">{t(o)}</span>
          </Button>
          {detail(o) ? (
            <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {detail(o)}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
