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

- **Still not verified in a browser.** Same caveat as phases 2 and 3: typecheck,
  production build, dev-server transform of every new module, and all the logic
  above pass, but no frame has been seen. Phase 9's Playwright tests are where
  this stops being true.
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
