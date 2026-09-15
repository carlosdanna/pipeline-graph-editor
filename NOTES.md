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
