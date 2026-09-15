# Learnings

What turned out to be wrong, and what I would do differently. This is the
document I would keep if I had to throw the others away.

---

## 1. "Verified everywhere except the target environment" is closer to *unverified* than the green output suggests

This project hit the same wall twice, on the same dependency, three phases
apart.

**First time.** Layout was benchmarked exhaustively in Node: four rounds of
option tuning, an end-to-end incremental verification at 10,000 nodes, a clean
typecheck, a clean production build. Meanwhile, in a browser, the app could not
lay out a single graph — `elkjs`'s bundle is browserified from its **Node**
entry point, and its worker factory does `new Worker(url)` against an export
that only exists when `self` is undefined. *Node has no `self`.* The one
environment I could measure in was the only environment where the bug does not
exist.

**Second time.** Every 10,000-node layout measurement in this repo, from the
worker phase onwards, was taken in Node. When Playwright finally drove the real
app, ELK failed in two seconds with `Maximum call stack size exceeded` — warm
*and* on the fresh-worker retry. A browser worker's stack is smaller than
Node's, and elkjs is GWT-compiled Java with deep recursion. **The 10,000-node
fixture has never had a real layout in a browser.**

I wrote the lesson down after the first one and then did not act on it for three
more phases, because acting on it meant standing up browser tooling and there
was always something more interesting to build. The correct response to
"unverified in the target environment" is not a note in NOTES.md.

> **Do differently:** stand up the end-to-end harness in the phase that first
> introduces a dependency you cannot run natively — not in the testing phase.

---

## 2. Measuring found bugs that *using* never would

Three defects shipped through hands-on use and were caught the moment something
counted.

**Keyboard navigation felt fine.** Arrows moved, focus went somewhere sensible,
nothing obviously broke. Measured across all 10,000 nodes: **pressing down then
up returned to the start only 74.6% of the time**, and 42 stages were reachable
from nothing at all. Neither is perceptible to anyone who has not walked the
whole graph.

**Edge picking felt fine.** Checked against a 4,096-segment reference, the
16-segment flattening was off by **5.76 graph units against a 10-unit
tolerance** — more than half the slop, gone to chord error — and points sitting
*exactly on* a curve read as 0.84 units off it.

**Per-node repaint had never worked.** The DOM path of the streaming feature —
its headline claim — was silently broken for every node in the app.

The common shape: each is a **property over a population**, not an observation
about one interaction. If a property can only be checked exhaustively, it will
ship broken.

> **Do differently:** for anything with a "for all nodes / all zoom levels / all
> scroll positions" shape, write the sweep before the feature feels done.

---

## 3. A test that cannot fail is worse than no test

Written in this repo, and caught only by looking at the output:

- A culling test that sampled viewports from an arbitrary coordinate range,
  **mostly missed the graph entirely**, reported `0 kept on average`, and
  passed.
- An assertion literally written `expect(... === 0 || true)`.
- Edge-visibility checks that accepted 100% of candidates, so the *rejecting*
  path — the only one that can be wrong — was never executed.

All three now assert **in both directions**: zero false rejects proves
correctness, and a partial accept rate proves the rejecting path ran at all.

> **Do differently:** before trusting a green test, break the code on purpose and
> confirm it goes red. A pass with a suspiciously round number in it is a
> vacuous test until proven otherwise.

---

## 4. Shims hide entire classes of bug

The benchmark harnesses stub `$state` as the identity function so runes modules
run as plain classes in Node. Every streaming and selection test passed against
that shim for three phases.

They were all testing **routing** — which index got notified — and routing was
perfect. What no shimmed test could see is that **a `$state` created inside a
`$derived` does not register as a dependency**. `DynamicsStore.view()` allocated
a node's cell on first read, and that read happens inside
`$derived(dynamics.view(index))`, so the first render of a node both created its
cell and failed to subscribe to it. The node then never repainted, however many
times it was notified.

The fix was not subtle once found — allocate the cells in the constructor — but
it was invisible to every test that had been written, because the thing being
stubbed was the thing that was broken.

> **Do differently:** a shim marks a boundary you are not testing. Write the
> shim *and* one real test through the same code path, and treat the shimmed
> suite as covering everything except the shimmed behaviour itself.

