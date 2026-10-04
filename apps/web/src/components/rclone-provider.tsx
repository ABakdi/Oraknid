import type {
  CloudAddStep,
  CloudAuthorization,
  RcloneBackend,
  RcloneBackendSummary,
  RcloneOption,
  RcloneQuestion,
} from "@oraknid/contracts";
import { type FormOption, formModel, inputOf, searchBackends } from "@oraknid/core/rclone";
import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { remote } from "@/lib/remote";

// Any provider rclone supports (ADR-046 → Changed 2026-10-04; Web-UI →
// Cloud storage): rclone's backends searched by name, and the form made of
// one's own description: its service first, the required options, the
// everyday ones, the rest under Advanced; secrets as password fields. Then
// rclone's questions, if its setup has any.

const GiB = 1 << 30;

// ── The picker

export function RclonePicker({ onPick }: { onPick: (b: RcloneBackendSummary) => void }) {
  const [list, setList] = useState<RcloneBackendSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    api.cloud
      .backends()
      .then((r) => setList(r.backends))
      .catch((e) => setError(message(e)));
  }, []);
  const found = useMemo(() => (list ? searchBackends(list, q) : []), [list, q]);
  if (error) return <ErrorNote error={error} />;
  if (!list) return <Loading rows={2} />;
  return (
    <div className="space-y-2" data-help="storage.backend-search">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label={t("Search rclone's providers")}
          placeholder={t("Search {n} providers: OneDrive, SFTP, pCloud, B2…", { n: list.length })}
          className="pl-8"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={t("rclone's providers")}>
        {found.map((b) => (
          <li key={b.name}>
            <button
              type="button"
              onClick={() => onPick(b)}
              className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className="font-medium">{b.title}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{b.name}</span>
              {b.oauth ? (
                <Badge variant="outline" className="text-[10px]">
                  {t("browser sign-in")}
                </Badge>
              ) : null}
              {b.bucket ? (
                <Badge variant="outline" className="text-[10px]">
                  {t("buckets")}
                </Badge>
              ) : null}
            </button>
          </li>
        ))}
        {found.length === 0 ? (
          <li className="px-2 py-1 text-sm text-muted-foreground">
            {t("No provider of rclone's is called that.")}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// ── One option, as a field

/** rclone's help: its first line is the label, the rest the hint. */
function words(o: RcloneOption) {
  const [first = o.name, ...rest] = o.help.split("\n");
  const hint = rest.join(" ").replace(/\s+/g, " ").trim();
  return { label: first.trim(), hint: hint.length > 260 ? `${hint.slice(0, 257)}…` : hint };
}

const NONE = "__default__";

export function OptionField({
  o,
  value,
  onChange,
  idPrefix = "rc",
}: {
  o: RcloneOption & { input?: FormOption["input"] };
  value: string;
  onChange: (v: string) => void;
  idPrefix?: string;
}) {
  const id = `${idPrefix}-${o.name}`;
  const input = o.input ?? inputOf(o);
  const { label, hint } = words(o);
  const dflt = o.default ? t("default: {v}", { v: o.default }) : "";
  let node: ReactNode;
  if (input === "bool") {
    const on = (value || o.default) === "true";
    node = (
      <div className="flex items-center gap-2">
        <Switch id={id} checked={on} onCheckedChange={(c) => onChange(c ? "true" : "false")} />
        <span className="text-xs text-muted-foreground">{on ? t("Yes") : t("No")}</span>
      </div>
    );
  } else if (input === "tristate" || (input === "choice" && o.examples.length)) {
    const choices =
      input === "tristate"
        ? [
            { value: "true", help: t("Yes") },
            { value: "false", help: t("No") },
          ]
        : o.examples;
    node = (
      <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {o.required && !o.default ? (
            <SelectItem value={NONE} disabled>
              {t("Pick one")}
            </SelectItem>
          ) : (
            <SelectItem value={NONE}>
              {o.default ? t("Default ({v})", { v: o.default }) : t("Default")}
            </SelectItem>
          )}
          {choices
            .filter((e) => e.value !== "")
            .map((e) => (
              <SelectItem key={e.value} value={e.value}>
                {e.help
                  ? `${e.help.split("\n")[0]}${e.help === e.value ? "" : ` (${e.value})`}`
                  : e.value}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    );
  } else if (input === "multiline") {
    node = (
      <Textarea
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    const listId = o.examples.length ? `${id}-choices` : undefined;
    node = (
      <>
        <Input
          id={id}
          type={input === "password" ? "password" : "text"}
          autoComplete={input === "password" ? "new-password" : "off"}
          inputMode={input === "int" || input === "float" ? "decimal" : undefined}
          placeholder={
            o.default || (input === "size" ? "64M" : input === "duration" ? "1m30s" : "")
          }
          value={value}
          list={listId}
          onChange={(e) => onChange(e.target.value)}
        />
        {listId ? (
          <datalist id={listId}>
            {o.examples.map((e) => (
              <option key={e.value} value={e.value}>
                {e.help.split("\n")[0]}
              </option>
            ))}
          </datalist>
        ) : null}
      </>
    );
  }
  return (
    <div className="space-y-1" data-option={o.name}>
      <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-1.5">
        <span>
          {label}
          {o.required ? <span className="text-destructive"> *</span> : null}
        </span>
        <span className="font-mono text-[10px] font-normal text-muted-foreground">{o.name}</span>
      </Label>
      {node}
      {hint || (dflt && input !== "bool") ? (
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {[hint, input !== "bool" && input !== "choice" ? dflt : ""].filter(Boolean).join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

// ── The form for one backend

export function RcloneProviderForm({
  name: picked,
  onBack,
  onDone,
  spaceFields,
}: {
  name: string;
  onBack: () => void;
  onDone: () => void;
  /** The space limit's fields (shared with the short forms). */
  spaceFields: (s: {
    limit: string;
    setLimit: (v: string) => void;
    unlimited: boolean;
    setUnlimited: (v: boolean) => void;
  }) => ReactNode;
}) {
  const [backend, setBackend] = useState<RcloneBackend | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [limit, setLimit] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [auth, setAuth] = useState<CloudAuthorization | null>(null);
  const [question, setQuestion] = useState<RcloneQuestion | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const away = !!remote();

  useEffect(() => {
    api.cloud
      .backend({ name: picked })
      .then(setBackend)
      .catch((e) => setLoadError(message(e)));
  }, [picked]);

  // A sign-in in progress: asked until it is ready or failed; closing stops it.
  useEffect(() => {
    if (auth?.state !== "waiting") return;
    const timer = setInterval(() => {
      api.cloud
        .authorizeStatus({ session: auth.session })
        .then(setAuth)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [auth]);
  const live = useRef({ auth, question });
  live.current = { auth, question };
  useEffect(
    () => () => {
      const { auth: a, question: q } = live.current;
      if (a?.state === "waiting")
        void api.cloud.authorizeCancel({ session: a.session }).catch(() => {});
      if (q) void api.cloud.cancelRclone({ pending: q.pending }).catch(() => {});
    },
    [],
  );

  const model = useMemo(() => (backend ? formModel(backend, values) : null), [backend, values]);
  if (loadError) return <ErrorNote error={loadError} />;
  if (!backend || !model) return <Loading rows={3} />;
  /** Its name until I give one: the service picked ("Hetzner Object Storage"), else the backend's. */
  const service = model.provider?.examples.find((e) => e.value === values.provider);
  const title = (service?.help.split("\n")[0] ?? "").slice(0, 60) || backend.title;

  const set = (k: string) => (v: string) =>
    setValues((cur) => {
      const next = { ...cur, [k]: v };
      if (!v) delete next[k];
      return next;
    });
  const field = (o: FormOption) => (
    <OptionField key={o.name} o={o} value={values[o.name] ?? ""} onChange={set(o.name)} />
  );

  const step = (s: CloudAddStep) => {
    if (s.provider) {
      toast.success(t("Added: it's in the pool."));
      onDone();
      return;
    }
    setQuestion(s.question);
    setAnswer(s.question?.option.default ?? "");
  };

  const submit = async () => {
    setError(null);
    if (backend.oauth && auth?.state !== "ready") return setError(t("Sign in first."));
    setBusy(true);
    try {
      step(
        await api.cloud.addRclone({
          name: name.trim() || title,
          backend: backend.name,
          options: values,
          authSession: backend.oauth ? (auth?.session ?? null) : null,
          folder: folder.trim(),
          limitBytes: !unlimited && limit ? Math.round(Number(limit) * GiB) : null,
          unlimited,
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const reply = async () => {
    if (!question) return;
    setError(null);
    setBusy(true);
    try {
      step(await api.cloud.answerRclone({ pending: question.pending, answer }));
    } catch (e) {
      setError(message(e));
      // A setup that ended is gone: back to the form.
      if (/isn't waiting|didn't answer/.test(message(e))) setQuestion(null);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setError(null);
    try {
      setAuth(await api.cloud.authorizeStart({ kind: backend.name, options: values }));
    } catch (e) {
      setError(message(e));
    }
  };

  if (question)
    return (
      <form
        className="space-y-3"
        data-help="storage.rclone-question"
        onSubmit={(e) => {
          e.preventDefault();
          void reply();
        }}
      >
        <div className="text-sm text-muted-foreground">
          {t("rclone asks, to finish setting up {name}:", { name: backend.title })}
        </div>
        <ErrorNote error={question.error} />
        <OptionField o={question.option} value={answer} onChange={setAnswer} idPrefix="rq" />
        <ErrorNote error={error} />
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void api.cloud.cancelRclone({ pending: question.pending }).catch(() => {});
              setQuestion(null);
            }}
          >
            {t("Cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("Checking…") : t("Continue")}
          </Button>
        </DialogFooter>
      </form>
    );

  return (
    <form
      className="space-y-3"
      data-help="storage.rclone-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-sm">
        <span className="font-medium">{backend.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{backend.name}</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" onClick={onBack}>
          {t("Another provider")}
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rc-provider-name">{t("Name")}</Label>
        <Input
          id="rc-provider-name"
          value={name}
          placeholder={title}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {model.provider ? field(model.provider) : null}
      {model.provider && !values.provider ? (
        <div className="text-xs text-muted-foreground">
          {t("Pick the service: its own options follow.")}
        </div>
      ) : (
        <>
          {model.required.map(field)}
          {model.basic.map(field)}
          {backend.oauth ? (
            <div
              className="space-y-2 rounded-md bg-muted/40 p-3 text-sm"
              data-help="storage.sign-in"
            >
              {away ? (
                <div className="text-muted-foreground">
                  {t(
                    "Signing in to {kind} needs a browser on the computer running Oraknid: rclone waits for it there. Do it at home.",
                    { kind: backend.title },
                  )}
                </div>
              ) : !auth || auth.state === "failed" ? (
                <>
                  <div className="text-muted-foreground">
                    {t(
                      "Sign in with rclone's own authorization, in a browser on this computer. Nothing to register.",
                    )}
                  </div>
                  {auth?.error ? <ErrorNote error={auth.error} /> : null}
                  <Button type="button" size="sm" onClick={() => void signIn()}>
                    {t("Sign in to {kind}", { kind: backend.title })}
                  </Button>
                </>
              ) : auth.state === "waiting" ? (
                <>
                  <div>{t("Open the sign-in page, allow rclone, then come back here.")}</div>
                  {auth.url ? (
                    <a
                      href={auth.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline"
                    >
                      {t("Open the sign-in page")}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    {t("Waiting for the sign-in…")}
                  </div>
                </>
              ) : (
                <div className="text-success">{t("Signed in. Add it to finish.")}</div>
              )}
            </div>
          ) : null}
          {model.advanced.length ? (
            <div className="rounded-md border" data-help="storage.rclone-advanced">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-sm"
                aria-expanded={advanced}
                onClick={() => setAdvanced((a) => !a)}
              >
                {advanced ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                {t("Advanced ({n})", { n: model.advanced.length })}
              </button>
              {advanced ? (
                <div className="space-y-3 border-t px-2 py-2">{model.advanced.map(field)}</div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <div className="space-y-1">
        <Label htmlFor="rc-folder">
          {backend.bucket ? t("Bucket, and a folder in it") : t("Folder in the account")}
        </Label>
        <Input
          id="rc-folder"
          value={folder}
          placeholder={backend.bucket ? "bucket/folder" : t("none: all of it")}
          onChange={(e) => setFolder(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          {backend.bucket
            ? t("Made when it isn't there. What the pool shows of this provider.")
            : t("What the pool shows of this provider.")}
        </div>
      </div>
      {backend.bucket ? spaceFields({ limit, setLimit, unlimited, setUnlimited }) : null}
      <ErrorNote error={error} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t("Back")}
        </Button>
        <Button
          type="submit"
          disabled={
            busy ||
            (!!model.provider && !values.provider) ||
            (backend.oauth && auth?.state !== "ready")
          }
        >
          {busy ? t("Checking…") : t("Add")}
        </Button>
      </DialogFooter>
    </form>
  );
}
