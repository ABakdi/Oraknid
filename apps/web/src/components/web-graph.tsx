import type { JobView } from "@oraknid/contracts";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerSource from "elkjs/lib/elk-worker.min.js?raw";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { StateBadge } from "@/components/common";
import { LegAvatar, LegHandoff, type LegLook, useLegLooks } from "@/components/leg-avatar";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Task = JobView["tasks"][number];
type TaskNode = Node<
  {
    task: Task;
    leg: string | null;
    /** The Leg working on it, shown as its avatar. */
    look: LegLook | null;
    /** It just moved from one Leg to another. */
    handoff: { from: LegLook; to: LegLook } | null;
    onOpen: (id: string) => void;
  },
  "task"
>;

/** A task moved from one Leg to another (a reassignment, a step-up, a fallback). */
export interface Handoff {
  taskId: string;
  from: string;
  to: string;
}

/**
 * The handoffs since the tasks were last seen: a task whose Leg is not the
 * one it last had. `seen` keeps each task's last Leg (kept while it waits
 * between attempts); the first look only fills it.
 */
export function nextHandoffs(
  seen: Map<string, string>,
  tasks: { id: string; assignedLegId: string | null }[],
): Handoff[] {
  const out: Handoff[] = [];
  for (const x of tasks) {
    if (!x.assignedLegId) continue;
    const before = seen.get(x.id);
    if (before && before !== x.assignedLegId)
      out.push({ taskId: x.id, from: before, to: x.assignedLegId });
    seen.set(x.id, x.assignedLegId);
  }
  return out;
}

/** How long a handoff shows on its task. */
export const HANDOFF_MS = 6000;

/** The handoffs showing now, live: each found as the tasks change, gone after a while. */
export function useHandoffs(tasks: { id: string; assignedLegId: string | null }[]) {
  const seen = useRef(new Map<string, string>());
  const [showing, setShowing] = useState<ReadonlyMap<string, Handoff>>(new Map());
  useEffect(() => {
    const found = nextHandoffs(seen.current, tasks);
    if (!found.length) return;
    setShowing((m) => new Map([...m, ...found.map((h) => [h.taskId, h] as const)]));
    for (const h of found)
      setTimeout(
        () =>
          setShowing((m) => {
            if (m.get(h.taskId) !== h) return m;
            const next = new Map(m);
            next.delete(h.taskId);
            return next;
          }),
        HANDOFF_MS,
      );
  }, [tasks]);
  return showing;
}

/** A task shows its Leg while the Leg has it, and once it is done. */
const WITH_LEG = ["assigned", "running", "verifying", "done"];

/** A job drawn as one box (a project's compact Workflow, ADR-034 → Changed). */
export interface FlowJob {
  id: string;
  title: string;
  /** What it's for, or what it did (Jobs-and-Projects → A job's name and description). */
  description?: string | null;
  state: string;
  done: number;
  total: number;
  /** The job the project is about now: highlighted. */
  current?: boolean;
  /** The nodes it comes after: the job before it. */
  dependsOn: string[];
}
type JobNode = Node<{ job: FlowJob; onOpen: (id: string) => void }, "job">;

/** A job's own workflow drawn in full inside a frame named by the job (expanded). */
export interface FlowGroup {
  job: FlowJob;
  tasks: Task[];
}
type FrameNode = Node<
  { job: FlowJob; width: number; height: number; onOpen: (id: string) => void },
  "frame"
>;

// In a Web Worker, so a large Web never freezes the UI (ADR-005).
// Away from home the UI is one self-contained page: its worker comes from a Blob instead.
// Made on the first layout, so a page that only imports The Web starts no worker.
let elk: InstanceType<typeof ELK> | null = null;
const worker = () =>
  import.meta.env.MODE === "remote"
    ? new Worker(URL.createObjectURL(new Blob([elkWorkerSource], { type: "text/javascript" })))
    : new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url));
const W = 220;
const H = 76;
/** A frame's padding around its tasks, and the strip naming its job. */
const PAD = 16;
const HEAD = 40;
/** Between one frame and the next. */
const GAP = 72;

type Place = { x: number; y: number };