Related: `untrack()` did not help, because the problem was **when** the signal
was created, not what was tracked while it was created. Reaching for the
obvious-looking API before understanding the mechanism cost an extra round.

---

## 5. I kept describing the data I imagined instead of the data I had

**The bezier justification was fiction.** I wrote "our edges are shallow
near-horizontal S-curves, never loops" and chose a segment count to match. The
generator produces layers thousands of units apart vertically with control
handles capped at 220 horizontally — the *highest*-curvature shape in the
fixture, not the shallowest. The comment was a description of the edges I
pictured.

**The generator saturated and looked fine.** First run, `metrics` was 79% of all
edges at 10,000 nodes, because aggregates were 27% of nodes and `metrics` is
absorbing — one aggregate anywhere upstream turns every edge below it into
metrics forever. At the 50-node fixture it looks perfectly healthy. Printing the
distribution at all four sizes caught it in one run.

> **Do differently:** print the distribution of any generated data before
> trusting it, and re-read confident-sounding comments as claims to be checked
> rather than as documentation.

---

## 6. Optimising on the axis you can see ships the wrong thing on the axis you cannot

ELK has two knobs that look like one. `thoroughness` buys time; `nodePlacement`
buys **shape**.

| 10,000 nodes | time | result size |
|---|---|---|
| thoroughness = 1 | 5,000 ms | 263,196 × **451,828** |
| both knobs | 4,579 ms | 30,029 × **33,553** |

On the clock alone, `thoroughness` looks like the answer. It produces a
**489,000 pixel tall ribbon** — a 15:1 aspect ratio that would have made
viewport culling nearly useless in one axis and fit-to-screen meaningless. Two
phases later I would have been debugging "why is culling not helping" without
connecting it to a layout option chosen for speed.

> **Do differently:** when tuning, record at least one number that is *not* the
> one you are optimising.

---

## 7. Two optimisations that cover disjoint cases do not compound

I assumed culling and semantic zoom would multiply. They do not:

- **Zoomed in**, culling is everything (10x) and semantic zoom does nothing —
  full detail is what you want at that zoom.
- **Zoomed out at fit**, culling does *nothing at all* — everything is on screen
  by definition — and semantic zoom is the entire win (2.1x).

Obvious in hindsight, and slightly humbling: culling costs 0.01 ms and buys zero
in exactly the situation with the most to draw.

> **Do differently:** ask "in which regime does this help?" before building the
> second optimisation, and check the regimes are not the same one.

---

## 8. Remove the mechanism instead of guarding it

Two examples, both of which shrank the code.

**Bidirectional selection.** The obvious implementation is an `isSyncing` flag:
table click sets selection → selection effect scrolls table → scroll changes the
window → … Instead, `scrollToIndex` returns `null` when the row is already
visible. There is no loop to guard, because the row you clicked is *by
definition* visible. Idempotence replaced a mechanism.

**Culling off.** The comparison mode needed to produce numbers directly
comparable with the previous phase. Rather than branch inside every draw loop,
"off" is an **unbounded view rectangle**. The loops cannot tell the difference,
so the comparison measures culling and not a second code path.

> **Do differently:** when reaching for a flag to prevent a feedback loop, first
> ask whether the operation can be made idempotent.

---

## 9. A convention that must be remembered will be forgotten

Selection membership lives in a `Uint8Array` — deliberately, so the canvas can
read it every frame without a proxy. A plain array cannot be observed, so any
*component* reading it must also depend on `selection.version`.

`TablePane` does this correctly, because the counter was added for it.
`AccessibleGraph`, written one phase later by the same person with the same
context, read the flags directly — so `aria-selected` **never changed**, and a
screen reader user would have been told nothing was ever selected.

The fix was already in the codebase, one file away.

> **Do differently:** when a data structure needs a companion read to be
> correct, put them behind one accessor rather than behind a comment. `flags`
> and `version` should have been a single `isSelected(i)` from the start.

---

## 10. Asymmetric relations strand things

Up/down navigation originally moved between *siblings* — nodes sharing a parent.
The first implementation took shared-parent peers and only fell back to
shared-child peers when there were none, which made the relation **asymmetric**:
X could consider Y a sibling while Y never considered X one. 42 stages had no
inbound arrow move at all.

