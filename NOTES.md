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
