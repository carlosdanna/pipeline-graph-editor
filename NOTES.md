# Notes

Running log of decisions, one section per phase. What I chose, what I rejected,
and what the numbers actually said.

---

## Phase 1 — skeleton and data model

### What landed

```
src/lib/graph/types.ts       domain types, structure/dynamics split
src/lib/graph/rng.ts         seeded PRNG (mulberry32)
src/lib/graph/generate.ts    DAG fixture generator, node geometry constants
src/lib/graph/indexing.ts    id->index maps, adjacency, longest-path layering
src/lib/graph/positions.ts   Float32Array position store, bounds
src/lib/graph/validate.ts    structural validation (the actual "proof")
src/lib/layout/layered.ts    naive column layout (placeholder for ELK)
src/lib/render/edge-geometry.ts  bezier anchors + control points
src/lib/render/theme.ts      palette, kind/status/data-type colours
src/lib/components/GraphSvg.svelte  one-element-per-thing SVG renderer
src/routes/+page.svelte      fixture switcher, stats strip, validation badge
```

### Decisions

**Status and throughput are not fields on `PipelineNode`.**
The obvious domain reading is "a node has a status". I deliberately did not model
it that way. `NodeDynamics` is returned *alongside* the graph, parallel to
`graph.nodes`. If status lived on the node, a status change would have to produce
a new node object, which produces a new `PipelineGraph`, which invalidates the
`$state.raw` snapshot that layout, culling and hit-testing all key off. At 200
updates/second that is 200 full invalidations per second. The split is awkward to
read exactly once — in `types.ts` — and buys everything from phase 6 onward.

**Positions are `Float32Array`s indexed by node index, not `{x, y}` objects.**
This is the one phase 1 decision that is expensive to reverse, so flagging it
loudly. Rationale: phase 2 animates every position every frame, phase 4 rebuilds
a quadtree over them, phase 5 scans them for culling. All three are flat loops
over contiguous memory instead of pointer-chasing 10k objects. Cost: the entire
codebase is now index-based, and `GraphIndex.nodeIndexById` went from a
convenience to load-bearing infrastructure. Rejected the alternative (positions
as fields on the node) because it also welds position to structure, which would
make a node drag produce a new `PipelineGraph`.

**`noUncheckedIndexedAccess` is off**, though everything else beyond `strict` is
on. With parallel arrays it turns every hot-loop access into `T | undefined` and
the resulting `!` / `as` noise buries the logic. Documented in `tsconfig.json`.

**Layers are computed from the edges, not remembered from the generator.**
`computeLayers` runs Kahn's algorithm over the real edge list. It is slower than
storing the layer the generator assigned, and that is the point — it means the
render is reading the graph, not the generator's intentions. It also gives
cycle detection for free.

**The phase 1 layout is intentionally bad.** Pure column stacking, no crossing
reduction, no ordering within a column. It is ~40 lines, it is O(n), and it is a
useful synchronous fallback for the first frame before the worker answers in
phase 2. Leaving it naive also means the ELK improvement will be visible rather
than marginal.

**SVG is capped at 600 nodes** (`SVG_NODE_CAP` in `+page.svelte`). Above that the
page shows the stats and refuses to draw. This is the exhibit, not a safety
valve: one element per node, port, label and edge is ~25k DOM nodes at the 10k
fixture.

**Fixtures are seeded and deterministic.** `Math.random()` would make every
measurement in this project anecdotal — you could not compare a HUD number
before and after a change. Verified: same seed produces byte-identical structure.

### Generator shape

Layer widths follow a sine bulge — few sources, wide middle, few sinks. Fan-out
and fan-in then fall out of the profile rather than being special-cased: a node
in a narrowing layer picks `prevSize/size` parents, a node in a flat or widening
layer picks one (75% of the time), which is what produces the long 1-in/1-out
chains. Skip connections to layer *l-2* fire at 12%, still strictly forward, so
the graph is acyclic by construction and `validateGraph` confirms it rather than
assuming it.

Data types propagate: a transform emits its input type, a filter's `reject` port
emits `errors`, an aggregate emits `metrics`. Input ports are created one per
*distinct incoming type*, which is what makes the type system worth having — a
node fed by both a pass path and a reject path genuinely has two inlets.

### What surprised me

**The type system saturated.** First run, `metrics` was 79% of all edges at the
10k fixture (11,635 / 14,739). Two compounding causes: aggregates were 27% of
nodes, and `metrics` is absorbing — a transform emits its input type, so one
aggregate anywhere upstream turns every edge below it into metrics forever.
Fixed by dropping the aggregate weight on fan-in from 0.7 to 0.35 and letting
45% of aggregates (dedupe/window, as opposed to rollup/count/sum) pass their
input type through. Now: records 57%, metrics 24%, errors 16%, events 3%.

I would not have noticed this from the 50-node fixture, where it looks fine.
Generating all four sizes and printing the distribution caught it in one run —
worth doing before trusting any fixture generator.

**Generation is not the bottleneck anywhere.** 10k nodes + 14.7k edges:
generate 56ms, index + layout ~5ms, validate ~10ms. All of it comfortably
one-off. Whatever hurts later, it will not be this.

**The 10k fixture is 11,720 × 34,036 graph units** with the naive layout — a very
tall ribbon, because 40 layers over 10k nodes means columns of ~250 nodes. Worth
remembering when ELK produces something differently shaped in phase 2; the
culling work in phase 5 is going to matter more in the vertical direction.

### Measured (Node 24, this machine)

| nodes  | edges  | layers | sources | sinks | max in | max out | generate | index+layout | validate |
|--------|--------|--------|---------|-------|--------|---------|----------|--------------|----------|
| 50     | 79     | 8      | 2       | 2     | 5      | 6       | ~0.6 ms  | ~0.3 ms      | ~0.7 ms  |
| 500    | 738    | 17     | 6       | 6     | 5      | 6       | ~2 ms    | ~1 ms        | ~1.5 ms  |
| 2,000  | 2,944  | 25     | 11      | 11    | 6      | 7       | ~6 ms    | ~2 ms        | ~2 ms    |
| 10,000 | 14,739 | 40     | 24      | 24    | 6      | 8       | ~40 ms   | ~6 ms        | ~10 ms   |

All four validate as DAGs with zero errors.

### Open questions for phase 2

- Worker message protocol: fire-and-forget with a request id, or a full
  request/response channel with cancellation?
- Bezier vs orthogonal edge routing — ELK can route edges itself, which changes
  what the canvas renderer draws in phase 3.
- Whether ELK should see the whole graph with most nodes pinned, or only the
  dirty subgraph as a standalone problem.

---

## Phase 2 — layout worker

### What landed

```
src/lib/layout/protocol.ts     typed-array message protocol
src/lib/layout/elk.worker.ts   the worker (messaging only)
src/lib/layout/elk-adapter.ts  protocol <-> ELK object graph, testable on its own
src/lib/layout/client.ts       main-thread handle: cancel, recycle, retry
src/lib/layout/options.ts      ELK presets, measured
src/lib/layout/jobs.ts         graph -> flat arrays
src/lib/layout/incremental.ts  dirty region, translation fitting
src/lib/layout/animate.ts      position tweening
src/lib/graph/mutate.ts        append-only structural edits
src/lib/state/session.svelte.ts  all graph state and operations
src/lib/render/limits.ts       tunable render thresholds
```

### The three forks, decided

These were flagged at the end of phase 1 and settled here rather than left open.

**Worker protocol: one job at a time, cancel by terminating the worker.**
A worker is single-threaded and ELK cannot be interrupted, so a request/response
channel with a queue would mean a click on "50 nodes" waits behind a 4.6-second
10k layout nobody wants any more. Terminating is the only real cancellation
available. A request id is still carried and checked, because a terminated
worker's last message can still be in flight.

**Edge routing: bezier, ours, from our own port anchors.**
The deciding argument was not aesthetics, it was statelessness. A bezier is
derivable from two node positions and two port slots, so it costs nothing to
store, survives a node drag with no layout run at all (phase 4 needs exactly
that), and is trivial to re-derive mid-animation. ELK's orthogonal routing
returns bend points, which would have to be stored, transferred, animated,
culled and hit-tested as a second geometry system.

It had a side benefit I did not anticipate: ELK never needs to know that ports
exist. The 10k job is boxes and connections, ~30,000 fewer objects, and a
smaller problem for ELK to solve.

**Incremental: dirty region, with pinning enforced on our side.**
ELK has no per-node pin. The INTERACTIVE strategies treat existing coordinates
as *hints*, and will shift the whole result. So: lay out the changed nodes plus
two hops of neighbours, fit a single translation to the neighbours (least
squares, which for a pure translation is the mean offset), then apply ELK's
coordinates **only** to the changed nodes and discard the rest. An existing
node's position is never written, so it cannot drift at all.

Verified at both ends of the range — three stages added one at a time:

| fixture | full layout | region size | incremental elk | existing nodes moved |
|---------|-------------|-------------|-----------------|----------------------|
| 50      | 75 ms       | 4-7 nodes   | 4.4-5.1 ms      | 0 / 50               |
| 10,000  | 5,322 ms    | 5-7 nodes   | 3.8-14.9 ms     | 0 / 10,000           |

Max drift: exactly 0, at both sizes. That is the point of step three.

### What surprised me