Making it symmetric did not rescue it (reachability got *worse*, because larger
sibling sets mean more nodes get skipped by "nearest"). The real problem was
deeper: **"nearest sibling above" is not a total order**, and no amount of
patching gives a nearest-neighbour relation the invertibility a user feels.

Switching up/down to walk the **layer** — a total order once sorted — gave 100%
retrace and 100% reachability immediately. The cost is honest and stated:
layer-mates are peers, not edge-neighbours.

> **Do differently:** when a navigation relation misbehaves, check whether it is
> a total order before trying to fix the tie-breaks.

---

## 11. Density changes what a gesture means

Committing edge selection on *pointer-down* is fine at 50 nodes and wrong at
10,000: with a 10px pick tolerance, an edge is within tolerance of most of the
canvas. Starting a pan usually selected an edge, and shift-dragging a marquee
usually selected an edge instead of starting one.

Edge selection now waits for release — pressing on an edge begins the same
gesture as pressing on empty space, and only a press that never moves is treated
as having meant the edge. Nodes still commit on press, because you have to
select a node to drag it.

> **Do differently:** re-walk every interaction at the largest fixture, not the
> one that is pleasant to develop against.

---

## 12. Cheap things I assumed were expensive

Lazy allocation of per-node reactive cells was argued for explicitly —
"10,000 signals to serve a few hundred rendered elements is waste" — and it was
the direct cause of the worst bug in the project. When finally measured, eager
allocation costs **0.139 ms at 10,000 nodes**, once, against a 40 ms generate.

Similarly: culling by linear scan rather than by the quadtree already built for
picking looks obviously wrong, and is correct — 10,000 typed-array reads is
~10 µs, and the scan is always right where the tree is deliberately stale.

> **Do differently:** measure the thing you are avoiding before designing around
> avoiding it. Two of the three worst decisions here were optimisations for
> costs that turned out to be in the noise.

---

## 13. Accessibility constrained the design rather than decorating it

Deciding what the parallel tree should contain forced the navigation model to be
**complete**. A bounded tree is only acceptable if the arrow keys can reach
everything, because the tree holds the focused node's targets and nothing else
guarantees reachability.

The two requirements only work together — and the tree is what made the
navigation bug matter enough to fix properly rather than tolerate.

Relatedly, Svelte's a11y checker flagged three things in this codebase and
**all three were real**: `role="grid"` on an element that also contained a
resize separator, `role="application"` on a div with a bound keydown handler
(which pushed the listener to where the other input listeners already lived),
and an interactive role without a tabindex. I have overridden enough a11y lints
elsewhere to have expected at least one to be noise.

---

## 14. The tests I wrote were wrong three times, and each was a real finding

Writing the browser suite surfaced three properties of the app I had documented
and then forgotten:

- Fixture buttons render `10,000`, not `10000` — locale formatting.
- `.node-layer .node` is **empty** after loading any fixture, because
  fit-to-screen lands *below* the dot threshold at every size.
- The first rendered node element is usually **off screen**, because the cull
  margin keeps nodes 160px beyond the viewport edge.

Each only became visible when something external tried to drive the app.

> **Do differently:** treat early end-to-end test failures as questions about the
> app, not as bugs in the test.

---

## What I would keep unchanged

For balance — decisions that were right and stayed right:

- **The structure/dynamics split.** Awkward to read once, and it is what makes
  200 updates a second cost nothing. Every later phase leaned on it.
- **Stateless edge geometry.** Derived from two node positions and two port
  slots, stored nowhere. A node drag needs no layout run, no edge update, and no
  re-routing — it paid off in three separate phases.
- **Typed arrays throughout, with node indices append-only.** Every store grows
  by a prefix copy; every dirty set, selection and layout job names nodes by
  index and stays valid.
- **Keeping gesture meaning out of the renderer.** `HybridRenderer` owns DOM
  plumbing, `InteractionController` owns what a gesture means and touches no
  DOM. That is why the gesture state machine is testable at all.
- **One definition of edge geometry.** When endpoints moved into flat arrays,
  three unrelated call sites got faster at once.
