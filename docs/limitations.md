# Limitations and considerations

What does not work, what was deliberately not built, and what to think about
before taking any of this further.

---

## Known defects

### ELK cannot lay out 10,000 nodes in a browser

**The most significant limitation in the project.**

The 10,000-node fixture fails with `Maximum call stack size exceeded` about two
seconds after you select it — warm *and* on the fresh-worker retry, so this is
not the intermittent warm-instance defect the worker client already mitigates. A
browser worker's stack is smaller than Node's, and `elkjs` is GWT-compiled Java
with deep recursion.

Every 10,000-node layout timing in this repo was measured in Node.

**What actually happens:** the app degrades rather than breaking. The header
shows `layout failed`, the placeholder layered layout stays on screen, and
everything else — culling, semantic zoom, the canvas fallback, picking,
dragging, streaming, the table, the keyboard — works normally on it.

**Options, none of them small:**

| approach | cost |
|---|---|
| Chunked / hierarchical layout — lay out subgraphs and compose | Substantial. Changes the incremental-layout design too. |
| A different engine (e.g. a force or layered implementation written for JS) | Loses ELK's crossing reduction, which is the main thing it buys |
| Layout server-side and ship coordinates | Contradicts the SPA premise, but is what a real product would probably do |
| Cap the interactive fixture at 2,000 and treat 10,000 as a render-only case | Honest, and what the app effectively does today |

### Nothing prevents nodes overlapping

An incrementally-added stage is placed relative to its neighbours with no
knowledge of the rest of the graph, so it can land on top of an unrelated node.
Dragging can do the same. The honest fix is a local overlap-removal pass after
splicing.

### Edge culling is far less selective than node culling

At 10,000 nodes zoomed to 1.0x: **81 of 10,000 nodes** drawn (0.8%) but
**1,867 of 14,739 edges** (12.7%) — a sixteen-fold difference.

A bezier's axis-aligned bounding box is a poor proxy for a diagonal curve: an
edge running from far above-left to far below-right has a box covering the whole
viewport while the curve crosses one corner. Tightening it means a fattened
segment-versus-rectangle test per edge instead of four comparisons. Not worth it
at 0.20 ms — but it is why the edge number never gets as good as the node
number, and it is the first place to look if edges ever dominate a frame again.

### Left-then-right does not retrace

Keyboard navigation retraces **exactly** vertically (100%) and only **67.5%**
horizontally. Following an edge downstream and back upstream can land on a
different parent, which is defensible — the node genuinely has several — but it
is not symmetric and can be disorienting.

---

## Deliberate trade-offs

These are choices, not oversights. Each has a cost worth knowing.

### Up and down move between layer peers, not edge neighbours

