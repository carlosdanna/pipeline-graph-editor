# Architecture

A pipeline graph editor for streaming data mediation: pipeline stages
(source / transform / filter / aggregate / sink) joined by typed data flows,
with a status and a throughput per stage that change constantly while the graph
structure stays almost still.

The whole design falls out of that last sentence.

---

## The one idea everything else hangs off

**Structure changes rarely and is large. Dynamics change constantly and are
tiny. They must never be reachable from one another.**

```
STRUCTURE                              DYNAMICS
PipelineNode, PipelineEdge             status, throughput
positions (Float32Array)               per node, ~200x/second
                                       
changes on: add / remove / drag        changes on: every telemetry tick
read by: layout, culling, hit          read by: one node's paint
         testing, the whole renderer
lives in: $state.raw                   lives in: typed arrays + one signal
                                                 per node
```

`status` is deliberately **not a field on `PipelineNode`**, even though "a node
has a status" is the obvious domain reading. If it were, a status change would
have to produce a new node object, which produces a new `PipelineGraph`, which
invalidates the `$state.raw` snapshot that layout, culling and hit testing all
key off. At 200 updates a second that is 200 full invalidations per second.

The split is awkward to read exactly once — in `graph/types.ts` — and buys
everything downstream. A test asserts it directly: after 5,000 streaming
updates, the graph object is the same reference, the node objects are the same
references, and no `status` field has appeared on any of them.

---

## Layers

```
routes/+page.svelte
   │
   ├── state/session.svelte.ts ........ owns everything; the only object the
   │       │                            components are handed
   │       ├── graph/ ................. domain model, fixtures, indexing
   │       ├── layout/ ................ ELK in a worker, incremental layout
   │       ├── render/ ................ the frame loop, culling, drawing
   │       ├── interact/ .............. picking, selection, gestures
   │       ├── stream/ ................ the mock feed and its batcher
   │       └── a11y/ .................. navigation, descriptions, the tree
   │
   └── components/ .................... GraphCanvas, TablePane, AccessibleGraph,
                                        PerfHud — thin, and mostly imperative
                                        plumbing into the modules above
```

Almost nothing in `lib/` imports from `components/`, and most of `lib/` does not
touch the DOM at all. That is not tidiness for its own sake: it is what makes
the transform maths, the quadtree, the layout diff, the batcher, the virtual
window and the keyboard navigation testable in plain Node, which is where most
of the test suite lives.

---

## Data representation

Positions, selection, status, throughput, edge endpoints and culling results are
all **parallel typed arrays indexed by node index**, never objects.

```ts
positions.x: Float32Array      // graph units
selection.nodeFlags: Uint8Array // 1 = selected
dynamics.status: Uint8Array     // index into NODE_STATUSES
anchors.source: Int32Array      // node index this edge leaves
```

Three consequences worth stating:

- **Hot loops are flat.** Culling 10,000 nodes is 10,000 `Float32Array` reads
  and four comparisons — about 10 µs. The equivalent walk over 10,000 objects is
  pointer-chasing.
- **Node indices are append-only.** `graph/mutate.ts` enforces it. That is what
  lets every one of these arrays grow by a prefix copy, and what lets a dirty
  set, a selection or a layout job name nodes by index and stay valid.
- **Svelte cannot see the writes.** Each store therefore publishes a *version
  counter* or a *summary* into `$state`, and that is the only thing reactivity
  ever observes. Bulk data stays out of the proxy.

---

## Rendering

### Hybrid canvas + DOM

The grid, every edge, the port dots, selection and the marquee are drawn on **one
canvas**. Nodes are **DOM elements** in a CSS-transformed layer above it — up to
a point (below).

Both are moved by **one transform**, written in the **same `requestAnimationFrame`
callback**:

```
screen = graph * k + translate
```

That single-callback rule is the reason `HybridRenderer` is a class rather than
logic inside a component. If the DOM layer were positioned through Svelte's
reactivity it could land a frame after the canvas, and nodes would visibly lag
their own edges during a pan.

### Two independent roads to canvas-drawn nodes

Nodes leave the DOM when **either** is true:

- there are more than `DOM_NODE_LIMIT` (2,000) of them, or
- zoom has dropped below the full detail tier (0.5).

The second was not anticipated. It means the DOM layer is not merely a
small-graph path — it is the *zoomed-in* path, and zooming out is a second,
entirely separate route to the canvas fallback.

Neither transition changes anything about interaction, because **nothing has
ever gone through a node element**. The node layer is `pointer-events: none`;
every gesture goes through the surface and the quadtree.

### Culling and semantic zoom

Everything outside the viewport (plus a 160px margin) is skipped. Detail is a
function of zoom:

| zoom | nodes | edges | ports & labels |
|------|-------|-------|----------------|
| ≥ 0.5 | full boxes | bezier | drawn |
| 0.25 – 0.5 | plain boxes | bezier | dropped |
| < 0.25 | dots | straight lines | dropped |

Culling uses a **linear scan, not the quadtree** — deliberately. The quadtree is
stale during layout tweens and drags (it is rebuilt only when geometry settles),
so culling from it would make a dragged node vanish; and the constant dominates
anyway. The scan stays O(n); the *work* becomes O(visible), which is the right
way round, because n is bounded by the fixture while per-object work is bounded
by the screen.

### Draw-call batching

Colour is a canvas state change, so everything is accumulated into one path per
colour and stroked once. The number of draw calls is bounded by the **palette**,
not by the graph: seven strokes and a handful of fills, flat from 50 nodes to
10,000.

---

## Layout

ELK runs in a dedicated Web Worker and never on the main thread. Three policies
in `layout/client.ts`, all forced by how elkjs actually behaves:

1. **One job at a time; a new job cancels the old by terminating the worker.**
   A worker is single-threaded and ELK cannot be interrupted, so without this a
   "switch to the 50-node fixture" click waits behind a multi-second layout
   nobody wants any more.
2. **Recycle the worker after a large layout**, because a warm elkjs instance
   intermittently blows the JS stack on a repeat large layout.
3. **Retry a stack overflow once on a fresh worker**, for the same defect.

The protocol carries eight `ArrayBuffer`s, transferred rather than cloned;
nodes are identified by index and never by id, so no strings cross the boundary.

### Stable incremental layout

Adding a node must not rearrange the graph. ELK has no true per-node pin — the
INTERACTIVE strategies treat existing coordinates as *hints* and will shift
everything — so pinning is enforced on our side, in three steps:

1. Lay out only a **dirty region**: the changed nodes plus two hops of
   neighbours. Sub-linear in graph size.
2. Fit a **single translation** to the pinned ring (least squares, which for a
   pure translation is the mean offset), aligning ELK's local frame with ours.
3. Apply the translated coordinates **only to the changed nodes**, and discard
   ELK's answer for everything else.

Step 3 is what makes the guarantee absolute: an existing node's position is
never written, so it cannot drift by even a subpixel. Measured drift at 10,000
nodes: exactly zero.

### Edges are stateless

Edges are beziers derived from two node positions and two port slots. Nothing
about an edge is stored. That decision — taken over ELK's orthogonal bend points
— pays off three times: a node drag needs no layout run and no edge update at
all, a mid-animation frame re-derives correctly for free, and ELK never has to
know that ports exist (30,000 fewer objects in the 10k job).

---

## Interaction

Picking is a `d3-quadtree` over node bounds, storing **node indices** with
accessors reading the position arrays — so it allocates no shadow object graph.
d3-quadtree indexes points while nodes are rectangles, so queries are widened by
the largest node's extent before pruning and every survivor re-tested.

Edges are picked by **distance to the cubic**, with the tolerance fixed in
*screen* pixels so a 1.4px curve stays clickable at 0.02x zoom. The flattening
is **adaptive**: the caller's tolerance sets the segment count via the standard
cubic chord bound, which is both more accurate where it matters and cheaper
where it does not.

Selection lives in `Uint8Array` flags and is **drawn on the canvas**, not
expressed as a CSS class. A marquee over 2,000 nodes therefore costs almost no
DOM work, and selection rendering did not change at all when nodes stopped being
elements.

