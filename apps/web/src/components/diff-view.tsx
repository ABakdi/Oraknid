import type { GitHubFileChange } from "@oraknid/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A unified diff's lines, each with its old and new line numbers. */
export interface DiffLine {
  kind: "hunk" | "add" | "del" | "same" | "note";
  text: string;
  old: number | null;
  new: number | null;
}

/** Reads a file's patch (`@@ -a,b +c,d @@` hunks) into numbered lines. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (line.startsWith("+")) out.push({ kind: "add", text: line, old: null, new: n++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line, old: o++, new: null });
    else if (line.startsWith("\\")) out.push({ kind: "note", text: line, old: null, new: null });
    else out.push({ kind: "same", text: line, old: o++, new: n++ });
  }
  return out;
}

const STATUS: Record<string, string> = {
  added: "bg-success/15 text-success",
  removed: "bg-destructive/15 text-destructive",
  modified: "bg-primary/15 text-primary",
  renamed: "bg-chart-3/15 text-chart-3",
};

/**
 * One file of a commit or a pull request (Web-UI → Repos): its name, what
 * happened to it and its counts, then its diff in a block of its own that
 * scrolls inside itself, added lines green with a +, removed red with a −.
 */
export function FileDiff({
  file,
  open: initial = true,
}: {
  file: GitHubFileChange;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" data-testid="file-diff">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/60"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronRight className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </span>
        <Badge
          variant="outline"
          className={cn("border-transparent capitalize", STATUS[file.status] ?? "bg-muted")}
        >
          {t(file.status)}
        </Badge>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>
      {open ? (
        file.patch ? (
          <div className="max-h-[60vh] overflow-auto border-t bg-field font-mono text-[12px] leading-5">
            <table className="w-max min-w-full border-collapse">
              <tbody>
                {parsePatch(file.patch).map((l, i) => (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines never move
                    key={i}
                    data-kind={l.kind}
                    className={cn(
                      l.kind === "add" && "bg-success/12",
                      l.kind === "del" && "bg-destructive/12",
                      l.kind === "hunk" && "bg-primary/8 text-primary",
                      l.kind === "note" && "text-muted-foreground",
                    )}
                  >
                    <td className="w-10 px-2 text-right text-muted-foreground select-none">
                      {l.old ?? ""}
                    </td>
                    <td className="w-10 px-2 text-right text-muted-foreground select-none">
                      {l.new ?? ""}
                    </td>
                    <td
                      className={cn(
                        "w-4 select-none pl-1",
                        l.kind === "add" && "text-success",
                        l.kind === "del" && "text-destructive",
                      )}
                      aria-hidden
                    >
                      {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                    </td>
                    <td className="pr-4 whitespace-pre">
                      {l.kind === "add" || l.kind === "del" || l.kind === "same"
                        ? l.text.slice(1) || " "
                        : l.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {t("No diff to show: a binary file, or too large for GitHub to show here.")}
          </div>
        )
      ) : null}
    </section>
  );
}

/** Every file of a change, the counts above them. */
export function DiffList({ files, truncated }: { files: GitHubFileChange[]; truncated?: boolean }) {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  // Many files: each opened on demand, so the page stays quick.
  const many = files.length > 25;
  return (
    <div className="min-w-0 space-y-2">
      <div className="text-xs text-muted-foreground">
        {t("{n} file(s) changed", { n: files.length })} ·{" "}
        <span className="text-success">+{add}</span>{" "}
        <span className="text-destructive">−{del}</span>
        {truncated ? ` · ${t("more on GitHub")}` : ""}
      </div>
      {files.map((f) => (
        <FileDiff key={f.path} file={f} open={!many} />
      ))}
    </div>
  );
}