/** ELK lays The Web out in layers (ADR-005); only a change of structure moves nodes. */
async function layout(tasks: { id: string; dependsOn: string[] }[], vertical: boolean) {
  elk ??= new ELK({ workerFactory: worker });
  const ids = new Set(tasks.map((x) => x.id));
  const g = await elk.layout({
    id: "web",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: tasks.map((x) => ({ id: x.id, width: W, height: H })),
    edges: tasks.flatMap((x) =>
      x.dependsOn
        .filter((d) => ids.has(d))
        .map((d) => ({ id: `${d}-${x.id}`, sources: [d], targets: [x.id] })),
    ),
  });
  return new Map((g.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/**
 * Frames one after another (expanded Workflow): left to right on a wide
 * screen, top to bottom on a phone, each starting where the last ended.
 */
export function stackFrames(sizes: { width: number; height: number }[], vertical: boolean) {
  let at = 0;
  return sizes.map((s) => {
    const p = vertical ? { x: 0, y: at } : { x: at, y: 0 };
    at += (vertical ? s.height : s.width) + GAP;
    return p;
  });
}

/** Each job's tasks laid out on their own, framed, and the frames stacked. */
async function layoutGroups(groups: FlowGroup[], vertical: boolean) {
  const inner = await Promise.all(groups.map((g) => layout(g.tasks, vertical)));
  const sizes = inner.map((p) => {
    const xs = [...p.values()];
    const w = xs.length ? Math.max(...xs.map((q) => q.x)) + W : W;
    const h = xs.length ? Math.max(...xs.map((q) => q.y)) + H : H / 2;
    return { width: w + PAD * 2, height: h + PAD * 2 + HEAD };
  });
  const frames = stackFrames(sizes, vertical);
  const out = new Map<string, Place & { width?: number; height?: number }>();
  groups.forEach((g, i) => {
    out.set(g.job.id, { ...(frames[i] as Place), ...(sizes[i] as { width: number }) });
    for (const [id, q] of inner[i] ?? []) out.set(id, { x: q.x + PAD, y: q.y + PAD + HEAD });
  });
  return out;
}

const RUNNING_TASK = ["running", "verifying", "assigned"];

const TaskCard = memo(({ data, targetPosition, sourcePosition }: NodeProps<TaskNode>) => {
  const { task, leg, look, handoff } = data;
  const running = RUNNING_TASK.includes(task.state);
  return (
    <button
      type="button"
      onClick={() => data.onOpen(task.id)}
      title={task.waitingReason ? `${task.title}\n${task.waitingReason}` : undefined}
      data-handoff={handoff ? "true" : undefined}
      className={cn(
        "flex h-[76px] w-[220px] flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left shadow-sm transition-shadow hover:shadow-md",
        running &&
          "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_25%,transparent)] motion-safe:animate-[pulse_2s_ease-in-out_infinite]",
        task.state === "done" && "border-success/50",
        task.state === "failed" && "border-destructive/60",
      )}
    >
      <Handle type="target" position={targetPosition ?? Position.Left} className="!opacity-0" />
      <div className="line-clamp-2 text-xs font-medium leading-snug">{task.title}</div>
      <div className="flex items-center gap-1.5">
        {handoff ? (
          <LegHandoff from={handoff.from} to={handoff.to} />
        ) : look ? (
          <LegAvatar leg={look} size="xs" />
        ) : null}
        <StateBadge state={task.state} className="h-4 px-1 text-[10px]" />
        {leg ? <span className="truncate text-[10px] text-muted-foreground">{leg}</span> : null}
        {!leg && task.waitingReason ? (
          // Why it is ready and not running yet (ADR-050).
          <span className="truncate text-[10px] text-muted-foreground" data-testid="waiting-reason">
            {task.waitingReason}
          </span>
        ) : null}
        {task.attemptCount > 1 ? (
          <span className="ml-auto text-[10px] text-muted-foreground">×{task.attemptCount}</span>
        ) : null}
      </div>
      <Handle type="source" position={sourcePosition ?? Position.Right} className="!opacity-0" />
    </button>
  );
});

const JobCard = memo(({ data, targetPosition, sourcePosition }: NodeProps<JobNode>) => {
  const { job } = data;
  return (
    <button
      type="button"
      onClick={() => data.onOpen(job.id)}
      title={openTitle(job)}
      aria-current={job.current ? "true" : undefined}
      className={cn(
        "flex h-[76px] w-[220px] flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left shadow-sm transition-shadow hover:shadow-md",
        job.current &&
          "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_25%,transparent)]",
      )}
    >
      <Handle type="target" position={targetPosition ?? Position.Left} className="!opacity-0" />
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "min-w-0 text-xs font-medium leading-snug",
              job.description ? "line-clamp-1" : "line-clamp-2",
            )}
          >
            {job.title}
          </div>
          {job.description ? (
            <div className="line-clamp-1 text-[10px] leading-snug text-muted-foreground">
              {job.description}
            </div>
          ) : null}
        </div>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </div>
      <div className="flex items-center gap-1.5">
        <StateBadge state={job.state} className="h-4 px-1 text-[10px]" />
        <span className="truncate text-[10px] text-muted-foreground">
          {t("{done}/{total} tasks done", { done: job.done, total: job.total })}
        </span>
      </div>
      <Handle type="source" position={sourcePosition ?? Position.Right} className="!opacity-0" />
    </button>
  );
});

const FrameCard = memo(({ data, targetPosition, sourcePosition }: NodeProps<FrameNode>) => {
  const { job } = data;
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={cn(
        "rounded-xl border border-dashed bg-muted/30",
        job.current && "border-primary/70 bg-primary/5",
      )}
    >
      <Handle type="target" position={targetPosition ?? Position.Left} className="!opacity-0" />
      <button
        type="button"
        onClick={() => data.onOpen(job.id)}
        title={openTitle(job)}
        className="flex h-10 w-full items-center gap-2 rounded-t-xl px-4 text-left hover:bg-accent/60"
      >
        <span className="min-w-0 truncate text-sm font-medium">{job.title}</span>
        <StateBadge state={job.state} className="h-4 shrink-0 px-1 text-[10px]" />
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {t("{done}/{total} tasks done", { done: job.done, total: job.total })}
        </span>
      </button>
      {job.total === 0 ? (
        <div className="px-4 text-xs text-muted-foreground">{t("No tasks yet.")}</div>
      ) : null}
      <Handle type="source" position={sourcePosition ?? Position.Right} className="!opacity-0" />
    </div>
  );
});