Bindings: drag pans, shift-drag marquees, click selects, shift-click toggles,
dragging a node moves the selection, middle-drag always pans. **Edge selection
commits on pointer-up**, not pointer-down — at 10,000 nodes an edge is within
the pick tolerance of most of the canvas, so committing on press meant starting
a pan usually selected an edge.

---

## Streaming

The mock feed emits 200–20,000 status and throughput changes a second, on a
timer rather than on `requestAnimationFrame` — a real feed is a socket
delivering when the network delivers, and absorbing that mismatch is the
batcher's entire job.

**The data is written immediately; only the notification is batched.**

```
queue(node, status, throughput)
    ├─ write two typed-array slots        ← immediate, no proxy, no allocation
    ├─ mark the node dirty                ← one byte
    └─ if the node is ON SCREEN, ask for a canvas frame

once per frame
    └─ notify each dirty node exactly once
```

A node updated fifty times between two frames is notified once, and the value
that survives is the last one written — coalescing falls out of the storage
rather than being implemented. An update to an off-screen node schedules
nothing. And while nodes are DOM elements the canvas is **not touched at all**,
because nothing it draws depends on status.

Reactivity is allocated **per node**: one signal each, so a status change
invalidates one component. An array of `{status, throughput}` objects cannot
express that however it is wrapped, because every node would be subscribed to
through the same `{#each}`.

---

## The table pane

Every stage, virtualized: about twenty rows exist as elements whether the list
holds a hundred or a million. One empty spacer sized to the full list gives the
scrollbar its range and rows are absolutely positioned inside it, so the browser
does the scrolling and we only answer "which rows are those".

Row height is **fixed**, which is what makes the window O(1) arithmetic rather
than a cumulative-offset structure.

Selection is bidirectional, **with no loop guard**. `scrollToIndex` returns null
when the row is already visible, so clicking a row cannot make the list jump
under the click — the row you clicked is by definition visible. Making the
function idempotent removed the feedback loop instead of protecting it with a
flag.

---

## Accessibility

A canvas is a blank rectangle to assistive technology, so a **parallel
off-screen DOM tree** carries real, focusable, labelled elements for what is
drawn. The canvas and the node layer are `aria-hidden`, so each stage is
announced once rather than twice.

The tree is **bounded, not complete**: focus, everywhere the arrow keys can go
from it, its neighbours, and up to 150 on-screen nodes — reporting the true
count in its label. Nothing becomes unreachable, because every arrow target is
always present, so the graph is walkable one hop at a time however large it is.

`aria-live` is **off**. The feed changes status up to 20,000 times a second;
announcing any of it would make the page unusable and announcing some would be
worse, because the user could not tell what they had missed.

Arrow keys: **left and right follow the flow** (upstream / downstream);
**up and down walk the layer** — the column the node is drawn in. Layer-mates
are peers rather than edge-neighbours, which is the honest cost of the choice.
What it buys is that a layer is a *total order* once sorted, so navigation
retraces exactly and reaches every stage. See
[learnings.md](./learnings.md#10-asymmetric-relations-strand-things).

---

## Tunable constants

Everything worth turning is in one place.

| constant | file | default |
|---|---|---|
| `DOM_NODE_LIMIT` | `render/limits.ts` | 2000 |
| `ZOOM_SIMPLE` / `ZOOM_DOT` | `render/limits.ts` | 0.5 / 0.25 |
| `CULL_MARGIN_PX` | `render/limits.ts` | 160 |
| `EDGE_PICK_TOLERANCE_PX` | `interact/hit-test.ts` | 10 |
| `ROW_HEIGHT` / `OVERSCAN` | `render/virtual.ts` | 24 / 6 |
| `A11Y_NODE_LIMIT` | `a11y/tree.ts` | 150 |
| `WORKER_RECYCLE_NODE_COUNT` | `layout/client.ts` | 1000 |
| `MIN_ZOOM` / `MAX_ZOOM` | `render/viewport.ts` | 0.02 / 4 |

Turn `DOM_NODE_LIMIT` down to 200 and the canvas fallback becomes visible at the
500-node fixture, which is the quickest way to see that transition work.