Two nodes in the same layer are at the same depth from the sources; they are not
joined by an edge. This is a real departure from "arrow keys move between
connected nodes". What it buys is a **total order**, so navigation retraces
exactly and reaches 100% of stages — against 74.6% and 99.04% for the
edge-connected model. See [learnings.md](./learnings.md#10-asymmetric-relations-strand-things).

### The accessible tree is bounded, not complete

At most ~150 on-screen nodes are described, plus the focused node, its arrow
targets and its neighbours. At fit-to-screen with 10,000 nodes, *everything* is
drawn — and a 10,000-item listbox is both the DOM explosion the canvas exists to
avoid and useless to read.

Nothing becomes unreachable, because every arrow target is always present. But
the limit is a **count, not a reading budget**: 150 short labels and 150 long
ones are very different amounts of speech.

### The DOM node list lands one frame after the canvas

Culling is decided inside the `requestAnimationFrame` callback, but *which* DOM
nodes exist has to cross into Svelte's reactivity, which lands a microtask later.

Position never lags — that comes from the shared transform written in the same
callback — so a node already on screen can never lag its own edges. Only a node
*entering* the viewport appears a frame late, and the 160px cull margin is many
frames of runway at any plausible pan speed. Worth knowing it is there.

### Fit-to-screen always lands in the dot tier

Fit zoom is 0.021x at 10,000 nodes, 0.064x at 2,000 and **0.177x at 500** — all
below the 0.25 dot threshold. So the default view on load is dots, at every
fixture size, including 50 nodes.

That is what "below ~0.25, draw nodes as dots" means for graphs shaped like
these. `ZOOM_DOT` in `render/limits.ts` is one constant if you want boxes on
load.

### Detail tiers key off zoom, not density

A sparse graph at 0.3x is perfectly readable as boxes; a dense one at 0.6x is
not. Density would be the better signal. Zoom is what the brief specified and
what a user can predict, which is worth something on its own.

### Reactive cells are allocated for every node

One signal per node, allocated at fixture load — 0.139 ms for 10,000. Lazy
allocation is better in principle and was the direct cause of the worst bug in
the project, because a `$state` created inside a `$derived` does not register as
a dependency.

### A marquee touches reactivity, slightly

An earlier phase claimed a marquee "touches Svelte's reactivity zero times".
That stopped being true when the table needed selection to be observable. It is
now **one signal write per frame**, from which ~40 visible row derivations
re-run. The canvas is unaffected and still reads the flag arrays directly.

### `MIN_ZOOM` is nearly binding

Fitting the 10,000-node graph needs k = 0.0216 against a floor of 0.02. Worth
remembering before changing either the floor or the layout's aspect ratio.

### Throughput is stored as `Float32`

Rates reach ~10⁵, where float32 resolves to about 0.01 — irrelevant for a
displayed rate, and worth knowing before summing 10,000 of them for a total.

---

## Not built, on purpose

The brief asked for none of these and they were left out:

- minimap
- undo / redo
- persistence or a backend of any kind
- creating or deleting edges by dragging between ports
- sorting or filtering the table — both would break the assumption that **row
  index equals node index**, which is what makes `scrollToIndex` and the
  selection flags line up without a mapping layer
- touch and multi-touch gestures (pointer events are used, but pinch-zoom is not
  implemented)
- an animated pan when jumping to a node — clicking a table row jumps instantly,
  which at 10,000 nodes can be most of the graph away

---

## Testing gaps

- **One browser.** Chromium only. Nothing here says anything about `deltaMode`,
  pointer capture or canvas behaviour outside Blink — all three of which this
  codebase has non-trivial handling for.
- **No screen reader has been run against this.** The parallel tree is tested
  for roles, labels and focus order, which is necessary and not sufficient.
- **jsdom has no layout**, so component tests stub `clientHeight` and assert
  structure only. Everything about pixels is either a pure-maths unit test or a
  Playwright assertion.
- **The end-to-end perf assertions use the frame budget (16.7 ms), not tight
  numbers.** A 2x regression that stayed under budget would pass silently;
  `npm run bench` is where that size of regression shows. Headless timings are
  noisy enough that a tighter bound would flake, and a flaky test gets ignored.
- **The 10,000-node e2e tests run on the placeholder layout**, because ELK
  cannot produce a real one in a browser. They exercise rendering and
  interaction faithfully; they say nothing about ELK's output at that size.

---

## If this were going further

Roughly in order of value:

1. **Solve the 10,000-node layout**, or decide explicitly that 2,000 is the
   interactive ceiling and say so in the UI.
2. **Local overlap removal** after incremental layout and after drags.
3. **Cross-browser end-to-end runs**, particularly Firefox for `deltaMode` and
   Safari for canvas and pointer behaviour.
4. **Incremental index maintenance.** `buildGraphIndex` and `validateGraph` still
   run over the whole graph on every structural change — ~16 ms at 10,000 nodes.
   Layout is already sub-linear; these are not.
5. **A real screen reader pass**, which will almost certainly change the label
   wording and may change the roles.
6. **Tighter edge culling**, only if edges start dominating frames again.
