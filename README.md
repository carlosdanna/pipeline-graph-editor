# Pipeline graph editor

A prototype graph/canvas editor for streaming data pipelines — pipeline stages
(source / transform / filter / aggregate / sink) joined by typed data flows, with
a status and throughput per stage that change constantly while the graph
structure stays almost still.

Built to explore **where this class of UI gets hard at scale**. Performance
characteristics matter more here than features or polish, and the interesting
parts are the architectural ones: what goes on a canvas versus in the DOM, how
layout stays stable, and how 200 telemetry updates a second cost almost nothing.

SvelteKit (SPA, `adapter-static`, `ssr = false`) · Svelte 5 runes · TypeScript
strict · `elkjs` · `d3-quadtree`

---

## Quick start

```bash
npm install
npm run dev
```

Then pick a fixture size in the header — 50, 500, 2,000 or 10,000 nodes — and
press **▶ start feed** to turn on the telemetry stream. The HUD in the top right
reports what it is costing.

```bash
npm run build      # static SPA into build/
npm run check      # svelte-check + tsc
npm test           # Vitest — 189 tests, ~3 s
npm run test:e2e   # Playwright against the production build
npm run bench      # the measurement scripts behind the numbers in docs/
```

`npm run test:e2e` needs `npx playwright install chromium` once.

---

## Documentation

| | |
|---|---|
| **[docs/architecture.md](./docs/architecture.md)** | How it is built and why. Start here. |
| **[docs/performance.md](./docs/performance.md)** | Every measurement, with its methodology. |
| **[docs/learnings.md](./docs/learnings.md)** | What turned out to be wrong. The most useful one. |
| **[docs/limitations.md](./docs/limitations.md)** | What does not work, and what to consider next. |
| **[docs/testing.md](./docs/testing.md)** | The three testing layers and what each is for. |
| [NOTES.md](./NOTES.md) | The chronological build log, one section per phase. |

---

## What it does

**Rendering.** Grid, edges, ports and selection on one canvas; nodes as DOM
elements in a CSS-transformed layer above it — both moved by one transform
written in the same animation frame. Above 2,000 nodes, or below 0.5 zoom, nodes
move to the canvas too. Every gesture keeps working across that switch, because
nothing has ever gone through a node element.

**Layout.** ELK in a dedicated Web Worker, never on the main thread. Adding a
stage lays out a dirty region of ~6 nodes rather than the whole graph, and
**moves no existing node by even a subpixel** — verified at 10,000 nodes.

**Culling and semantic zoom.** Everything off screen is skipped. Below 0.5 zoom
labels and ports go; below 0.25 nodes become dots and edges straight lines.

**Interaction.** A `d3-quadtree` over node bounds, distance-to-bezier edge
picking with a zoom-aware tolerance, click / shift-click / marquee selection, and
node dragging with edges following live.

**Streaming.** A mock feed at 200–20,000 updates a second. Values are written
straight into typed arrays; only the *notification* is batched, into one flush
per frame.

**Table pane.** Every stage, virtualized — about twenty rows exist as elements
whether the list holds a hundred or a million. Selection is bidirectional with
the canvas.

**Accessibility.** A parallel off-screen DOM tree with real ARIA roles and
labels, kept in step with what is drawn. Full keyboard operation.

### Controls

| gesture | | key | |
|---|---|---|---|
| drag empty space | pan | arrows | move between connected stages |
| wheel | zoom toward cursor | enter | select focused stage |
| click | select node or edge | shift+enter | add to selection |
| shift-click | toggle | escape | clear selection |
| shift-drag empty space | marquee | `+` / `-` | zoom |
| drag a node | move the selection | `0` | fit to screen |
| middle-drag | pan, always | tab | into the graph, then the table |

---

## The headline numbers

Per-frame JavaScript at 10,000 nodes (14,739 edges), culling and semantic zoom
off versus on:

| | off | on | |
|---|---|---|---|
| zoomed in (1.0x) | 1.98 ms | **0.20 ms** | 10x — almost all culling |
| fit to screen (0.021x) | 1.61 ms | **0.77 ms** | 2.1x — all semantic zoom |

A 200/second telemetry feed over that graph, zoomed in, produces **two canvas
redraws per second**: 81 of 10,000 nodes are on screen, so ~99% of updates write
two array slots and schedule nothing.

Batching 20,000 updates a second costs **0.029 ms per frame** — 0.2% of a 16.7 ms
budget.

Real browser frame times during a sustained pan: **0.3 ms at 2,000 nodes**,
**1.3 ms at 10,000**.

Full tables and methodology in [docs/performance.md](./docs/performance.md) —
including what these numbers deliberately do *not* include.

---

## Known limitation

**ELK cannot lay out the 10,000-node fixture in a browser.** It overflows the
worker's stack, warm and on retry. That fixture falls back to the placeholder
layered layout, which everything else works on normally — the header will show
`layout failed`. Every 10k layout timing in these docs was measured in Node.

Details and the options for fixing it are in
[docs/limitations.md](./docs/limitations.md#elk-cannot-lay-out-10000-nodes-in-a-browser).
