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
