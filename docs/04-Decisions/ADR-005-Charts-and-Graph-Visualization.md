# ADR-005 — Recharts (via shadcn chart) and React Flow + ELK + Motion

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
The UI needs charts that match shadcn's theming in dark and light, and
an animated, live-updating DAG of The Web, whose nodes are rich React
components.

## Decision
- **Charts: Recharts v3 through shadcn's `chart` component**, colours
  from CSS variables (`--chart-1…`). Every chart container gets an
  explicit height or aspect ratio.
- **The Web: `@xyflow/react` (React Flow)** with custom node components
  built from shadcn primitives. **elkjs** computes a layered layout in a
  Web Worker. **Motion** tweens nodes to their new positions when the
  layout changes. Animated edges show running work and handoffs.
- Live updates are batched per animation frame. A relayout only happens
  when the structure changes, not when a state changes.

**As built (2026-10-01, M1.8):** Recharts is pinned at 3.8 by shadcn's
chart component. Nodes move with a CSS transition on React Flow's
transforms, which was enough; Motion is not used.

## Consequences
- One styling system across charts, graph and the rest of the UI.
- ELK in a worker keeps large graphs from freezing the UI.

## Why not ECharts
Better for very dense time series, but it doesn't follow shadcn styling.
It can be added later for a heavy live-metrics view if Recharts struggles.

## Why not Cytoscape.js
It renders to canvas, so nodes can't be React and shadcn components.

## Why not visx
Too low-level for the number of charts needed.

Related: [[Web-UI]]