const nodeTypes = { task: TaskCard, job: JobCard, frame: FrameCard };

/** A job box's tooltip: open it, and its description in full. */
const openTitle = (job: FlowJob) =>
  `${t("Open “{title}”", { title: job.title })}${job.description ? `\n${job.description}` : ""}`;

/**
 * The Web, live (Web-UI → Job): tasks coloured by state, the Leg (its avatar) on each
 * task it has, a dot from one avatar to the next when a task moves to
 * another Leg, a pulse while it works, animated edges into running work,
 * and nodes that glide to their new place when the plan changes. It draws
 * a job's tasks, a project's jobs as boxes (`jobs`), or every job's tasks
 * framed by job (`groups`).
 */
export function WebGraph({
  tasks,
  legName,
  onOpen,
  jobs = [],
  groups,
  onOpenJob,
  className,
}: {
  tasks: Task[];
  legName: (task: Task) => string | null;
  onOpen: (id: string) => void;
  /** Jobs drawn as one box each, before the tasks. */
  jobs?: FlowJob[];
  /** Every job's tasks in a frame of its own; replaces `tasks` and `jobs`. */
  groups?: FlowGroup[];
  onOpenJob?: (id: string) => void;
  /** The frame around the canvas (its height). */
  className?: string;
}) {
  const vertical = typeof window !== "undefined" && window.innerWidth < 768;
  const framed = groups !== undefined;
  const flat = framed ? [] : [...jobs, ...tasks];
  const inGroups = (groups ?? []).flatMap((g) => g.tasks);
  const shape = framed
    ? `g|${(groups ?? [])
        .map((g) => `${g.job.id}[${g.tasks.map((x) => `${x.id}:${x.dependsOn.join(",")}`)}]`)
        .join("|")}`
    : flat.map((x) => `${x.id}:${x.dependsOn.join(",")}`).join("|");
  const [positions, setPositions] = useState<
    Map<string, Place & { width?: number; height?: number }>
  >(new Map());
  const looks = useLegLooks();
  const handoffs = useHandoffs(framed ? inGroups : tasks);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the structure moves nodes
  useEffect(() => {
    let cancelled = false;
    (framed ? layoutGroups(groups ?? [], vertical) : layout(flat, vertical)).then(
      (p) => !cancelled && setPositions(p),
    );
    return () => {
      cancelled = true;
    };
  }, [shape, vertical]);

  const nodes: (TaskNode | JobNode | FrameNode)[] = useMemo(() => {
    const side = {
      targetPosition: vertical ? Position.Top : Position.Left,
      sourcePosition: vertical ? Position.Bottom : Position.Right,
    };
    const openJob = (id: string) => onOpenJob?.(id);
    const look = (legId: string | null, fallback?: string | null): LegLook | null =>
      (legId ? looks.get(legId) : undefined) ?? (fallback ? { name: fallback, kind: "" } : null);
    const handoffOf = (task: Task) => {
      const h = handoffs.get(task.id);
      const from = h && look(h.from);
      const to = h && look(h.to);
      return from && to ? { from, to } : null;
    };
    const taskNode = (task: Task, parentId?: string): TaskNode => ({
      id: task.id,
      type: "task",
      position: positions.get(task.id) ?? { x: 0, y: 0 },
      data: {
        task,
        leg: legName(task),
        look: WITH_LEG.includes(task.state) ? look(task.assignedLegId, task.routing?.leg) : null,
        handoff: handoffOf(task),
        onOpen,
      },
      draggable: false,
      ...(parentId ? { parentId } : {}),
      ...side,
    });
    if (framed)
      // A frame comes before the tasks inside it (React Flow's order for parents).
      return (groups ?? []).flatMap((g) => {
        const p = positions.get(g.job.id);
        const frame: FrameNode = {
          id: g.job.id,
          type: "frame",
          position: { x: p?.x ?? 0, y: p?.y ?? 0 },
          data: { job: g.job, width: p?.width ?? W, height: p?.height ?? H, onOpen: openJob },
          draggable: false,
          selectable: false,
          zIndex: 0,
          ...side,
        };
        return [frame, ...g.tasks.map((x) => taskNode(x, g.job.id))];
      });
    return [
      ...jobs.map(
        (job): JobNode => ({
          id: job.id,
          type: "job",
          position: positions.get(job.id) ?? { x: 0, y: 0 },
          data: { job, onOpen: openJob },
          draggable: false,
          ...side,
        }),
      ),
      ...tasks.map((x) => taskNode(x)),
    ];
  }, [
    framed,
    groups,
    jobs,
    tasks,
    positions,
    legName,
    onOpen,
    onOpenJob,
    vertical,
    looks,
    handoffs,
  ]);

  const all: { id: string; state: string; dependsOn: string[] }[] = framed
    ? [...(groups ?? []).map((g) => g.job), ...inGroups]
    : flat;
  const byId = new Map<string, { state: string }>(all.map((x) => [x.id, x]));
  const done = (id: string) => {
    const s = byId.get(id)?.state;
    return s === "done" || s === "completed";
  };
  const edges: Edge[] = all.flatMap((x) =>
    x.dependsOn
      .filter((d) => byId.has(d))
      .map((d) => ({
        id: `${d}-${x.id}`,
        source: d,
        target: x.id,
        type: "smoothstep",
        animated: x.state === "running" || x.state === "assigned",
        // Inside a frame, above it.
        zIndex: 1,
        style: {
          stroke: done(d) ? "var(--success)" : "var(--border)",
          strokeWidth: 1.5,
        },
      })),
  );

  const frame =
    className ??
    "h-[420px] w-full overflow-hidden rounded-xl border bg-card/40 md:h-[480px] [&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-500";
  if (all.length === 0)
    return (
      <div className={cn(frame, "relative flex items-center justify-center")}>
        <span className="text-sm text-muted-foreground">{t("No plan yet.")}</span>
      </div>
    );
  // Fit only once ELK has placed every node; a new structure remounts and fits again.
  const laidOut = all.every((node) => positions.has(node.id));
  return (
    <div className={frame}>
      {laidOut ? (
        <ReactFlow
          key={shape}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
        >
          <Background gap={20} size={1} />
          <Controls
            showInteractive={false}
            position="bottom-right"
            className="pointer-coarse:[&_button]:!size-11"
          />
        </ReactFlow>
      ) : null}
    </div>
  );
}
