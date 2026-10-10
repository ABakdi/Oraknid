import type {
  ReviewConsoleLine,
  ReviewDetail,
  ReviewDevice,
  ReviewElement,
  ReviewFailedRequest,
  ReviewNote,
  ReviewNoteKind,
  ReviewScreens,
} from "@oraknid/contracts";
import {
  Check,
  Crosshair,
  Image as ImageIcon,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { remote } from "@/lib/remote";
import {
  byDevice,
  customDevice,
  DEVICES,
  deviceLabel,
  firstDevice,
  fitScale,
  OVERLAY_NS,
  pinsFor,
  sameDevice,
  screenFor,
  turn,
} from "@/lib/review";
import { cn } from "@/lib/utils";

// The review page (ADR-064 §2–3, Web-UI → The review page): what is
// reviewed in a frame at a device's size, select-and-note, pins, my notes
// by device, Approve and Send notes. Its own full-screen layout, opened in
// a new tab; away from home the frame comes inlined through the API.

const KINDS: { kind: ReviewNoteKind; label: string; className: string }[] = [
  { kind: "keep", label: "Keep", className: "bg-emerald-600 text-white" },
  { kind: "change", label: "Change", className: "bg-blue-600 text-white" },
  { kind: "problem", label: "Problem", className: "bg-red-600 text-white" },
  { kind: "general", label: "General", className: "bg-zinc-500 text-white" },
];
const kindOf = (k: ReviewNoteKind) => KINDS.find((x) => x.kind === k) ?? KINDS[3];

/** What the overlay sent when I selected a part. */
interface Selection {
  element: ReviewElement | null;
  page: string | null;
  shot: string | null;
  console: ReviewConsoleLine[];
  requests: ReviewFailedRequest[];
}

type OverlayMessage =
  | { ns: string; op: "ready"; page: string; title: string; snapshot: boolean }
  | { ns: string; op: "page"; page: string }
  | {
      ns: string;
      op: "selected";
      element: ReviewElement;
      page: string;
      shot: string | null;
      console: ReviewConsoleLine[];
      requests: ReviewFailedRequest[];
    }
  | { ns: string; op: "pin"; id: string }
  | { ns: string; op: "problems"; console: number; requests: number }
  | { ns: string; op: "navigate"; href: string }
  | { ns: string; op: "escape" };

export function ReviewPage({ id }: { id: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const review = useLive(() => api.reviews.get({ id }), {
    topics: jobId ? ["inbox", `job:${jobId}`] : ["inbox"],
    refreshOn: (e) => e.type.startsWith("review.") || e.type.startsWith("inbox."),
    deps: [id],
  });
  const r = review.data;
  useEffect(() => {
    if (r?.jobId) setJobId(r.jobId);
  }, [r?.jobId]);
  useEffect(() => {
    if (r) document.title = `${t("Review")} · ${r.title} · ${r.projectName}`;
  }, [r]);
  if (review.error && !r)
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorNote error={review.error} />
      </div>
    );
  if (!r)
    return (
      <div className="mx-auto max-w-lg p-6">
        <Loading />
      </div>
    );
  return <Review review={r} reload={review.reload} />;
}

function Review({ review: r, reload }: { review: ReviewDetail; reload: () => void }) {
  const [, go] = useLocation();
  const { confirm, dialog } = useConfirm();
  const open = r.state === "open";
  const [device, setDevice] = useState<ReviewDevice>(() => firstDevice(window.innerWidth));
  const [fit, setFit] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [composer, setComposer] = useState<Selection | null>(null);
  const [problems, setProblems] = useState({ console: 0, requests: 0 });
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const phone = useNarrow();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const current = useMemo(() => r.notes.filter((n) => n.round === r.round), [r.notes, r.round]);

  const post = useCallback((m: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage({ ns: OVERLAY_NS, ...m }, "*");
  }, []);
  const pins = useMemo(
    () => pinsFor(r.notes, r.round, device, page, active),
    [r.notes, r.round, device, page, active],
  );
  // The overlay hears what to draw whenever it changes, and again once its page is ready.
  useEffect(() => post({ op: "pins", pins }), [post, pins]);
  useEffect(() => post({ op: "select", on: selecting && open }), [post, selecting, open]);

  // The screens (2026-10-10): a design made of a page per device shows the
  // one that fits the device, at every device change, unless I picked one
  // (until the device changes again). Without such pages (an index.html,
  // or the app) the frame stays on what it shows.
  const screens = useLive(() => api.reviews.screens({ id: r.id }), {
    topics: [],
    deps: [r.id, r.round],
  });
  const screensKnown = !!screens.data || !!screens.error;
  const [pick, setPick] = useState<string | null>(null);
  const auto = useMemo(() => screenFor(screens.data ?? null, device), [screens.data, device]);
  const want = pick ?? auto;
  const changeDevice = useCallback((d: ReviewDevice) => {
    setPick(null);
    setDevice(d);
  }, []);

  // Away from home: the page of the target, inlined, in a sandboxed frame.
  const away = !r.frameUrl;
  // A link followed in the frame away from home, until the screen changes.
  const [awayNav, setAwayNav] = useState<string | null>(null);
  const awayPath = awayNav ?? want ?? r.entry;
  const awayPage = useLive(
    () =>
      away && screensKnown
        ? api.reviews.frame({ id: r.id, path: awayPath })
        : Promise.resolve(null),
    { topics: [], deps: [r.id, awayPath, away, r.round, screensKnown] },
  );
  // At home: the frame on the screen's address; reloaded when the device
  // changes while it shows another page than the screen (a link followed).
  const [reloads, setReloads] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a device change counts even when the screen stays
  useEffect(() => {
    setAwayNav(null);
    const shown = pageRef.current;
    if (want && shown !== null && shown !== want) setReloads((n) => n + 1);
  }, [want, device]);
  // A screen picked (or Match device): shown, even when it is already the
  // frame's address and a link took the frame elsewhere.
  const pickScreen = (path: string | null) => {
    setPick(path);
    setAwayNav(null);
    const next = path ?? auto;
    if (next && next === want && pageRef.current !== null && pageRef.current !== next)
      setReloads((n) => n + 1);
  };
  const frameSrc = useMemo(() => {
    if (!r.frameUrl || !want) return r.frameUrl;
    try {
      return new URL(want, r.frameUrl).href;
    } catch {
      return r.frameUrl;
    }
  }, [r.frameUrl, want]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const m = e.data as OverlayMessage;
      if (!m || typeof m !== "object" || m.ns !== OVERLAY_NS) return;
      switch (m.op) {
        case "ready":
          setPage(m.page);
          post({ op: "pins", pins: pinsRef.current });
          post({ op: "select", on: selectingRef.current });
          break;
        case "page":
          setPage(m.page);
          break;
        case "selected":
          setComposer({
            element: m.element,
            page: m.page,
            shot: m.shot,
            console: r.kind === "app" ? m.console.slice(-20) : [],
            requests: r.kind === "app" ? m.requests.slice(-20) : [],
          });
          break;
        case "pin":
          setActive(m.id);
          if (phone) setSheet(true);
          document.getElementById(`note-${m.id}`)?.scrollIntoView({ block: "nearest" });
          break;
        case "problems":
          setProblems({ console: m.console, requests: m.requests });
          break;
        case "navigate":
          setAwayNav(m.href);
          break;
        case "escape":
          setSelecting(false);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, r.kind, phone]);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const selectingRef = useRef(selecting && open);
  selectingRef.current = selecting && open;

  const showNote = (n: ReviewNote) => {
    setActive(n.id);
    if (n.device && !sameDevice(n.device, device)) changeDevice(n.device);
    // A design's note shows the page it was written on.
    if (r.kind === "design" && n.page && n.page !== page) pickScreen(n.page);
    post({ op: "highlight", id: n.id });
    if (phone) setSheet(false);
  };

  const send = async () => {
    setBusy(true);
    try {
      const s = await api.reviews.sendNotes({ id: r.id });
      toast.success(t("{n} notes sent: The Eye turns them into work.", { n: s.notes }));
      reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    const withNotes = current.filter((n) => n.kind !== "keep").length;
    if (
      withNotes &&
      !(await confirm(
        t("Approve with notes?"),
        t(
          "{n} notes in this round would only be kept with the step. Send them instead to have them worked on.",
          { n: withNotes },
        ),
        t("Approve"),
      ))
    )
      return;
    setBusy(true);
    try {
      await api.reviews.approve({ id: r.id });
      toast.success(t("Approved: the work goes on."));
      reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    // Opened by Oraknid in its own tab: it closes; otherwise back to the project.
    if (!remote() && (window.opener || history.length <= 1)) window.close();
    go(`/projects/${r.projectId}`);
  };

  const notesPanel = (
    <NotesPanel
      review={r}
      active={active}
      onShow={showNote}
      onChanged={reload}
      editable={open}
      confirm={confirm}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {dialog}
      {/* The top bar: what this is, and the two ways it ends. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-2 py-1.5 sm:px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("Close the review")}
          title={t("Close the review")}
          onClick={close}
        >
          <X className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={`${r.projectName} · ${r.title}`}>
            <Link href={`/projects/${r.projectId}`} className="hover:underline">
              {r.projectName}
            </Link>
            <span className="text-muted-foreground"> · </span>
            {r.title}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("Round {n}", { n: r.round })}</span>
            <span>·</span>
            <span className="truncate">{r.jobTitle}</span>
            {r.state !== "open" ? (
              <Badge variant={r.state === "approved" ? "default" : "secondary"}>
                {r.state === "approved"
                  ? t("Approved")
                  : r.state === "notes-sent"
                    ? t("Notes sent")
                    : t("Withdrawn")}
              </Badge>
            ) : null}
          </div>
        </div>
        <Button
          data-help="review.send"
          size="sm"
          variant="outline"
          disabled={!open || busy || !current.length}
          onClick={send}
          title={t("End this round: The Eye turns your notes into work")}
        >
          <Send className="size-4" />
          <span>{t("Send notes ({n})", { n: current.length })}</span>
        </Button>
        <Button data-help="review.approve" size="sm" disabled={!open || busy} onClick={approve}>
          <Check className="size-4" />
          {t("Approve")}
        </Button>
      </header>

      {/* The devices, select mode and a general note. */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-muted/30 px-2 py-1.5 sm:px-3">
        <DeviceSwitcher device={device} onDevice={changeDevice} />
        {screens.data && screens.data.screens.length > 1 ? (
          <ScreenPicker screens={screens.data} pick={pick} auto={auto} onPick={pickScreen} />
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant={fit ? "secondary" : "ghost"}
          className="hidden sm:inline-flex"
          onClick={() => setFit(!fit)}
          title={t("Zoom to fit, or show at its real size")}
        >
          {fit ? t("Fit") : "100%"}
        </Button>
        <Button
          data-help="review.select"
          size="sm"
          variant={selecting ? "default" : "outline"}
          disabled={!open}
          aria-pressed={selecting}
          onClick={() => setSelecting(!selecting)}
          title={t("Select a part to note (Esc to stop)")}
        >
          <Crosshair className="size-4" />
          <span className="hidden min-[420px]:inline">{t("Select")}</span>
        </Button>
        <Button
          data-help="review.general-note"
          size="sm"
          variant="outline"
          disabled={!open}
          onClick={() =>
            setComposer({ element: null, page, shot: null, console: [], requests: [] })
          }
          title={t("A note on no part in particular")}
        >
          <MessageSquarePlus className="size-4" />
          <span className="hidden min-[420px]:inline">{t("General note")}</span>
        </Button>
        {phone ? (
          <Button size="sm" variant="outline" onClick={() => setSheet(true)}>
            <ListChecks className="size-4" />
            {current.length}
          </Button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <Stage device={device} fit={fit || phone}>
          {!screensKnown ? (
            <div className="p-4 text-sm text-muted-foreground">{t("Loading…")}</div>
          ) : away ? (
            awayPage.data ? (
              <iframe
                ref={frameRef}
                title={t("What is reviewed")}
                sandbox="allow-scripts"
                srcDoc={awayPage.data.html}
                className="size-full border-0 bg-white"
              />
            ) : awayPage.error ? (
              <div className="p-4">
                <ErrorNote error={awayPage.error} />
              </div>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">{t("Loading…")}</div>
            )
          ) : (
            <iframe
              ref={frameRef}
              // A new round shows its work fresh.
              key={`${r.round}:${reloads}`}
              title={t("What is reviewed")}
              src={frameSrc ?? undefined}
              // Its own origin; it may not move this page elsewhere.
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
              className="size-full border-0 bg-white"
            />
          )}
        </Stage>
        {phone ? null : (
          <aside
            aria-label={t("Notes")}
            className="flex w-80 shrink-0 flex-col border-l bg-card lg:w-96"
          >
            {notesPanel}
          </aside>
        )}
      </div>

      {/* What the app said wrong so far, and what didn't come through away from home. */}
      {(r.kind === "app" && (problems.console || problems.requests)) ||
      awayPage.data?.missing.length ? (
        <div className="shrink-0 border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          {r.kind === "app" && (problems.console || problems.requests)
            ? t(
                "The app so far: {c} console errors or warnings, {r} failed requests. They are attached to each note you write.",
                { c: problems.console, r: problems.requests },
              )
            : null}{" "}
          {awayPage.data?.missing.length
            ? t("Away from home, not shown: {m}", {
                m: awayPage.data.missing.slice(0, 3).join(", "),
              })
            : null}
        </div>
      ) : null}

      {phone ? (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="flex max-h-[75dvh] flex-col gap-0 p-0">
            <SheetHeader className="border-b px-4 py-2">
              <SheetTitle>{t("Notes")}</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">{notesPanel}</div>
          </SheetContent>
        </Sheet>
      ) : null}

      <Composer
        selection={composer}
        device={device}
        reviewId={r.id}
        onClose={(saved) => {
          setComposer(null);
          post({ op: "clear" });
          if (saved) reload();
        }}
      />
    </div>
  );
}

/** Narrow screens get the notes as a bottom sheet. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

function DeviceSwitcher({
  device,
  onDevice,
}: {
  device: ReviewDevice;
  onDevice: (d: ReviewDevice) => void;
}) {
  const [w, setW] = useState(String(device.width));
  const [h, setH] = useState(String(device.height));
  useEffect(() => {
    setW(String(device.width));
    setH(String(device.height));
  }, [device.width, device.height]);
  const value = DEVICES.findIndex((d) => sameDevice(d, device));
  const applyCustom = () => {
    const c = customDevice(Number(w), Number(h));
    if (c) onDevice(c);
    else toast.error(t("A size from 120 to 8000 pixels each way."));
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-help="review.devices">
      <label className="sr-only" htmlFor="review-device">
        {t("Device")}
      </label>
      <select
        id="review-device"
        className="h-8 w-36 rounded-md border bg-card px-2 text-[13px] sm:w-auto"
        value={value >= 0 ? String(value) : "custom"}
        onChange={(e) => {
          if (e.target.value === "custom") return;
          const d = DEVICES[Number(e.target.value)];
          if (d) onDevice(d);
        }}
      >
        {DEVICES.map((d, i) => (
          <option key={deviceLabel(d)} value={i}>
            {deviceLabel(d)}
          </option>
        ))}
        <option value="custom">{t("Custom size")}</option>
      </select>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t("Turn")}
        title={t("Turn: portrait or landscape")}
        onClick={() => {
          const turned = turn(device);
          onDevice(DEVICES.find((d) => sameDevice(d, turned)) ?? turned);
        }}
      >
        <RotateCw className="size-4" />
      </Button>
      <form
        className="hidden items-center gap-1 md:flex"
        onSubmit={(e) => {
          e.preventDefault();
          applyCustom();
        }}
      >
        <Input
          aria-label={t("Width")}
          inputMode="numeric"
          className="h-8 w-16 px-1.5 text-[13px]"
          value={w}
          onChange={(e) => setW(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">×</span>
        <Input
          aria-label={t("Height")}
          inputMode="numeric"
          className="h-8 w-16 px-1.5 text-[13px]"
          value={h}
          onChange={(e) => setH(e.target.value)}
        />
        <Button type="submit" size="sm" variant="ghost">
          {t("Set")}
        </Button>
      </form>
    </div>
  );
}

/**
 * The design's pages: Match device (the one that fits, shown by itself) or
 * one of my choosing, until the device changes.
 */
function ScreenPicker({
  screens,
  pick,
  auto,
  onPick,
}: {
  screens: ReviewScreens;
  pick: string | null;
  auto: string | null;
  onPick: (path: string | null) => void;
}) {
  const nameOf = (path: string | null) => {
    const s = screens.screens.find((x) => x.path === path);
    return s ? s.name.charAt(0).toUpperCase() + s.name.slice(1) : (path ?? "");
  };
  const listed = pick === null || screens.screens.some((x) => x.path === pick);
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-help="review.screens">
      <label className="hidden text-xs text-muted-foreground lg:inline" htmlFor="review-screen">
        {t("Screen")}
      </label>
      <select
        id="review-screen"
        aria-label={t("Screen")}
        className="h-8 w-36 rounded-md border bg-card px-2 text-[13px] sm:w-auto"
        value={pick ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
      >
        <option value="">
          {auto ? t("Match device ({name})", { name: nameOf(auto) }) : t("Match device")}
        </option>
        {screens.screens.map((s) => (
          <option key={s.path} value={s.path}>
            {nameOf(s.path)}
          </option>
        ))}
        {listed ? null : <option value={pick ?? ""}>{pick}</option>}
      </select>
    </div>
  );
}

/** The frame at the device's size, zoomed to fit the room there is. */
function Stage({
  device,
  fit,
  children,
}: {
  device: ReviewDevice;
  fit: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const o = new ResizeObserver(measure);
    o.observe(el);
    return () => o.disconnect();
  }, []);
  const scale = fit ? fitScale(device, room) : 1;
  return (
    <div
      ref={ref}
      data-testid="review-stage"
      className={cn(
        "relative min-w-0 flex-1 bg-muted/50",
        fit ? "overflow-hidden" : "overflow-auto",
      )}
    >
      <div
        style={{ width: device.width * scale, height: device.height * scale }}
        className={cn("relative", fit ? "mx-auto mt-3" : "m-3")}
      >
        <div
          data-testid="review-frame"
          data-scale={scale}
          style={{
            width: device.width,
            height: device.height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
          className="overflow-hidden rounded-md border bg-white shadow-lg"
        >
          {children}
        </div>
      </div>
      <div className="pointer-events-none absolute right-2 bottom-1 text-[11px] text-muted-foreground">
        {deviceLabel(device)} · {Math.round(scale * 100)}%
      </div>
    </div>
  );
}

function Composer({
  selection,
  device,
  reviewId,
  onClose,
}: {
  selection: Selection | null;
  device: ReviewDevice;
  reviewId: string;
  onClose: (saved: boolean) => void;
}) {
  const [kind, setKind] = useState<ReviewNoteKind>("change");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const general = !!selection && !selection.element;
  useEffect(() => {
    if (!selection) return;
    setKind(selection.element ? "change" : "general");
    setText("");
  }, [selection]);
  const save = async () => {
    if (!selection || !text.trim()) return;
    setBusy(true);
    try {
      await api.reviews.notes.add({
        reviewId,
        kind,
        text: text.trim(),
        device,
        element: selection.element,
        page: selection.page,
        screenshot: selection.shot,
        console: selection.console,
        requests: selection.requests,
      });
      toast.success(t("Note saved."));
      onClose(true);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!selection} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{general ? t("A general note") : t("A note on this part")}</DialogTitle>
          <DialogDescription>
            {selection?.element
              ? `<${selection.element.tag}> ${selection.element.text.slice(0, 120) || selection.element.selector}`
              : t("On {d}, about the whole of it.", { d: deviceLabel(device) })}
          </DialogDescription>
        </DialogHeader>
        {selection?.shot ? (
          <img
            src={selection.shot}
            alt={t("The selected part")}
            className="max-h-40 w-full rounded border object-contain"
          />
        ) : null}
        <fieldset className="flex flex-wrap gap-1.5" aria-label={t("Kind")}>
          {KINDS.filter((k) => general || k.kind !== "general").map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={cn(
                "h-8 rounded-full border px-3 text-[13px] pointer-coarse:min-h-11",
                kind === k.kind ? k.className : "bg-card hover:bg-accent",
              )}
            >
              {t(k.label)}
            </button>
          ))}
        </fieldset>
        <Textarea
          autoFocus
          rows={4}
          aria-label={t("Your note")}
          placeholder={
            kind === "keep"
              ? t("What you like and want kept…")
              : kind === "problem"
                ? t("What is wrong…")
                : t("What should change…")
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
        {selection && (selection.console.length || selection.requests.length) ? (
          <p className="text-xs text-muted-foreground">
            {t("Attached: {c} console lines, {r} failed requests.", {
              c: selection.console.length,
              r: selection.requests.length,
            })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !text.trim()} onClick={save}>
            {t("Save note")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NotesPanel = memo(function NotesPanel({
  review: r,
  active,
  onShow,
  onChanged,
  editable,
  confirm,
}: {
  review: ReviewDetail;
  active: string | null;
  onShow: (n: ReviewNote) => void;
  onChanged: () => void;
  editable: boolean;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [filter, setFilter] = useState<ReviewNoteKind | "all">("all");
  const [earlier, setEarlier] = useState(false);
  const current = r.notes.filter((n) => n.round === r.round);
  const numbers = new Map(current.map((n, i) => [n.id, i + 1]));
  const shown = (earlier ? r.notes.filter((n) => n.round < r.round) : current).filter(
    (n) => filter === "all" || n.kind === filter,
  );
  const groups = byDevice(shown);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-help="review.notes">
      <div className="flex shrink-0 flex-wrap gap-1 border-b p-2">
        {(["all", "keep", "change", "problem", "general"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => setFilter(k)}
            className={cn(
              "h-7 rounded-full border px-2.5 text-xs pointer-coarse:min-h-10",
              filter === k ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
            )}
          >
            {k === "all" ? t("All") : t(kindOf(k)?.label ?? k)}
          </button>
        ))}
        {r.round > 1 ? (
          <button
            type="button"
            aria-pressed={earlier}
            onClick={() => setEarlier(!earlier)}
            className="ml-auto h-7 rounded-full border px-2.5 text-xs hover:bg-accent pointer-coarse:min-h-10"
          >
            {earlier ? t("This round") : t("Earlier rounds")}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!groups.length ? (
          <p className="p-3 text-sm text-muted-foreground">
            {earlier
              ? t("No notes in earlier rounds.")
              : t(
                  "No notes yet. Press Select, click a part of the page, and say what to keep, change or fix; or write a general note.",
                )}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="mb-3">
              <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                {g.label} ({g.notes.length})
              </h3>
              <ul className="space-y-1.5">
                {g.notes.map((n) => (
                  <NoteItem
                    key={n.id}
                    note={n}
                    n={numbers.get(n.id) ?? null}
                    active={n.id === active}
                    editable={editable && n.round === r.round}
                    onShow={() => onShow(n)}
                    onChanged={onChanged}
                    confirm={confirm}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
});

function NoteItem({
  note: n,
  n: number,
  active,
  editable,
  onShow,
  onChanged,
  confirm,
}: {
  note: ReviewNote;
  n: number | null;
  active: boolean;
  editable: boolean;
  onShow: () => void;
  onChanged: () => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(n.text);
  const [shot, setShot] = useState<string | null>(null);
  const k = kindOf(n.kind);
  const save = async () => {
    try {
      await api.reviews.notes.edit({ id: n.id, text: text.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(message(e));
    }
  };
  const remove = async () => {
    if (!(await confirm(t("Delete this note?"), n.text.slice(0, 200), t("Delete")))) return;
    try {
      await api.reviews.notes.delete({ id: n.id });
      onChanged();
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <li
      id={`note-${n.id}`}
      className={cn(
        "rounded-md border bg-background p-2 text-sm",
        active && "ring-2 ring-amber-500",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onShow}
          className={cn(
            "mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-semibold",
            k?.className,
          )}
          title={n.element ? t("Show it on the page") : t(k?.label ?? "")}
          aria-label={t("Note {n}: show it", { n: number ?? "" })}
        >
          {number ?? "·"}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1.5">
              <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex gap-1.5">
                <Button size="xs" disabled={!text.trim()} onClick={save}>
                  {t("Save")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onShow}
              className="block w-full text-left [overflow-wrap:anywhere]"
            >
              {n.text}
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{t(k?.label ?? n.kind)}</span>
            {n.element ? (
              <span className="truncate" title={n.element.selector}>
                {`<${n.element.tag}>`} {n.element.text.slice(0, 40)}
              </span>
            ) : null}
            {n.page && n.page !== "/" ? <span>{n.page}</span> : null}
            {n.source === "chat" ? <span>{t("from the chat")}</span> : null}
            {n.console.length || n.requests.length ? (
              <span className="text-red-600 dark:text-red-400">
                {t("{c} errors, {r} failed requests", {
                  c: n.console.length,
                  r: n.requests.length,
                })}
              </span>
            ) : null}
          </div>
          {shot ? (
            <img src={shot} alt={t("The part noted")} className="mt-1.5 max-h-40 rounded border" />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-0.5">
          {n.hasScreenshot && !shot ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("Show its picture")}
              title={t("Show its picture")}
              onClick={() =>
                api.reviews.notes
                  .screenshot({ id: n.id })
                  .then((s) => setShot(s.dataUrl))
                  .catch((e) => toast.error(message(e)))
              }
            >
              <ImageIcon />
            </Button>
          ) : null}
          {editable && !editing ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("Edit the note")}
                onClick={() => {
                  setText(n.text);
                  setEditing(true);
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("Delete the note")}
                onClick={remove}
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
