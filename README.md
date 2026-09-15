# Pipeline graph editor

A prototype graph/canvas editor for streaming data pipelines, built to explore
where this class of UI gets hard at scale. Performance characteristics matter
more here than features or polish.

SvelteKit (SPA, `adapter-static`, `ssr = false`) + Svelte 5 runes + TypeScript strict.

```bash
npm run dev      # dev server
npm run build    # static SPA into build/
npm run check    # svelte-check + tsc
```

Decisions and measurements are logged per phase in [NOTES.md](./NOTES.md).

## Current state: phase 3 — hybrid renderer

Fixture generator producing DAG-shaped pipelines at 50 / 500 / 2,000 / 10,000
nodes, a structural validator, ELK layout in a dedicated Web Worker with stable
incremental layout, and a hybrid renderer: grid and edges on a canvas, nodes as
DOM elements in a CSS-transformed layer, both driven by one transform. Pan with
drag, zoom with the wheel. A perf HUD reports FPS, frame time, visible vs total
nodes and the last layout duration.

Nodes are drawn up to 2,000; above that the canvas still renders edges and the
grid. No culling, no selection, no interaction beyond pan/zoom yet.
