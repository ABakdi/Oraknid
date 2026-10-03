import type { MailAccountView, MailCompose, MailOutgoingAttachment } from "@oraknid/contracts";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, List, ListOrdered, Paperclip, Quote, Send, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Draft = MailCompose & { id?: string; title?: string };

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Plain text (a quoted reply) as editor HTML: paragraphs, and "> " lines as a quote. */
export function textToHtml(text: string): string {
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length) out.push(`<blockquote><p>${quote.map(esc).join("<br>")}</p></blockquote>`);
    quote = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) {
      quote.push(line.replace(/^> ?/, ""));
      continue;
    }
    flush();
    out.push(line ? `<p>${esc(line)}</p>` : "<p></p>");
  }
  flush();
  return out.join("");
}

const list = (s: string) =>
  s
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** Writing mail (ADR-032): to, copies, subject, rich text with Tiptap, attachments. */
export function Composer({
  draft,
  accounts,
  onClose,
}: {
  draft: Draft | null;
  accounts: MailAccountView[];
  onClose: () => void;
}) {
  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[95dvh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft?.title ?? t("New message")}</DialogTitle>
          <DialogDescription className="sr-only">{t("Write an email.")}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <Form key={draft.id ?? "new"} draft={draft} accounts={accounts} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  draft,
  accounts,
  onClose,
}: {
  draft: Draft;
  accounts: MailAccountView[];
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState(draft.accountId);
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [bcc, setBcc] = useState(draft.bcc.join(", "));
  const [copies, setCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState<(MailOutgoingAttachment & { size: number; key: string })[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [StarterKit],
    content: draft.html || textToHtml(draft.text),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "min-h-48 px-3 py-2 text-sm outline-none [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
        "aria-label": t("Message"),
      },
    },
  });

  const input = (): Draft => ({
    ...draft,
    accountId,
    to: list(to),
    cc: list(cc),
    bcc: list(bcc),
    subject,
    html: editor?.getHTML() ?? "",
    text: editor?.getText({ blockSeparator: "\n" }) ?? "",
    attachments: files.map(({ size: _s, key: _k, ...f }) => f),
  });

  const run = async (what: "send" | "save") => {
    const d = input();
    if (what === "send" && !d.to.length && !d.cc.length && !d.bcc.length) {
      toast.error(t("Add at least one recipient."));
      return;
    }
    setBusy(true);
    try {
      const { title: _t, ...body } = d;
      if (what === "send") {
        const r = await api.mail.send(body);
        if (r.state === "failed") throw new Error(r.error ?? t("It couldn't be sent."));
        toast.success(t("Sent."));
      } else {
        await api.mail.saveDraft(body);
        toast.success(t("Draft saved."));
      }
      onClose();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };

  const tool = (label: string, Icon: typeof Bold, active: boolean, fn: () => void) => (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn("size-8", active && "bg-accent")}
      aria-label={label}
      aria-pressed={active}
      onClick={fn}
    >
      <Icon className="size-4" />
    </Button>
  );

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        void run("send");
      }}
      onKeyDown={(e) => {
        // Ctrl/⌘+Enter sends.
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void run("send");
        }
      }}
    >
      {accounts.length > 1 ? (
        <div className="grid grid-cols-[4rem_1fr] items-center gap-2">
          <Label>{t("From")}</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name === a.email ? a.email : `${a.name} <${a.email}>`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="grid grid-cols-[4rem_1fr] items-center gap-2">
        <Label htmlFor="mail-to">{t("To")}</Label>
        <div className="flex gap-1">
          <Input
            id="mail-to"
            className="h-8"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoFocus={!to}
          />
          {copies ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setCopies(true)}>
              {t("Cc/Bcc")}
            </Button>
          )}
        </div>
      </div>
      {copies ? (
        <>
          <div className="grid grid-cols-[4rem_1fr] items-center gap-2">
            <Label htmlFor="mail-cc">{t("Cc")}</Label>
            <Input
              id="mail-cc"
              className="h-8"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[4rem_1fr] items-center gap-2">
            <Label htmlFor="mail-bcc">{t("Bcc")}</Label>
            <Input
              id="mail-bcc"
              className="h-8"
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
            />
          </div>
        </>
      ) : null}
      <div className="grid grid-cols-[4rem_1fr] items-center gap-2">
        <Label htmlFor="mail-subject">{t("Subject")}</Label>
        <Input
          id="mail-subject"
          className="h-8"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div className="rounded-md border">
        <div className="flex flex-wrap gap-0.5 border-b p-1">
          {tool(t("Bold"), Bold, !!editor?.isActive("bold"), () =>
            editor?.chain().focus().toggleBold().run(),
          )}
          {tool(t("Italic"), Italic, !!editor?.isActive("italic"), () =>
            editor?.chain().focus().toggleItalic().run(),
          )}
          {tool(t("Bulleted list"), List, !!editor?.isActive("bulletList"), () =>
            editor?.chain().focus().toggleBulletList().run(),
          )}
          {tool(t("Numbered list"), ListOrdered, !!editor?.isActive("orderedList"), () =>
            editor?.chain().focus().toggleOrderedList().run(),
          )}
          {tool(t("Quote"), Quote, !!editor?.isActive("blockquote"), () =>
            editor?.chain().focus().toggleBlockquote().run(),
          )}
          <span className="flex-1" />
          {tool(t("Attach files"), Paperclip, false, () => picker.current?.click())}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              const total = [...files, ...picked].reduce((n, f) => n + f.size, 0);
              if (total > 25 * 1024 * 1024) {
                toast.error(t("Attachments are limited to 25 MB in all."));
                return;
              }
              const added = await Promise.all(
                picked.map(async (f) => ({
                  filename: f.name,
                  contentType: f.type || "application/octet-stream",
                  base64: await toBase64(f),
                  size: f.size,
                  key: crypto.randomUUID(),
                })),
              );
              setFiles((xs) => [...xs, ...added]);
            }}
          />
        </div>
        <EditorContent editor={editor} />
      </div>
      {files.length ? (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {files.map((f, i) => (
            <li key={f.key} className="flex items-center gap-1 rounded-md border px-2 py-1">
              <Paperclip className="size-3" />
              {f.filename} · {bytes(f.size)}
              <button
                type="button"
                aria-label={t("Remove {name}", { name: f.filename })}
                onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
          {t("Ctrl+Enter sends")}
        </span>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void run("save")}>
          {t("Save draft")}
        </Button>
        <Button type="submit" disabled={busy} className="gap-1">
          <Send className="size-4" />
          {t("Send")}
        </Button>
      </div>
    </form>
  );
}