**A warm elkjs instance intermittently blows the JS stack.** Three identical
10k layouts in one process: run 1 fine (4,786 ms), run 2 `Maximum call stack
size exceeded`, run 3 fine (4,578 ms). Same input, same options, same process.
It is not a size threshold — a *cold* instance does the same layout reliably.

This is the single finding that most changed the design. The client now recycles
the worker after any layout above 1,000 nodes, and retries a stack-overflow
error once on a fresh worker. Both are in `client.ts` with this note attached.
It also retroactively justifies the terminate-based cancellation: killing the
worker was already the cancel path, so the recycling costs nothing extra.

I lost about twenty minutes to this, because my first probe ran six option
variants in one process and `place=SIMPLE` failed — which looked like "that
option is broken at 10k". It is not. Run alone in a fresh process it completes
in 23 seconds. The failure was contamination from the preceding runs, and the
lesson is that benchmarking several large layouts in one process measures
something other than what you think.

**Node placement strategy controls aspect ratio, not speed — and it matters
enormously.** These are two genuinely independent knobs:

| 2,000 nodes                | time     | result size      |
|----------------------------|----------|------------------|
| default (BRANDES_KOEPF, thoroughness 7) | 2,227 ms | 22,656 x 68,678  |
| thoroughness = 1           | 684 ms   | 29,437 x 72,923  |
| nodePlacement = SIMPLE     | 2,002 ms | 10,590 x 10,771  |
| both                       | 632 ms   | 10,562 x 10,698  |

| 10,000 nodes               | time      | result size        |
|----------------------------|-----------|--------------------|
| default                    | 24,128 ms | 203,291 x 489,374  |
| thoroughness = 1           | 5,000 ms  | 263,196 x 451,828  |
| nodePlacement = SIMPLE     | 23,295 ms | 30,349 x 33,333    |
| both (shipped as `fast`)   | 4,579 ms  | 30,029 x 33,553    |

`thoroughness` buys time. `nodePlacement` buys shape. Brandes-Köpf aligns nodes
with their neighbours, which on a fan-out-heavy DAG produces a *489,000 pixel
tall* ribbon — a 15:1 aspect ratio that would make viewport culling nearly
useless in one axis and fit-to-screen meaningless. SIMPLE packs columns and
gives something roughly square. I would have picked `thoroughness` alone if I
had only looked at the clock.

**ELK is not buying us compactness.** The naive phase 1 column layout produces
11,720 x 34,036 at 10k — *more* compact than ELK's default and comparable to
the fast preset. What ELK buys is crossing reduction and sane layer assignment.
Worth being honest about, since it cost 4.6 seconds.

**Full ELK layout by fixture size** (`fast` preset, in-worker time):

| fixture | nodes  | edges  | elk layout |
|---------|--------|--------|------------|
| 50      | 50     | 79     | ~26 ms     |
| 500     | 500    | 738    | ~118 ms    |
| 2,000   | 2,000  | 2,944  | ~632 ms    |
| 10,000  | 10,000 | 14,739 | ~4,600 ms  |

Roughly linear in node count up to 2,000, then worse. The `benchmark all` button
in the header runs this live.

### Smaller decisions

**Typed arrays across the thread boundary.** The protocol carries eight
ArrayBuffers, transferred rather than cloned. The alternative is structured
cloning ~25,000 small objects each way per 10k layout. Nodes are identified by
their index in `graph.nodes`, never by id, and the worker stringifies indices
for ELK — so every string allocation stays inside the worker.

**Node indices are append-only.** `mutate.ts` enforces it. This is what lets
`PositionStore.resized()` be a prefix copy, lets an incremental layout name its
dirty set by index, and will let phase 4 patch the quadtree instead of
rebuilding it. Splicing into the middle would invalidate every index held
anywhere in the app.

**The naive layout stayed.** It runs synchronously on fixture load so there is
something on screen in the same frame, rather than an empty view for however
long ELK takes. It earns its keep as a placeholder even though nothing uses it
as a layout any more.

**Two version counters, not one.** Positions live in Float32Arrays the animator
writes into directly, which Svelte cannot observe, so the SVG depends on a
counter. It needs *two*: `positionsVersion` every frame for geometry, and
`viewVersion` only when the graph settles, for the viewBox. Deriving the
viewBox per frame rescales the viewport in lockstep with the nodes — which makes
moving nodes look stationary and hides the exact thing the animation exists to
show. A small thing that took a minute to see and would have been invisible in a
screenshot.

### Known limitations, carried forward

- A new node is placed relative to its neighbours with no knowledge of the rest
  of the graph, so it can land on top of an unrelated node. The honest fix is a
  local overlap-removal pass after splicing.
- Incremental *layout* is sub-linear, but `buildGraphIndex` and `validateGraph`
  still run over the whole graph on every add — ~16 ms at 10k. Patching the
  index incrementally is the obvious next step if that ever shows up in the HUD.
- The SVG stopgap rebuilds two full arrays of strings on every animation frame.
  At 500 nodes that is 500 template literals per frame. Phase 3 deletes it.
- **Not verified in a browser.** This session has no browser tooling. Typecheck,
  production build (the worker emits as its own 1.4 MB chunk, out of the main
  bundle), dev-server module transform, and the complete layout/incremental
  logic against real ELK in Node all pass. The rendering itself is unconfirmed
  until phase 9's Playwright tests.

---

## Phase 3 — hybrid renderer

### What landed

```
src/lib/render/viewport.ts         the one transform; pure arithmetic
src/lib/render/frame.ts            rAF coalescing
src/lib/render/scene.ts            grid + edges + ports on canvas
src/lib/render/edge-buckets.ts     edges grouped by colour, once per graph
src/lib/render/edge-geometry.ts    rewritten allocation-free
src/lib/render/hybrid-renderer.ts  canvas + DOM layer, input, DPR, sizing
src/lib/render/perf.svelte.ts      HUD numbers
src/lib/components/GraphCanvas.svelte
src/lib/components/PerfHud.svelte
src/lib/layout/elk-inline.ts       runs ELK inline in our worker (see below)
```

`GraphSvg.svelte` is gone.

### d3-zoom vs hand-rolled: hand-rolled

Not a close call, and for one concrete reason rather than a taste argument.
`d3-zoom` resolves pointer positions through `d3.pointer()`, which calls
`node.getBoundingClientRect()` on **every event**. Requirement 4 says no layout
reads inside pointer handlers, and that is exactly a layout read, on the hottest
path there is.

The hand-rolled version avoids it twice over: panning uses deltas between
successive events, so it never needs to know where the surface is at all, and
wheel-zoom uses a surface origin cached by a `ResizeObserver`. `viewport.ts` is
about 80 lines, touches no DOM, and is pure arithmetic — which is also what made
it straightforward to verify:

```
zoom k=0.05..3, factor x0.1..x4, anchors cursor    drift 0.0e+0 (worst 5.7e-14)
fit 2248x788 / 30029x33553 / 10x10                 centred and contained
grid step within 24..96 px across the whole range  bounded at 45 lines
```

`Viewport` is also deliberately **not** reactive. It is written several times
per frame by pointer handlers and read by imperative draw code; `$state` would
add proxy overhead to the hottest path and buy nothing, since no template
derives from it. The perf monitor is the bridge — it publishes a summary into
`$state` at 5Hz so the HUD can render it.

### What surprised me — the phase 2 worker never worked in a browser

I flagged at the end of phase 2 that I had no browser tooling and the rendering
was unverified. It turns out the *worker* was broken too, and every measurement
I took was from an environment that cannot expose it.

The dev-server log had been collecting, once per page load:

```
TypeError: _Worker is not a constructor
```

Root cause: `elkjs/lib/elk.bundled.js` is browserified from elkjs's **Node**
entry point — its own package.json says so
(`browserify build/js/main-node.js ... --outfile lib/elk.bundled.js`). That
entry's constructor does:

```js
const Worker = require('./elk-worker.min.js').Worker;
workerFactory = (url) => new Worker(url);
```

and `elk-worker.min.js` only exports `.Worker` when `self` is undefined. When
`self` exists it assumes it is being loaded *as* the worker script, installs
`self.onmessage`, and exports nothing. So the factory calls `new undefined()`.

**Node has no `self`.** That single fact is why four rounds of benchmarking, an
end-to-end incremental-layout verification at 10,000 nodes, a clean typecheck
and a clean production build all passed while the app could not lay out a single
graph in a browser. The environment I could measure in was the only environment
where the bug does not exist.

I reproduced it deliberately before fixing it, by defining `self` in Node:

```
global present, no self/Worker  ->  ok
global present + self + Worker  ->  FAILED: _Worker is not a constructor
no global, self, no Worker      ->  FAILED: _Worker is not a constructor
```

The fix (`elk-inline.ts`) stops fighting elk-worker's self-installation and uses
it: let it install its handler on our worker scope, take that handler, hand it
back to `elk-api` wrapped in a worker-shaped object via the **public**
`workerFactory` option, and let elk-api drive its own protocol across it. No
second thread, no nested worker, and no message shapes reverse-engineered from
elkjs internals. The one subtlety is that ELK replies by calling
`self.postMessage`, so that function now belongs to ELK and our worker replies
through a `postToHost` handle captured before the swap.

Verified by driving the real `elk.worker.ts` through the real protocol inside
the reproduction scope:

```
n=   50  ok   returned 50/50    elk  67ms  extent  2161x758
n=  500  ok   returned 500/500  elk 148ms  extent  5478x3875
n= 2000  ok   returned 2000/2000 elk 595ms extent 10374x10588
```

595ms at 2,000 against 632ms through the old path — the inline route costs
nothing. The 10k incremental check still reports **0 of 10,000 existing nodes
moved, max drift 0**.

**The lesson I am taking from this**: "verified everywhere except the target
environment" is much closer to "unverified" than the amount of green output
suggested. The first thing phase 9 should test is the worker, and the technique
is cheap — define `self` on `globalThis` in Node and the browser code path
becomes reachable. That single shim turns an unreachable class of bug into an
ordinary unit test.

### Canvas decisions

**Batch by colour, not by edge.** `strokeStyle` is a canvas state change, and
the naive loop (begin path, set colour, stroke — per edge) costs ~14,700 stroke
calls per frame at 10k. Grouping edges by data type into `Int32Array` buckets
once per graph, then accumulating one path per colour, costs four. Measured
draw-call counts per frame, with a stub context:

| fixture | beziers | strokes | fills | port rects |
|---------|---------|---------|-------|------------|
| 50      | 79      | 5       | 4     | 119        |
| 500     | 738     | 5       | 4     | 1,246      |
| 2,000   | 2,944   | 5       | 4     | 4,958      |
| 10,000  | 14,739  | 5       | 4     | 24,800     |

Five and four, flat, at every size. (The fifth stroke is the grid.)

**Edge geometry is allocation-free.** The phase 1 API returned
`{from, to, c1, c2}` — five objects per edge, so ~74,000 short-lived objects per
frame at 10k. Rewritten to fill one reused struct. The cost of allocating is not
really the allocating; it is the GC pauses, which appear as exactly the frame
spikes the HUD exists to catch.

**Ports are drawn on the canvas, not on the node elements.** An edge endpoint
and the dot it lands on are the same geometry, and drawing them from the same
numbers is the only way to guarantee they never disagree. It also removes ~4
elements from every node — 8,000 fewer DOM nodes at the 2,000-node fixture.

**JavaScript cost per frame** (our code only — rasterisation is the browser's
and is *not* included; these are a floor, not a frame time):

| fixture | zoom (fit) | median | p90    |
|---------|-----------|--------|--------|
| 50      | 0.669     | 0.06ms | 0.15ms |
| 500     | 0.196     | 0.16ms | 0.28ms |
| 2,000   | 0.071     | 0.79ms | 0.90ms |
| 10,000  | 0.024     | 3.44ms | 4.41ms |

3.44ms of a 16.7ms budget at 10k, before the browser rasterises a single pixel —
and every bit of it is currently uncullable. That is phase 5's whole case.

**The DOM layer transform is written in the same rAF callback as the canvas
draw.** If the layer were positioned through Svelte's reactivity it could land a
frame after the canvas, and nodes would visibly lag their own edges during a
pan. Putting both writes in one callback makes that impossible by construction —
it is the main reason `HybridRenderer` is a class rather than logic in the
component.

**The node layer is `pointer-events: none`.** All interaction goes through the
surface and, from phase 4, the quadtree — never through a node's own event
target. That keeps the interaction model identical whether nodes happen to be
DOM elements or canvas pixels, which matters a lot once phase 5 makes that
switch at runtime.

### Smaller things

- `MIN_ZOOM` is nearly binding at 10k: fitting a 30,029 x 33,553 graph into a
  1440x820 viewport needs k = 0.0216 against a floor of 0.02. Worth remembering
  before lowering the floor for any reason.
- The HUD publishes at 5Hz rather than per frame. An instrument that re-renders
  60 times a second is itself a workload and would partly be measuring its own
  cost.
- `viewVersion` from phase 2 is deleted. It existed to stop the SVG viewBox
  rescaling mid-tween; the canvas renderer owns framing now, so it was dead.
- Grid spacing subdivides by 4 to stay between 24 and 96 screen pixels, which
  also bounds the line count at ~45 however far out you zoom. `gridStep` is
  exported purely so that bound can be checked without a canvas — an unbounded
  loop there would hang the frame rather than merely look wrong.

### Not verified

Still no browser tooling in this session, so I have not seen a frame rendered.
What *is* now verified, which was not before: the worker runs ELK correctly in a
browser-shaped scope, end to end, through the real protocol. The HUD numbers —
actual FPS, actual frame time including rasterisation — can only come from your
browser.

---

## Phase 4 — interaction

### What landed

```
src/lib/interact/quadtree.ts         d3-quadtree over node bounds
src/lib/interact/bezier.ts           adaptive distance-to-cubic
src/lib/interact/hit-test.ts         picking: nodes, edges, marquee-implied edges
src/lib/interact/selection.svelte.ts flag arrays + a reactive summary
src/lib/interact/controller.ts       the gesture state machine
```

`hybrid-renderer.ts` gave up its pan logic and became purely DOM plumbing.
`scene.ts` gained selection rings, a selected-edge pass and the marquee box.
`session.svelte.ts` owns the quadtree and its rebuild policy.

### The binding, decided with you

```
empty + drag        pan                 node + drag         move the selection
empty + shift-drag  marquee (additive)  node + shift-click  toggle
empty + click       clear               edge + click        select the edge
middle-drag         pan, always         edge + drag         pan
```

Pan keeps the unmodified left-drag because at 10,000 nodes navigation is the
thing you do constantly and selection is the thing you do occasionally. The
cost is that a marquee which *replaces* the selection is not reachable in one
gesture — you shift-drag, then click empty space to reset.

### Decisions

**The quadtree stores node indices, not node objects.** `d3-quadtree` only
touches its datum through the x/y accessors, so the datum can be the integer
index and the accessors can read straight out of the position Float32Arrays.
Inserting `{id, x, y}` records instead would allocate a 10,000-object shadow of
the graph that exists purely to be clicked on — the exact pointer-chasing the
phase 1 position layout was chosen to avoid.

**d3-quadtree indexes points; our nodes are rectangles.** A node is indexed by
its top-left corner, so every query is widened by the largest node's size before
pruning and every survivor is re-tested against its real bounds. Verified
exhaustively against a brute-force scan rather than argued about — see below.

**Selection lives in `Uint8Array` flags, and is drawn on the canvas.** This is
the phase 4 decision I'd defend hardest, and it is the same shape as the
structure/dynamics split: bulk per-node data stays out of the proxy, a summary
crosses into `$state` for the UI. Three consequences:

 - The draw loop asks "is this selected?" with an array read, not a hash lookup
   through a proxy.
 - A marquee sweeping the 2,000-node fixture touches Svelte's reactivity
   **zero** times. Had nodes carried a `.selected` class, every marquee frame
   would re-evaluate 2,000 class bindings, and the marquee is the one gesture
   that changes selection at 60fps.
 - Selection rendering does not change at all in phase 5. It never depended on
   there being an element, so a canvas-drawn node gets selection for free.

Selection rings are drawn *outside* the node bounds for the same reason — a ring
under an opaque DOM node would be invisible, a ring around it works in either
render mode.

**Gesture meaning was split out of the renderer.** `HybridRenderer` now
normalises DOM events into surface-local coordinates (using the cached origin)
and hands them to an `InputTarget`; `InteractionController` decides what they
mean and touches no DOM at all. That is not tidiness — it is what made the
34-check gesture harness below possible in Node, and it makes the no-layout-read
rule structurally enforceable, because the half of the code that decides things
has no element to measure.

**A drag writes straight into the position Float32Arrays.** No new
`PipelineGraph`, no layout run, and *nothing done to the edges at all*. Edges
are re-derived from node positions every frame, so they follow a drag for free.
This is the phase 2 bezier decision paying off exactly as predicted — had ELK's
orthogonal bend points been stored, every drag frame would have to re-route.

**The quadtree is rebuilt only when geometry settles**: after a layout tween's
final frame, after a snap, after a drag ends, after a structural change. Never
per animation frame. The `_done` callback that phase 2 left unused is what this
hangs off.

### What surprised me

**The bezier hit test was wrong, and the test caught it, not the eye.**

