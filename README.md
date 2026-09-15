# Pipeline graph editor

A prototype graph/canvas editor for streaming data pipelines, built to explore
where this class of UI gets hard at scale. Performance characteristics matter
more here than features or polish.

SvelteKit (SPA, `adapter-static`, `ssr = false`) + Svelte 5 runes + TypeScript strict.

```bash
npm run dev      # dev server
npm run build    # static SPA into build/
npm run check    # svelte-check + tsc
npm run verify   # headless logic checks, see tools/
```

Decisions and measurements are logged per phase in [NOTES.md](./NOTES.md).

## Current state: phase 5 — culling and semantic zoom

Fixture generator producing DAG-shaped pipelines at 50 / 500 / 2,000 / 10,000
nodes, a structural validator, ELK layout in a dedicated Web Worker with stable
incremental layout, and a hybrid renderer: grid and edges on a canvas, nodes as
DOM elements in a CSS-transformed layer, both driven by one transform. Pan with
drag, zoom with the wheel. A perf HUD reports FPS, frame time, visible vs total
nodes and the last layout duration.

Interaction: a `d3-quadtree` over node bounds for picking, distance-to-bezier
edge picking with a zoom-aware tolerance, click and shift-click selection,
shift-drag marquee, and node dragging with edges following live.

| gesture | |
|---|---|
| drag empty space | pan |
| wheel | zoom toward the cursor |
| click node / edge | select |
| shift-click | toggle |
| shift-drag empty space | marquee, added to the selection |
| drag a node | move the selection |
| middle-drag | pan, always |

Everything off screen is culled, and detail is a function of zoom: below 0.5
labels and ports are dropped for plain boxes, below 0.25 nodes become dots and
edges straight lines. Nodes leave the DOM for the canvas above 2,000 of them or
below the full detail tier — every gesture keeps working either way, because
nothing goes through a node element.

Zoomed in at 10,000 nodes this is a 10x reduction in per-frame JavaScript
(1.98 ms to 0.20 ms); zoomed out it is 2.1x, all of it semantic zoom. The `cull`
and `semantic zoom` checkboxes turn each off so the HUD shows the difference
live.
