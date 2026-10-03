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
import { memo, useEffect, useMemo, useState } from "react";
import { StateBadge } from "@/components/common";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Task = JobView["tasks"][number];
type TaskNode = Node<{ task: Task; leg: string | null; onOpen: (id: string) => void }, "task">;

/** An earlier job of a project, folded to one node (ADR-034). */
export interface FoldedJob {
  id: string;
  title: string;
  state: string;
  done: number;
  total: number;
  /** The nodes it comes after: the job before it. */
  dependsOn: string[];
}
type JobNode = Node<{ job: FoldedJob; onOpen: (id: string) => void }, "job">;

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

/** ELK lays The Web out in layers (ADR-005); only a change of structure moves nodes. */
async function layout(tasks: { id: string; dependsOn: string[] }[], vertical: boolean) {
  elk ??= new ELK({ workerFactory: worker });
  const g = await elk.layout({
    id: "web",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: tasks.map((t) => ({ id: t.id, width: W, height: H })),
    edges: tasks.flatMap((t) =>
      t.dependsOn.map((d) => ({ id: `${d}-${t.id}`, sources: [d], targets: [t.id] })),
    ),
  });
  return new Map((g.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

const TaskCard = memo(({ data }: NodeProps<TaskNode>) => {
  const { task, leg } = data;
  const running =
    task.state === "running" || task.state === "verifying" || task.state === "assigned";
  return (
    <button
      type="button"
      onClick={() => data.onOpen(task.id)}
      className={cn(
        "flex h-[76px] w-[220px] flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left shadow-sm transition-shadow hover:shadow-md",
        running &&
          "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_25%,transparent)] motion-safe:animate-[pulse_2s_ease-in-out_infinite]",
        task.state === "done" && "border-success/50",
        task.state === "failed" && "border-destructive/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="line-clamp-2 text-xs font-medium leading-snug">{task.title}</div>
      <div className="flex items-center gap-1.5">
        <StateBadge state={task.state} className="h-4 px-1 text-[10px]" />
        {leg ? <span className="truncate text-[10px] text-muted-foreground">{leg}</span> : null}
        {task.attemptCount > 1 ? (
          <span className="ml-auto text-[10px] text-muted-foreground">×{task.attemptCount}</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </button>
  );
});

const JobCard = memo(({ data }: NodeProps<JobNode>) => {
  const { job } = data;
  return (
    <button
      type="button"
      onClick={() => data.onOpen(job.id)}
      title={t("Open “{title}” here", { title: job.title })}
      className="flex h-[76px] w-[220px] flex-col justify-between rounded-lg border border-dashed bg-muted/40 px-2.5 py-2 text-left shadow-sm transition-shadow hover:shadow-md"
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="line-clamp-2 text-xs font-medium leading-snug">{job.title}</div>
      <div className="flex items-center gap-1.5">
        <StateBadge state={job.state} className="h-4 px-1 text-[10px]" />
        <span className="truncate text-[10px] text-muted-foreground">
          {t("{done}/{total} tasks done", { done: job.done, total: job.total })}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </button>
  );
});

const nodeTypes = { task: TaskCard, job: JobCard };

/**
 * The Web, live (Web-UI → Job): tasks coloured by state, the Leg on each
 * running task, a pulse while it works, animated edges into running work,
 * and nodes that glide to their new place when the plan changes.
 */
export function WebGraph({
  tasks,
  legName,
  onOpen,
  folded = [],
  onOpenJob,
}: {
  tasks: Task[];
  legName: (task: Task) => string | null;
  onOpen: (id: string) => void;
  /** A project's earlier jobs, one node each, before the tasks shown in full. */
  folded?: FoldedJob[];
  onOpenJob?: (id: string) => void;
}) {
  const vertical = typeof window !== "undefined" && window.innerWidth < 768;
  const all = [...folded, ...tasks];
  const shape = all.map((t) => `${t.id}:${t.dependsOn.join(",")}`).join("|");
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the structure moves nodes
  useEffect(() => {
    let cancelled = false;
    layout(all, vertical).then((p) => !cancelled && setPositions(p));
    return () => {
      cancelled = true;
    };
  }, [shape, vertical]);

  const nodes: (TaskNode | JobNode)[] = useMemo(
    () => [
      ...folded.map(
        (job): JobNode => ({
          id: job.id,
          type: "job",
          position: positions.get(job.id) ?? { x: 0, y: 0 },
          data: { job, onOpen: (id) => onOpenJob?.(id) },
          draggable: false,
          targetPosition: vertical ? Position.Top : Position.Left,
          sourcePosition: vertical ? Position.Bottom : Position.Right,
        }),
      ),
      ...tasks.map(
        (task): TaskNode => ({
          id: task.id,
          type: "task",
          position: positions.get(task.id) ?? { x: 0, y: 0 },
          data: { task, leg: legName(task), onOpen },
          draggable: false,
          targetPosition: vertical ? Position.Top : Position.Left,
          sourcePosition: vertical ? Position.Bottom : Position.Right,
        }),
      ),
    ],
    [folded, tasks, positions, legName, onOpen, onOpenJob, vertical],
  );
  const byId = new Map<string, { state: string }>(all.map((t) => [t.id, t]));
  const done = (id: string) => {
    const s = byId.get(id)?.state;
    return s === "done" || s === "completed";
  };
  const edges: Edge[] = all.flatMap((t) =>
    t.dependsOn.map((d) => ({
      id: `${d}-${t.id}`,
      source: d,
      target: t.id,
      type: "smoothstep",
      animated: t.state === "running" || t.state === "assigned",
      style: {
        stroke: done(d) ? "var(--success)" : "var(--border)",
        strokeWidth: 1.5,
      },
    })),
  );

  if (all.length === 0)
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        {t("No plan yet.")}
      </div>
    );
  // Fit only once ELK has placed every node; a new structure remounts and fits again.
  const laidOut = all.every((node) => positions.has(node.id));
  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border bg-card/40 md:h-[480px] [&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-500">
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
          minZoom={0.2}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      ) : null}
    </div>
  );
}