I wrote the distance function with a fixed 16-segment flattening and a
comfortable-sounding justification ("our edges are shallow near-horizontal
S-curves"). Checked against a 4,096-segment reference, the worst error was
**5.76 graph units** against a 10-unit tolerance — more than half the slop, gone
to chord error. Points sitting exactly *on* the curve read as 0.84 units off it.

The premise was simply false. `controlOffset` caps the horizontal pull at 220
units, but a layered layout puts columns thousands of units apart vertically, so
a long edge is a steep, tightly-curved S — the highest-curvature shape in the
fixture, not the shallowest. I had described the edges I imagined rather than
the ones the generator makes.

The fix turned out to be better than the thing it replaced. The caller already
passes a tolerance; that tolerance can set the segment count:

```
error <= 6 * bend / (8n²)   ->   n = ceil(sqrt(3 * bend / (4 * error)))
```

where `bend` is the larger of the two second differences of the control polygon
— two subtractions each. Budget a quarter of the tolerance for chord error and
the count falls out. Measured on the 500-node fixture:

| zoom | tolerance | segments avg / max | worst error | budget |
|------|-----------|--------------------|-------------|--------|
| 3    | 3 u       | 25.5 / 57          | 0.79 u      | 0.83 u |
| 1    | 10 u      | 14.9 / 33          | 2.31 u      | 2.50 u |
| 0.25 | 40 u      | 7.8 / 17           | 8.12 u      | 10.0 u |
| 0.05 | 200 u     | 4.5 / 8            | 24.5 u      | 50.0 u |
| 0.02 | 500 u     | 4.0 / 5            | 31.3 u      | 125 u  |

Within budget everywhere, and it made edge picking at 10k *faster* (1.64 ms →
1.48 ms), because zoomed out — where the tolerance is enormous and most picking
happens — four segments is plenty. A fixed count was wrong in both directions
simultaneously: too coarse where it mattered, wasteful where it didn't.

**Committing a selection on pointerdown is wrong when edges are dense.** The
gesture harness failed on a marquee test, and the cause was not the marquee: my
test happened to press on a point that was within 10px of an edge, so
pointerdown selected the edge and the marquee never started.

That is not a test artefact. With a 10px pick tolerance at the 10,000-node
fixture, an edge is within tolerance of most of the canvas. Committing edge
selection on press meant that *starting a pan usually selected an edge*, and
*shift-dragging to marquee usually selected an edge instead*. Edge selection now
waits for release: pressing on an edge begins the same gesture as pressing on
empty space, and only a press that never moves is treated as having meant the
edge. Nodes still commit on press, because you have to select a node to drag it.

I would not have found this by clicking around the 50-node fixture, where the
canvas is mostly empty and the bug is invisible.

**One node selected costs nothing; everything selected costs a whole frame.**
The `nodeCount === 0` / `edgeCount === 0` guards make the common case exactly
free, and scanning 10,000 flags for a single selected node is ~5 µs. But a
full-graph marquee re-strokes every edge in a second pass:

| fixture | selection  | draw (median) | overhead |
|---------|------------|---------------|----------|
| 2,000   | none       | 0.46 ms       | —        |
| 2,000   | 1 node     | 0.45 ms       | +0.00 ms |
| 2,000   | everything | 0.86 ms       | +0.41 ms |
| 10,000  | none       | 2.47 ms       | —        |
| 10,000  | 1 node     | 2.47 ms       | +0.00 ms |
| 10,000  | everything | 4.62 ms       | +2.15 ms |

Selecting everything at 10k nearly doubles our JavaScript per frame. The marquee
box itself is two draw calls and free. Stroke count per frame stays flat at 7
(grid, four data types, selected edges, selection rings) however much is
selected — the phase 3 batching survives.

These are our JS only, with a stub context; rasterisation is the browser's and
is not included. They also use the placeholder layered layout, so they are not
directly comparable to phase 3's ELK-layout figures — only to each other.

**The edge scan has no spatial index and does not need one.** Deliberate: an
edge index would have to be rebuilt on every drag frame, since moving one node
invalidates every edge touching it. The control-hull box test rejects nearly all
14,739 edges with four comparisons, and picking only happens once per click.

### Measured

Correctness, against brute force (`verify-interact.ts`, 4,000 sampled points and
200 random rectangles per fixture):

```
findNode   n=50/500/2000/10000    0 mismatches   (~2,400 of 4,000 are hits)
queryRect  n=50/500/2000/10000    0 mismatches
coincident stack of 50 nodes      topmost returned; all 50 found
```

That last one matters: d3-quadtree chains exactly-coincident points into a
linked list on one leaf rather than subdividing forever, and a layout mid-tween
can stack nodes precisely. Reading only `leaf.data` and not walking `leaf.next`
would silently lose them — it is the one thing in the file that looks like
boilerplate and isn't.

Cost:

| fixture | tree build | findNode (hit) | edge pick (miss) | marquee frame | drag write |
|---------|-----------|----------------|------------------|---------------|------------|
| 50      | 0.00 ms   | 0.3 µs         | 0.00 ms          | 0.00 ms       | 0.002 ms   |
| 500     | 0.03 ms   | 0.4 µs         | 0.04 ms          | 0.02 ms       | 0.016 ms   |
| 2,000   | 0.14 ms   | 0.5 µs         | 0.21 ms          | 0.08 ms       | 0.066 ms   |
| 10,000  | 0.83 ms   | 0.7 µs         | 1.49 ms          | 0.50 ms       | 0.073 ms   |

`findNode` is essentially flat from 50 to 10,000 nodes — 0.3 µs to 0.7 µs for a
200x increase — which is the quadtree doing its job. The marquee frame is a
query plus the implied-edge scan, catching 1,818 nodes at the 10k fixture.
"Drag write" is select-everything-then-drag, the worst case.

The gesture state machine passes 34 checks in `verify-gestures.ts`, driving the
real controller and the real selection store with `$state` shimmed to identity:
click/shift-click/toggle, pan by screen delta, drag at 0.25x zoom moving 4 graph
units per pixel, rigid multi-node drag, sub-threshold movement staying a click,
cancelled drag restoring positions exactly, marquee normalisation dragging up
and left, shrink-deselects, and both-endpoints-inside for implied edges.

### Known limitations, carried forward

- ~~**Still not verified in a browser.**~~ Resolved at the start of phase 5:
  you confirmed phases 1-4 run correctly in a browser. Three phases of "verified
  everywhere except the target environment" closed out with no further defects
  beyond the elkjs one phase 3 already found.
- The quadtree is stale during a layout tween (420 ms), so a click mid-animation
  can pick the wrong node. Rebuilding per frame costs more than the tween does.
- `writeEdgeGeometry` does two `Map.get` calls per edge per frame — 29,478 at
  the 10k fixture, in the main draw loop, and again in every edge pick. An
  `Int32Array` of endpoint node indices per edge would remove all of them. This
  is the most obvious remaining win and phase 5 should take it.
- A drag can drop a node on top of another; there is no overlap resolution, same
  as the incremental-layout limitation from phase 2.
- Marquee edge selection rescans all edges per frame. At 10k that is inside the
  0.50 ms figure above, so it is not urgent, but it is linear in edges rather
  than in what the box caught.
- No hover feedback and no cursor change over a node. Not asked for, and it
  would mean a hit test on every pointermove plus a redraw to show it.

---

## Phase 5 — culling and semantic zoom

You confirmed phases 1-4 work in a browser before this phase started, which
closes the caveat that had been carried since phase 2.

### What landed

```
src/lib/render/edge-anchors.ts   per-edge endpoints, resolved once per graph
src/lib/render/cull.ts           view rect, node culling, edge visibility
src/lib/render/nodes.ts          canvas node rendering, all three detail tiers
src/lib/render/limits.ts         zoom tiers and the cull margin
src/lib/render/visible.svelte.ts the culled list, bridged into Svelte
```

`scene.ts` culls in every loop and switched to anchors. `hybrid-renderer.ts`
decides the tier and the render mode once per frame. `hit-test.ts` and
`edge-geometry.ts` lost their map lookups. `GraphCanvas.svelte` renders only
the culled nodes. The HUD gained visible edges, the detail tier, and whether
nodes are coming from the DOM or the canvas.

### Decisions

**Culling is a linear scan, not a quadtree query.** We already have a quadtree
over exactly these bounds, and it would answer in O(log n + k) instead of O(n).
It is still the wrong tool here, for two reasons. It is deliberately *stale*
during a layout tween and during a drag — rebuilt only when geometry settles —
so culling from it would make a dragged node vanish. And the constant dominates:
10,000 Float32Array reads and four comparisons is about 10 µs, while the work
culling removes is ~15,000 `bezierCurveTo` calls and ~25,000 port rects. The
scan stays O(n) and the *work* becomes O(visible), which is the right way round,
because n is bounded by the fixture and the per-object work is bounded by the
screen.

**Two independent roads lead to canvas nodes.** Nodes leave the DOM when there
are more than 2,000 of them *or* when zoom drops below the full tier. The second
is the one I did not anticipate needing: the DOM layer is not merely a
small-graph path, it is the *zoomed-in* path. Both roads work without touching
interaction, because nothing has ever gone through a node element.

**"Culling off" is an unbounded view rectangle, not a second code path.** The
two HUD checkboxes had to produce numbers comparable with phase 4's, and the
only way to be sure of that is for the draw loops not to know which mode they
are in. Off means `left: -Infinity`, and every loop runs exactly as it did.

**Edge endpoints moved into flat arrays.** Phase 4's notes flagged
`writeEdgeGeometry`'s two `Map.get` calls per edge per frame — 29,478 at 10k, in
the main draw loop — as the obvious remaining win. Culling forced the issue,
because a cull test can only be cheaper than drawing if the endpoint lookup is
nearly free. Port offsets are structural (slot, port count and node height never
change without the graph changing), so everything except the node's position
resolves once per graph.

**At the coarsest tier edges run centre to centre.** Not a performance decision
— a correctness one, and a bug I nearly shipped. Below quarter zoom nodes are
drawn as dots at their centre, but edges still terminated at ports on the node's
left and right edges, so every line stopped half a node width short of the dot
it was aiming at: about twenty screen pixels of line ending in empty space. The
cull test takes a `straight` flag for the same reason — culling one geometry
while drawing another is how edges flicker out at the viewport edge.

### What surprised me

**Culling does nothing at fit-to-screen, which is when there is most to draw.**
Obvious in hindsight and slightly humbling: fit means everything is on screen,
so the visible count is 10,000 / 10,000 and the cull test is pure overhead.

| 10,000 nodes, fit (0.021x) | draw   |
|----------------------------|--------|
| culling off, semantic off  | 1.61 ms |
| culling on, semantic off   | 1.62 ms |
| culling on, semantic on    | 0.77 ms |

Culling costs 0.01 ms and buys nothing. **Semantic zoom is the entire win in
that case** — a 2.1x improvement, and it comes from not drawing things that were
never legible. The two mechanisms turn out to cover disjoint situations: culling
pays when you are zoomed in, semantic zoom pays when you are zoomed out, and
there is no zoom at which both matter much. I had assumed they would compound.

**Edge culling is far less selective than node culling.** At 10k, zoom 1.0:

```
nodes drawn      81 / 10,000    0.8%
edges drawn   1,867 / 14,739   12.7%
```

A sixteen-fold difference. The cause is that a bezier's axis-aligned bounding
box is a poor proxy for a diagonal curve — an edge running from far above-left
to far below-right has a box covering the whole viewport while the curve only
crosses one corner of it. Tightening this would mean a fattened segment/rect
test per edge instead of four comparisons. Not worth it at 0.20 ms, but it is
the reason the edge number never gets as good as the node number, and it would
be the first thing to look at if edges ever dominated a frame again.

**The anchors refactor helped picking more than drawing.** I did it for the draw
loop and for culling. The larger effect was somewhere I was not optimising:

| 10,000 nodes      | phase 4 | phase 5 |
|-------------------|---------|---------|
| edge pick (miss)  | 1.49 ms | 0.26 ms |
| marquee frame     | 0.50 ms | 0.12 ms |

5.7x and 4.2x. Edge picking scans every edge, so it was paying the same 29,478
map lookups as the draw loop, once per click — and the marquee's implied-edge
pass was paying it every frame of a drag. A single change to how endpoints are
stored moved three unrelated call sites at once, which is the argument for
having had exactly one definition of edge geometry.

**Fit-to-screen lands in the dot tier at every fixture size**, including 50
nodes. Fit zoom is 0.021x at 10k, 0.064x at 2,000 and 0.177x at 500, all below
the 0.25 threshold the brief specified. So the default view on load is dots, at
every size. That is what "below ~0.25, draw nodes as dots" means for graphs
shaped like ours, and it is worth knowing before deciding the threshold is
right — `ZOOM_DOT` in `limits.ts` is one constant if you want boxes on load.

### Before and after

Our JavaScript per frame, 1440x820 viewport, stub context — rasterisation is the
browser's and is not included, so these are a floor and a ratio rather than
frame times. "off/off" is exactly the phase 4 draw loop.

**2,000 nodes, 2,944 edges** (fit = 0.064x)

| zoom | cull | semantic | draw    | nodes drawn | edges drawn | tier   | via    |
|------|------|----------|---------|-------------|-------------|--------|--------|
| fit  | off  | off      | 0.34 ms | 2,000/2,000 | 2,944/2,944 | full   | dom    |
| fit  | on   | on       | 0.17 ms | 2,000/2,000 | 2,944/2,944 | dot    | canvas |
| 0.25 | off  | off      | 0.22 ms | 2,000/2,000 | 2,944/2,944 | full   | dom    |
| 0.25 | on   | on       | 0.16 ms | 1,158/2,000 | 2,473/2,944 | simple | canvas |
| 0.5  | off  | off      | 0.22 ms | 2,000/2,000 | 2,944/2,944 | full   | dom    |
| 0.5  | on   | on       | 0.09 ms |   345/2,000 | 1,256/2,944 | full   | dom    |
| 1.0  | off  | off      | 0.22 ms | 2,000/2,000 | 2,944/2,944 | full   | dom    |
| 1.0  | on   | on       | 0.05 ms |    95/2,000 |   568/2,944 | full   | dom    |

**10,000 nodes, 14,739 edges** (fit = 0.021x)

| zoom | cull | semantic | draw    | nodes drawn   | edges drawn   | tier   | via    |
|------|------|----------|---------|---------------|---------------|--------|--------|
| fit  | off  | off      | 1.61 ms | 10,000/10,000 | 14,739/14,739 | full   | canvas |
| fit  | on   | on       | 0.77 ms | 10,000/10,000 | 14,739/14,739 | dot    | canvas |
| 0.25 | off  | off      | 1.62 ms | 10,000/10,000 | 14,739/14,739 | full   | canvas |
| 0.25 | on   | on       | 0.48 ms |  1,249/10,000 |  6,948/14,739 | simple | canvas |
| 0.5  | off  | off      | 1.63 ms | 10,000/10,000 | 14,739/14,739 | full   | canvas |
| 0.5  | on   | on       | 0.31 ms |    316/10,000 |  3,563/14,739 | full   | canvas |
| 1.0  | off  | off      | 1.98 ms | 10,000/10,000 | 14,739/14,739 | full   | canvas |
| 1.0  | on   | on       | 0.20 ms |     81/10,000 |  1,867/14,739 | full   | canvas |

Zoomed in at 10k: **1.98 ms to 0.20 ms, a 10x reduction.** Zoomed out: 2.1x,
all of it semantic zoom. The 1.98 ms "off" row is higher than the 1.63 ms at 0.5
because full-detail canvas nodes mean 10,000 `fillText` calls for labels that
are mostly off screen.

Phase 4 found that selecting everything cost +2.15 ms at 10k, because the
selected-edge pass re-strokes every edge. Culling bounds it:

| 10,000 nodes, everything selected, 1.0x | draw    |
|-----------------------------------------|---------|
| off / off                               | 2.89 ms |
| on / on                                 | 0.49 ms |

### Verified

`npm run verify` — all checks pass at every fixture size:

```
unbounded view keeps every node          50 / 500 / 2,000 / 10,000
cullNodes vs brute force                 100 viewports each, 0 mismatches
edgeVisible bezier    n=10,000           84,240 tests, 72,532 rejected, 0 false rejects
edgeVisible straight  n=10,000           84,240 tests, 70,349 rejected, 0 false rejects
```

The edge-culling test asserts in both directions — zero false rejects proves
correctness, and a partial accept rate proves the rejecting path was exercised
rather than the test being vacuous. The first version of that test sampled
viewports from an arbitrary coordinate range, mostly missed the graph entirely,
and reported "0 kept on average" while passing. Worth checking that a test can
fail before trusting that it passed.

### Known limitations, carried forward

- Edge culling accepts ~16x more than node culling, for the AABB reason above.
- The DOM node list crosses into Svelte's reactivity, so a node *entering* the
  viewport appears one frame late. Position never lags — that still comes from
  the shared transform in the rAF callback — and the 160px cull margin is many
  frames of runway at any plausible pan speed. Worth knowing it is there.
- Canvas-drawn nodes mean a status change repaints the whole canvas. Requirement
  3 asks for a status change to repaint one node and never trigger a full canvas
  redraw, which is satisfiable for DOM nodes and *not* for canvas ones without
  dirty rectangles. Phase 6 has to decide what that requirement means above the
  DOM limit; my current guess is per-frame batching plus the existing culling,
  since only visible nodes are drawn at all.
- Detail tiers are chosen from zoom alone. Density would be a better signal — a
  sparse graph at 0.3x is perfectly readable as boxes — but zoom is the thing
  the brief specified and the thing a user can predict.

---

## Phase 6 — streaming updates

### What landed

```
src/lib/graph/dynamics.svelte.ts   typed arrays + lazy per-node reactive cells
src/lib/stream/source.ts           mock feed, seeded, timer-driven
src/lib/stream/batcher.svelte.ts   one flush per frame, and the HUD numbers
src/lib/components/GraphNode.svelte  one node, one subscription
```

`hybrid-renderer.ts` gained `isVisible()` over the cull flags and
`repaintNodes()`. `mutate.ts` stopped threading dynamics through structural
edits. The HUD grew a streaming block.

### The fork, decided

Requirement 3 asks that a status change repaint one node and never trigger a
full canvas redraw. For DOM nodes that is literal. For canvas-drawn nodes there
is no such thing as repainting one, and you chose: redraw the already-culled
scene once per frame, only when a *visible* node changed. Dirty rectangles lose
to the fact that edges and the grid pass under every node; a second canvas layer
would save ~0.15 ms of a 0.20 ms frame and cost a second backing store at DPR.

### Decisions

**The data is written immediately; only the notification is batched.** An update
writes two typed-array slots and marks a byte. No proxy, no signal, no
allocation. Once per frame the dirty nodes are notified. A node updated fifty
times between two frames is notified once, and the value that survives is simply
the last one written — coalescing falls out of the storage rather than being
implemented.

**Reactivity is allocated per node, lazily.** A `$state` array of
`{status, throughput}` objects would be 10,000 proxies, and worse, every node is
subscribed to by the same `{#each}` — so one write invalidates the whole list.
An array of objects cannot express "repaint one node" however it is wrapped. One
signal per node allocated up front is 10,000 signals serving at most a few
hundred elements. Cells are created on first `view()` and kept, so the count
converges on "nodes that have ever been on screen", which the cull margin
already bounds.

**The component boundary *is* the granularity.** `GraphNode.svelte` exists for
one reason: `dynamics.view(index)` inside it subscribes that component and
nothing else. The same code inline in the parent's `{#each}` would put every
node's status read in one reactive scope. Position stays a prop, because
position genuinely does change for every node at once during a tween.

**Visibility is checked when the update arrives**, against the flag array the
cull pass already maintains — `isVisible` is one `Uint8Array` read. That is what
makes an off-screen update cost two writes and stop.

**The canvas is not touched at all while nodes are DOM elements.** `repaintNodes`
returns false in that mode. Nothing the canvas draws depends on status — edges
are coloured by data type, ports by port type, selection rings by selection — so
a status change at 2,000 nodes costs the canvas exactly zero. This is the
literal reading of requirement 3, and I nearly shipped the opposite (see below).

**The source is not driven by rAF.** A real feed is a socket delivering when the
network delivers, with no relationship to the display refresh, and absorbing that
mismatch is the batcher's entire job. Driving the mock from rAF would quietly
pre-batch the updates and make the batcher look like it was working when it was
not. It is a 10 ms timer, seeded like the fixture generator so a run replays.

### What surprised me

**Batching is free. The repaint is the entire cost.** I expected the
queue-and-coalesce path to be where the 200/second budget went. It is not close:

| rate      | updates/frame | queue   | flush   | total   | of 16.7 ms |
|-----------|---------------|---------|---------|---------|------------|
| 200/s     | 3             | 0.000 ms | 0.001 ms | 0.001 ms | 0.0% |
| 1,000/s   | 17            | 0.003 ms | 0.001 ms | 0.004 ms | 0.0% |
| 5,000/s   | 83            | 0.012 ms | 0.002 ms | 0.013 ms | 0.1% |
| 20,000/s  | 333           | 0.024 ms | 0.004 ms | 0.029 ms | 0.2% |

A hundred times the required rate is a fifth of one percent of a frame. All the
interesting behaviour is in what the flush *causes*, not in the flush.

**The repaint rate depends on zoom, not on the feed rate.** This is the finding
I would not have predicted, and it is really a phase 5 result arriving late. One
second of a ~200/s feed over the 10k fixture:

| visible         | updates | flushes | canvas redraws | frames drawn |
|-----------------|---------|---------|----------------|--------------|
| 81 / 10,000     | 260     | 60      | 2              | 3%           |
| 316 / 10,000    | 260     | 60      | 7              | 12%          |
| 1,249 / 10,000  | 260     | 60      | 28             | 47%          |
| 10,000 / 10,000 | 260     | 60      | 60             | 100%         |

Same feed, same batcher, 30x difference in redraws — decided entirely by where
the viewport is. Zoomed in, 260 updates a second produce **two** canvas frames.
Culling did not just make each frame cheaper; it made most frames not happen.
Worst case is fit-to-screen, where everything is visible and every frame
redraws — but that is the 0.77 ms dot tier, so 60 redraws a second is 4.6% of
the budget.

**I nearly shipped a canvas redraw on every DOM status change.** The batcher
called `repaint()` whenever a visible node changed, without asking whether the
canvas owned nodes. At the 2,000-node fixture — the case requirement 3 was
written about — that meant a status change re-stroked every visible edge to
produce pixels that could not possibly differ. Caught by writing the test that
asserts the opposite, not by reading the code. The fix is `repaintNodes()`
returning whether a frame was actually needed, which also makes the HUD's
`repaints` row read 0 while nodes are elements, so the property is visible
rather than merely true.

**Dropping dynamics from `mutate.ts` made it shorter and better.** Structural
edits were threading a dynamics array through purely to append one entry.
Removing it means a structural edit does not have to know telemetry exists — the
session grows the store. Three phases of insisting structure and dynamics are
separate, and the mutation API had quietly been coupling them the whole time.

### Verified

`npm run verify:stream` — 25 checks. `requestAnimationFrame` is shimmed so
frames are stepped by hand, which is the only reason "batched into one
frame-sized flush" is testable at all: it is a claim about frame boundaries, and
in a browser you cannot place them.

```
the value is readable before any frame runs
fifty updates to one node -> one frame, one notification, one repaint
three nodes touched nine times -> three notifications, [1, 2, 3]
a thousand off-screen updates -> zero repaints, zero cells, data still current
one on-screen update among a thousand -> exactly one repaint
only the changed node is notified, with both nodes rendered
DOM mode: 200 nodes notified, zero canvas frames
the graph object, the node objects and their shape are untouched
200/s emits 2 per 10ms tick; idle and failed stages report zero throughput
the same seed replays the same feed
```

The "structure is never touched" checks assert reference equality on the graph
and on a node object, and that no `status` or `throughput` field has appeared on
a `PipelineNode`. That is the phase 1 rule, finally enforced by something other
than my intentions.

### Known limitations, carried forward

- At fit-to-screen every node is visible, so every frame redraws while the feed
  runs. It is the cheap tier, so this is 4.6% of budget, but it is the one
  configuration where streaming and rendering do not decouple.
- Cell count grows monotonically as you pan — bounded by "nodes ever rendered",
  not by "nodes on screen". At the 2,000 DOM limit that is bounded by the
  fixture; nothing reclaims them.
- The source is a `setInterval`, so a background tab throttles it. The HUD shows
  the rate actually delivered rather than the rate requested, which is the right
  number but means the two can disagree.
- Throughput is stored as Float32. Rates reach ~10^5, where float32 resolves to
  about 0.01 — irrelevant for a displayed rate, worth knowing before summing
  them for a total in phase 7.
- A status change still repaints the canvas during a layout tween or a drag,
  when the canvas is redrawing every frame anyway. Harmless, but the `repaints`
  number over-attributes to the feed in those moments.

---

## Phase 7 — table pane

### What landed

```
src/lib/render/virtual.ts             windowing arithmetic, pure
src/lib/components/TablePane.svelte   resizable pane, scroller, resize handle
src/lib/components/NodeRow.svelte     one row, one subscription
```

`selection.svelte.ts` gained a `version` counter. `hybrid-renderer.ts` gained
`centreOn`. The session gained `selectFromTable` and `revealNode`.

### The 100,000-row requirement

The brief asks that 100,000 rows scroll smoothly. The largest fixture is 10,000,
because ELK takes 4.6 seconds on that and 100,000 is not a layout it can do at
all. So the number is checked where it is actually a claim about this code — the
windowing arithmetic, which has to be independent of row count:

| rows       | `windowFor` | rows rendered |
|------------|-------------|---------------|
| 1,000      | 0.023 µs    | 22            |
| 10,000     | 0.009 µs    | 22            |
| 100,000    | 0.021 µs    | 22            |
| 1,000,000  | 0.015 µs    | 22            |

Constant, in both columns, across four orders of magnitude. The app cannot show
you 100,000 stages, but the list is not what stops it.

### Decisions

**Fixed row height.** The load-bearing assumption: it makes "which rows are
visible" O(1) arithmetic rather than a cumulative-offset structure that has to
be maintained as rows change. Variable heights would need a prefix-sum tree and
a measurement pass and would buy nothing — every row holds the same four fields.
`ROW_HEIGHT` is defined once and applied as an inline style; the CSS is not
allowed a second opinion, because a one-pixel disagreement between the
arithmetic and the rendering accumulates into a whole row of drift a few
thousand down the list.

**The browser does the scrolling.** One empty spacer sized to the full list
gives the scrollbar its range; rows are absolutely positioned inside it. We only
answer "which rows are those". No transform tricks, no synthetic scrollbar, and
the result is a scroll that feels native because it is.

**Scroll events are coalesced into one frame**, with the same `FrameScheduler`
the pointer handlers use. A flick delivers scroll events faster than the display
refreshes; reading `scrollTop` once per frame is both cheaper and the only way
the rendered window can be consistent with what is painted.

**`scrollToIndex` returns null when the row is already visible.** This is the
whole of the bidirectional-selection problem, and it took one line rather than a
mechanism. The obvious implementation is an `isSyncing` boolean guarding a
feedback loop — table click sets selection, selection effect scrolls table,
scroll changes window, and so on. Making the function *idempotent* instead means
there is no loop to guard: clicking a row cannot make the list jump, because the
row you clicked is by definition visible. Verified by sweeping every clickable
row at every scroll position over a 100,000-row list — zero would have scrolled.

**The table needed no new streaming code at all.** A row calls
`dynamics.view(index)`, which is the same per-node cell the canvas nodes use. A
node that is on screen *in the table* gets a cell exactly the way one on the
canvas does, and a status change repaints one row out of the forty rendered.
This was the moment phase 6's design paid for itself: the second consumer cost
nothing.

### What surprised me

**The table is the first thing that needed selection to be reactive, and that
partly walks back a phase 4 claim.** Phase 4's notes say a marquee "touches
Svelte's reactivity zero times". That was true when only the canvas cared. The
table has to re-read the flags when the selection changes, and the counts are
not a sufficient signal — clicking node A and then node B leaves `nodeCount` at
1 throughout while the selected node is different. So `SelectionStore` now has a
`version` counter bumped on every mutation.

Honest accounting of what that costs: a marquee now performs **one signal write
per frame** (two, counting the edge pass), from which about forty visible row
derivations re-run. The canvas is unaffected and still reads the flag arrays
directly. So the phase 4 claim should now read "a marquee touches one signal and
the visible rows", which is still the point — it is not 2,000 class bindings —
but it is no longer zero, and it is worth saying so rather than letting the old
sentence stand.

**Centring beats scrolling minimally.** First version scrolled the least
distance needed, which puts the selected row flush against the top or bottom
edge — exactly where the eye does not look, so selecting on the canvas appeared
to do nothing to the table. Centring made the link obvious. A UI decision, but
the reason it was wrong was mechanical: the row was visible and I still could
not see it.

**The ARIA structure forced the markup, not the other way round.** A virtualized
grid has a scroll container between the grid and its rows, which breaks the
required `grid > rowgroup > row` chain. Marking the scroller `role="presentation"`
fixes it, and `aria-rowcount` reports the *full* list rather than the rendered
window — which is the entire contract of a virtualized grid, and the thing that
tells a screen reader it is on row 4,000 of 10,000 rather than row 12 of 22.
Svelte's a11y checker also caught `role="grid"` on a `<section>`, which was a
real error: the pane holds a resize separator and a footer, and a grid whose
children include a separator is a lie. The role moved to an inner element.

### Verified

`npm run verify:table` — 28 checks, all pure arithmetic, no DOM.

The important one is a coverage invariant rather than a spot check: **every row
whose pixels fall inside the viewport must be inside the rendered range.** A gap
there is a blank row on screen. Swept at five list sizes, stepping by a prime so
the sweep lands off row boundaries as well as on:

```
rows=      1      15 scroll positions, 0 gaps, 0 out of range
rows=      7      15 scroll positions, 0 gaps, 0 out of range
rows=     37     107 scroll positions, 0 gaps, 0 out of range
rows=   1000   3,409 scroll positions, 0 gaps, 0 out of range
rows= 100000 342,838 scroll positions, 0 gaps, 0 out of range
```

Plus the edges that are easy to get wrong and invisible when you do: an empty
list, a viewport that has not been measured yet, a list shorter than the
viewport, a negative `scrollTop` (macOS overscroll bounce reports one), and a
`scrollTop` past the end (a resize can leave one for a frame).

### Known limitations, carried forward

- Clicking a row pans instantly. A short viewport tween would make the link
  easier to follow at 10,000 nodes, where the jump can be most of the graph
  away, but it is machinery this phase did not need.
- No sorting or filtering. Not asked for, and both would break the assumption
  that row index equals node index, which is what makes `scrollToIndex` and the
  selection flags line up without a mapping layer.
- The row's `grid-template-columns` is duplicated between the header and the
  row. Cosmetic only — a mismatch misaligns columns, it does not corrupt
  anything — but it is the same class of duplication as the row height, which I
  did fix.
- Keyboard navigation of the list is phase 8. Rows carry `tabindex="-1"` and
  respond to Enter and Space, but nothing moves focus between them yet, and the
  resize handle cannot be driven from the keyboard.

---

## Phase 8 — accessibility and keyboard

### What landed

```
src/lib/a11y/navigate.ts              arrow-key movement through the graph
src/lib/a11y/describe.ts              what a node and an edge are called out loud
src/lib/a11y/tree.ts                  which nodes and edges the tree describes
src/lib/a11y/shortcuts.ts             the key table, as a pure mapping
src/lib/components/AccessibleGraph.svelte   the parallel off-screen tree
```

`TablePane` gained row navigation and a roving tabindex. `HybridRenderer` took
the keydown listener alongside its pointer and wheel ones, and focuses the
surface on click. `FixtureState` carries `layers`. `SelectionStore` was already
reactive from phase 7.

### The decision that took the phase: up and down walk the *layer*

I built the obvious model first — left and right follow edges, up and down move
between siblings, nodes sharing a parent. Every arrow key then moves between
genuinely connected nodes, which is what the brief asks for. It does not work,
and it took measurement rather than use to see why.

**"Nearest sibling above" is not a total order.** Sibling sets differ from node
to node, so the relation is not invertible and some nodes are never any node's
nearest anything. Measured on the 10,000-node fixture:

| model                          | up-then-down retraces | reachable by arrows |
|--------------------------------|-----------------------|---------------------|
| siblings, shared-parent first  | 74.6%                 | 99.04%              |
| siblings, symmetric union      | 74.6%                 | 99.04%              |
| **same layer, sorted**         | **100%**              | **100%**            |

The middle row is a bug I found and fixed on the way: the first `siblings()`
took shared-parent peers and only *fell back* to shared-child peers when there
were none, which made the relation asymmetric — X could consider Y a sibling
while Y never considered X one. 42 stages were reachable from nothing at all.
Unioning both makes it symmetric by construction. It did not help reachability
(it went to 96 unreachable, because larger sibling sets mean more nodes get
skipped over), which is what finally made me stop patching the model.

A layer *is* a total order once sorted by (vertical centre, then index). Every
node has exactly one predecessor and one successor in it, so down-then-up always
returns, and walking a layer covers all of it. Reachability follows: left and
right enter a layer, up and down exhaust it.

The cost is real and worth saying: two nodes in the same layer are **peers, not
neighbours** — same depth from the sources, not joined by an edge. Left and
right remain the edge-following moves. In exchange navigation retraces perfectly
and no stage is stranded, and it matches what is drawn, because the layout puts
a layer in a column and up and down move up and down that column.

Left-then-right still only retraces 67.5% of the time, and that one I left
alone: going downstream and back up to a *different* parent is honest, because
the node genuinely has several.

### Decisions

**The tree asks `moveFocus` where the arrow keys can go.** First version added
the focused node's one-hop neighbours and assumed that covered it. Once up and
down moved to layer peers, 28% of arrow presses had no element to land on. The
fix is to ask the navigation model rather than to infer it — the tree now calls
`moveFocus` for all four directions and includes the answers. The invariant is
enforced where it is stated, and it survives the next change to navigation.

**The tree is bounded, not complete.** At fit-to-screen with 10,000 nodes
everything is drawn, and a 10,000-item listbox is both the DOM explosion the
canvas exists to avoid and useless to read. So it describes the focused node, its
arrow targets, its neighbours, and up to 150 on-screen nodes — and reports the
real count in its label, so a screen reader is told "44 of 9,000 on screen
described" rather than being quietly handed a truncated list. Nothing becomes
unreachable, because every arrow target is always present, so the graph is
walkable one hop at a time however large it is.

**`aria-live` is off, deliberately.** The feed changes status up to 20,000 times
a second. Announcing any of it would make the page unusable; announcing some of
it would be worse, because the user could not tell what they had missed. Live
values are read when a node is focused — on demand, the only rate a human can
absorb.

**The canvas and the DOM node layer are `aria-hidden`.** They describe the same
nodes the tree does. Without this a screen reader reads every visible stage
twice: once as a proper labelled option, once as loose text from the node
elements. The tree is the single accessible representation of what is drawn.

**Throughput is spoken, not abbreviated.** "12.4k" exists because a node is 176
pixels wide, which is not a constraint speech has. `spokenThroughput` says
"12.4 thousand records per second", and a stopped stage is "idle" rather than
"0 records per second".

**The table is the complete index.** Graph arrows are for local traversal; the
list imposes a total order on a graph that has none. It now has its own row
navigation — up, down, page up, page down, home, end — sharing the *same*
focused node as the graph, so arrowing in the table pans the canvas and arrowing
in the graph scrolls the table. One focus, two views.

**The keydown listener is attached by the renderer**, next to the pointer and
wheel ones, rather than bound in markup. Input plumbing lives in one place and
all four are added and removed together. It also sidestepped a Svelte a11y
warning honestly rather than by suppressing it.

### What surprised me

**Svelte's a11y checker caught three real errors, not three false positives.**
`role="grid"` on a `<section>` that also contains a resize separator and a
footer — a grid whose children include a separator is a lie, so the role moved
to an inner element. `role="application"` flagged as non-interactive, which
pushed the keydown listener to where the other input listeners already were.
And an interactive role without a tabindex. I have spent enough time overriding
a11y lints to have expected at least one to be noise.

**Measuring navigation is what found the bug.** Using it felt fine — arrow keys
moved, focus went somewhere sensible, nothing obviously broke. The 74%
retrace rate and the 42 stranded nodes are invisible to anyone who has not
walked all 10,000 of them. A property you can only check exhaustively is a
property you will ship broken.

**The accessible tree turned out to constrain the design, not decorate it.**
Deciding what it contains forced the navigation model to be *complete* — if the
arrow keys can reach everything, the tree can be bounded and still be enough.
The two requirements only work together.

### Verified

`npm run verify:a11y` — 56 checks. 195 across the whole suite.

```
every move lands on a connected node   39,872 moves at 10k, 0 unconnected, 0 self
down then up returns to the start      19,920 pairs at 10k, 100.0%
up goes up and down goes down          19,920 moves, 0 wrong way
holding one arrow terminates           1,600 runs, 0 cycles
arrow keys reach every stage           10,000/10,000 (100.0%)
every arrow target is always described 1,200 targets, 0 missing
```

The shortcut table is asserted key by key, including that Ctrl, Meta and Alt
combinations are left alone — Ctrl+`-` is the browser's page zoom, and taking it
would break the one zoom control a low-vision user already knows — and that
unrelated keys claim nothing.

Cost, per keypress at 10,000 nodes: `moveFocus` 4.98 µs (a linear scan filtered
by layer, deliberately not indexed), `buildAccessibleTree` 0.051 ms,
describing 150 nodes 0.029 ms.

### Known limitations, carried forward

- Up and down move between layer peers, which are not edge-connected. Stated
  above; it is a trade, not an oversight.
- Left-then-right retraces 67.5% of the time. Following an edge and coming back
  to a different parent is defensible but not symmetric.
- The resize handle still cannot be driven from the keyboard. It is a separator
  with no keyboard affordance, which is the one piece of "full keyboard
  operation" this phase did not finish.
- Edges are described but not focusable. They are selectable with the pointer,
  and the connection list announces them, but there is no keyboard route to
  selecting one.
- The tree limit is a count, not a reading budget. 150 short labels and 150 long
  ones are very different amounts of speech.
- No screen reader has actually been run against this. Every claim here is about
  roles, labels and focus order being correct by construction and by test —
  which is necessary and not sufficient.

---

## Phase 9 — tests

### What landed

```
vite.config.ts            two Vitest projects: pure logic in Node, components in jsdom
tests/setup-dom.ts        the three stubs jsdom needs to mount anything here
src/**/*.test.ts          189 unit and component tests, next to what they test
e2e/                      22 Playwright tests against the production build
tools/bench-*.ts          the old verify-* harnesses, now purely measurement
```

`npm test` is the gate. `npm run test:e2e` is the browser half. `npm run bench`
is where NOTES' numbers come from.

### Three things the tests found

This is the part worth reading. All three had been shipped, and two of them
break a headline feature of an earlier phase.

**1. A `$state` created inside a `$derived` does not register as a dependency.**

`DynamicsStore.view()` allocated a node's reactive cell on first read. That read
happens inside `$derived(dynamics.view(index))` in `GraphNode`, so the very first
render of a node both created its cell and tried to subscribe to it — and the
subscription did not stick. The node then **never repainted, however many times
it was notified**. Phase 6's entire claim, "a status change repaints one node",
was false for every DOM node in the app.

Nothing caught it before because every phase 6 and 7 test asserted *routing* —
which index got notified — against a `$state = identity` shim. Routing was
perfect. The component test that mounts two nodes, changes both, notifies one,
and checks that only one moved is the first thing that ran real signals through
a real component, and it failed immediately.

`untrack()` around the creation does not help: the problem is *when* the signal
is created, not what is tracked while it is. The fix is to allocate every cell
in the constructor, which moves signal creation out of any reactive context.
That is the design I had explicitly rejected — 10,000 signals to serve a few
hundred rendered elements — so I measured what it actually costs:

```
500 nodes: 0.027 ms     2,000 nodes: 0.030 ms     10,000 nodes: 0.139 ms
```

A seventh of a millisecond, once per fixture load, against a 40 ms generate.
The laziness was never worth anything; I had just assumed it was.

**2. `aria-selected` in the accessible tree never changed.**

`AccessibleGraph` read `selection.nodeFlags[i]` directly. The flags are a plain
`Uint8Array` — deliberately, so the canvas can read them every frame without a
proxy — and a plain array cannot be observed. `TablePane` got this right because
phase 7 had to add `selection.version` for it; the tree, written a phase later,
did not. A screen reader user would have been told nothing was ever selected.

The tell is that the *fix* was already in the codebase, one file away. A
convention that has to be remembered is a convention that will be forgotten.

**3. ELK cannot lay out 10,000 nodes in a browser.**

Three Playwright tests timed out waiting for the layout. The status reads
`layout failed`, after two seconds, with `Maximum call stack size exceeded`.

This is not phase 2's intermittent warm-instance defect — the fresh-worker retry
fails too, deterministically. It is that a browser worker's stack is smaller
than Node's, and elkjs is GWT-compiled Java with deep recursion. **Every 10k
layout measurement in this file, from phase 2 onward, was taken in Node**, and
phase 3's lesson about "verified everywhere except the target environment" turns
out to have had one more instance in it than I found at the time.

The app degrades rather than breaking: the placeholder layered layout stays on
screen and everything else — culling, semantic zoom, the canvas fallback,
picking, streaming, the keyboard — works normally on it. The e2e tests
therefore wait for the layout to *settle*, either way, and carry on. Worth
saying plainly though: **the 10,000-node fixture has never had an ELK layout in
a browser**, and the honest fixes are chunked layout or a different engine,
neither of which belongs in a testing phase.

### Decisions

**Two Vitest projects.** Most of this codebase is deliberately free of the DOM —
transform maths, quadtree, layout diff, batcher, virtual window, keyboard
navigation — and runs fastest and most honestly in plain Node. Only components
need jsdom, which is slow and unlike a browser, so it is confined to
`*.dom.test.ts`. Both extend the Vite config, so `$lib` resolves and `.svelte.ts`
modules compile — which is what let the first bug above be caught at all.

**End-to-end runs against the production build, not the dev server.** The thing
under test is frame time; the dev server serves hundreds of unbundled modules
and would be measuring Vite. It is also where the elkjs worker is emitted as its
own chunk.

**The perf assertion reads the app's own HUD.** A second instrument would
measure something adjacent to what the project has been tuned against. `frame`
is the mean time inside the draw call — our JavaScript, not rasterisation —
which is exactly what every number in this file means.

**The e2e budget is the frame budget, not the measured number.** Headless
timings are noisier than a real session. A regression that matters will blow
through 16.7 ms; one that does not will not; and a test that flakes gets
ignored, which is worse than no test.

**`tools/` became benchmarks and kept its assertions.** Correctness now lives in
Vitest. These still check before they measure, because a benchmark that measures
broken code reports a meaningless number — usually a flatteringly fast one.

### What surprised me

**My own tests were wrong three times, in ways that were really findings.**

- The fixture buttons render `10,000`, not `10000`, so `getByRole('button',
  {name: '10000'})` never matched.
- `.node-layer .node` was empty after loading a fixture. Not a bug — fit-to-screen
  lands *below* the dot threshold at every fixture size, which phase 5 recorded
  and I had forgotten by the time I was writing browser tests against it.
- `.first()` node element is often **off screen**, because the cull margin keeps
  nodes for 160px beyond the viewport edge. Clicking its centre clicks nothing.

Each of those is a real property of the app that only became visible when
something external tried to drive it.

**The suite got 9x faster by fixing failures, not by optimising.** 6.6 minutes
to 45 seconds — almost all of it was failing tests sitting on their timeouts.

### Measured

```
npm test       189 tests, 14 files, ~3 s      (unit in Node, components in jsdom)
npm run test:e2e   22 tests                   ~46 s against the production build
npm run bench      5 benchmark scripts        all assertions still green
```

Unit and component coverage:

| file | tests | |
|------|-------|---|
| `a11y/navigate.test.ts` | 55 | navigation, tree membership, shortcut table |
| `render/virtual.test.ts` | 17 | windowing to a million rows |
| `interact/selection.test.ts` | 15 | flags, versions, marquee commits |
| `stream/batcher.test.ts` | 14 | coalescing, off-screen updates, DOM mode |
| `layout/incremental.test.ts` | 13 | dirty region, translation fitting |
| `components/AccessibleGraph.dom.test.ts` | 13 | roles, labels, focus, arrow targets |
| `components/TablePane.dom.test.ts` | 13 | virtualization, rows, keyboard |
| `render/viewport.test.ts` | 10 | transform round-trip, zoom anchor, fit, grid |
| `interact/quadtree.test.ts` | 10 | picking vs brute force, coincident points |
| `interact/bezier.test.ts` | 9 | adaptive flattening against a 4,096-segment reference |
| `a11y/describe.test.ts` | 8 | spoken labels |
| `render/cull.test.ts` | 6 | both geometries, never under-accepting |
| `components/GraphNode.dom.test.ts` | 5 | per-node repaint, for real |
| `graph/dynamics.alloc.test.ts` | 1 | what eager cells cost |

Frame time in a real browser, read off the HUD — the first such numbers in this
file, everything before it having been our JavaScript measured in Node:

| | mean | worst |
|---|------|-------|
| 2,000 nodes, panning | 0.3 ms | 0.5 ms |
| 2,000 nodes, panning, feed at 200/s | 0.3 ms | — |
| 10,000 nodes, panning | 1.3 ms | 1.3 ms |

Comfortably inside 16.7 ms, and close to the stub-context numbers phase 5
recorded, which is reassuring about the benchmarks rather than about the app.

### Known limitations, carried forward

- **The 10,000-node fixture has no ELK layout in a browser.** See above. The
  placeholder layout is what those tests, and anyone opening that fixture,
  are actually looking at.
- One browser. Chromium only; no Firefox or WebKit project, so nothing here
  says anything about `deltaMode`, pointer capture or canvas behaviour outside
  Blink — all three of which have bitten this codebase in review already.
- No screen reader, still. The accessible tree is tested for roles, labels and
  focus order, which is necessary and not sufficient.
- jsdom has no layout, so the component tests stub `clientHeight` and assert
  structure only. Anything about pixels is either a pure-maths unit test or a
  Playwright assertion.
- The e2e perf tests assert the frame budget rather than a tight number, so a
  2x regression that stays under 16.7 ms would pass silently. `npm run bench`
  is where a regression of that size would show.
