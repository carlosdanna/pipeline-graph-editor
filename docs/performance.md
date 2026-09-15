# Performance

Every measurement in the project, with the methodology that produced it.

---

## Read this before reading any number

There are **three kinds of number** here and they are not comparable.

| kind | what it is | where it comes from |
|---|---|---|
| **JS draw time** | Our JavaScript inside the draw call. Rasterisation is the browser's and is **not included**. | `npm run bench`, against a call-counting stub context |
| **Real frame time** | The same figure, measured in a real browser by the app's own HUD | `npm run test:e2e` |
| **Wall clock** | Layout, generation, index building | both |

A JS draw time is a **floor and a ratio**, never a frame time. It is useful
because it is the same work the GPU is also being asked to do, so halving it
usually halves something real — but a 0.2 ms figure does not mean the frame
took 0.2 ms.

Everything is seeded. `Math.random()` would make every measurement here
anecdotal, because you could not compare a number to the one before it.

---

## Fixtures

| nodes | edges | layers | generate | index + naive layout | validate |
|-------|-------|--------|----------|----------------------|----------|
| 50 | 79 | 8 | ~0.6 ms | ~0.3 ms | ~0.7 ms |
| 500 | 738 | 17 | ~2 ms | ~1 ms | ~1.5 ms |
| 2,000 | 2,944 | 25 | ~6 ms | ~2 ms | ~2 ms |
| 10,000 | 14,739 | 40 | ~40 ms | ~6 ms | ~10 ms |

Generation is not the bottleneck anywhere. All four validate as DAGs with zero
errors.

---

## Layout

Full ELK layout, `fast` preset, in-worker time:

| fixture | elk |
|---------|-----|
| 50 | ~26 ms |
| 500 | ~118 ms |
| 2,000 | ~632 ms |
| 10,000 | ~4,600 ms |

Roughly linear to 2,000, then worse. **The 10,000 figure is from Node. ELK
cannot complete that layout in a browser at all** — see
[limitations.md](./limitations.md#elk-cannot-lay-out-10000-nodes-in-a-browser).

### The two ELK knobs are independent

`thoroughness` buys time. `nodePlacement` buys **shape**, and shape turned out
to matter more.

| 10,000 nodes | time | result size |
|---|---|---|
| default (BRANDES_KOEPF, thoroughness 7) | 24,128 ms | 203,291 × 489,374 |
| thoroughness = 1 | 5,000 ms | 263,196 × 451,828 |
| nodePlacement = SIMPLE | 23,295 ms | 30,349 × 33,333 |
| **both (shipped as `fast`)** | **4,579 ms** | **30,029 × 33,553** |

Brandes-Köpf aligns nodes with their neighbours, which on a fan-out-heavy DAG
produces a *489,000 pixel tall* ribbon — a 15:1 aspect ratio that would make
viewport culling nearly useless in one axis and fit-to-screen meaningless.
Picking on the clock alone would have chosen `thoroughness` and shipped that.

### Incremental layout

| fixture | full layout | dirty region | incremental elk | existing nodes moved |
|---------|-------------|--------------|-----------------|----------------------|
| 50 | 75 ms | 4–7 nodes | 4.4–5.1 ms | **0 / 50** |
| 10,000 | 5,322 ms | 5–7 nodes | 3.8–14.9 ms | **0 / 10,000** |

Maximum drift: exactly 0, at both sizes.

---

## Rendering: what culling and semantic zoom buy

JS draw time per frame, 1440×820 viewport. `off/off` is the phase 4 draw loop —
"culling off" is an unbounded view rectangle rather than a second code path, so
the loops cannot tell the difference and the comparison is honest.

### 10,000 nodes, 14,739 edges

| zoom | cull | semantic | draw | nodes drawn | edges drawn | tier |
|------|------|----------|------|-------------|-------------|------|
| fit (0.021x) | off | off | 1.61 ms | 10,000/10,000 | 14,739/14,739 | full |
| fit | **on** | **on** | **0.77 ms** | 10,000/10,000 | 14,739/14,739 | dot |
| 0.25 | off | off | 1.62 ms | 10,000/10,000 | 14,739/14,739 | full |
| 0.25 | **on** | **on** | **0.48 ms** | 1,249/10,000 | 6,948/14,739 | simple |
| 0.5 | off | off | 1.63 ms | 10,000/10,000 | 14,739/14,739 | full |
| 0.5 | **on** | **on** | **0.31 ms** | 316/10,000 | 3,563/14,739 | full |
| 1.0 | off | off | 1.98 ms | 10,000/10,000 | 14,739/14,739 | full |
| 1.0 | **on** | **on** | **0.20 ms** | 81/10,000 | 1,867/14,739 | full |

### 2,000 nodes, 2,944 edges

| zoom | cull | semantic | draw | nodes drawn |
|------|------|----------|------|-------------|
| fit (0.064x) | off | off | 0.34 ms | 2,000/2,000 |
| fit | **on** | **on** | **0.17 ms** | 2,000/2,000 |
| 1.0 | off | off | 0.22 ms | 2,000/2,000 |
| 1.0 | **on** | **on** | **0.05 ms** | 95/2,000 |

**Zoomed in at 10k: 10x. Zoomed out: 2.1x, all of it semantic zoom.**

The two mechanisms cover **disjoint** situations. At fit-to-screen everything is
on screen, so culling costs 0.01 ms and buys nothing; semantic zoom is the
entire win. Zoomed in it is the reverse. They do not compound, which is the
opposite of what I assumed.

### Draw calls are bounded by the palette

| fixture | beziers | strokes | fills |
|---------|---------|---------|-------|
| 50 | 79 | 5 | 4 |
| 500 | 738 | 5 | 4 |
| 2,000 | 2,944 | 5 | 4 |
| 10,000 | 14,739 | 5 | 4 |

Five and four, flat, at every size (seven strokes once selection is drawn).

---

## Real browser frame times

Read off the app's own HUD during a sustained pan, Chromium, production build.
This is `frame` — the mean time inside the draw call — so still our JavaScript,
but measured where it actually runs.

| | mean | worst |
|---|------|-------|
| 2,000 nodes, panning | 0.3 ms | 0.5 ms |
| 2,000 nodes, panning, feed at 200/s | 0.3 ms | — |
| 10,000 nodes, panning | 1.3 ms | 1.3 ms |

Comfortably inside a 16.7 ms budget, and close to the stub-context numbers —
which is reassuring about the benchmarks more than about the app.

---

## Interaction

| fixture | quadtree build | findNode (hit) | edge pick (miss) | marquee frame | drag write |
|---------|----------------|----------------|------------------|---------------|------------|
| 50 | 0.00 ms | 0.3 µs | 0.00 ms | 0.00 ms | 0.002 ms |
| 500 | 0.03 ms | 0.5 µs | 0.01 ms | 0.01 ms | 0.016 ms |
| 2,000 | 0.14 ms | 0.5 µs | 0.05 ms | 0.03 ms | 0.064 ms |
| 10,000 | 0.83 ms | **0.7 µs** | 0.26 ms | 0.12 ms | 0.071 ms |

`findNode` is essentially flat from 50 to 10,000 nodes — 0.3 µs to 0.7 µs across
a 200x increase.

Edge picking and the marquee got **5.7x and 4.2x faster** in phase 5, from a
change made for an unrelated reason: moving edge endpoints into flat arrays
removed 29,478 map lookups per call from three unrelated call sites at once.

| 10,000 nodes | before | after |
|---|---|---|
| edge pick (miss) | 1.49 ms | 0.26 ms |
| marquee frame | 0.50 ms | 0.12 ms |

### Bezier accuracy

The flattening is adaptive: the caller's tolerance sets the segment count.
Verified against a 4,096-segment reference.

| zoom | tolerance | segments avg / max | worst error | budget |
|------|-----------|--------------------|-------------|--------|
| 3 | 3 u | 25.5 / 57 | 0.79 u | 0.83 u |
| 1 | 10 u | 14.9 / 33 | 2.31 u | 2.50 u |
| 0.25 | 40 u | 7.8 / 17 | 8.12 u | 10.0 u |
| 0.05 | 200 u | 4.5 / 8 | 24.5 u | 50.0 u |
| 0.02 | 500 u | 4.0 / 5 | 31.3 u | 125 u |

Within budget everywhere, and **faster** than the fixed 16-segment version it
replaced (1.64 ms → 1.48 ms at 10k), because zoomed out — where most picking
happens — four segments suffice.

---

## Streaming

Batching is essentially free. The repaint is the entire cost.

| rate | updates/frame | queue | flush | total | of 16.7 ms |
|------|---------------|-------|-------|-------|------------|
| 200/s | 3 | 0.000 ms | 0.001 ms | 0.001 ms | 0.0% |
| 1,000/s | 17 | 0.003 ms | 0.001 ms | 0.004 ms | 0.0% |
| 5,000/s | 83 | 0.012 ms | 0.002 ms | 0.013 ms | 0.1% |
| 20,000/s | 333 | 0.024 ms | 0.004 ms | 0.029 ms | **0.2%** |

A hundred times the required rate is a fifth of one percent of a frame.

### Repaints depend on zoom, not on feed rate

One second of a ~200/s feed over the 10,000-node fixture:

| visible | updates | flushes | canvas redraws | frames drawn |
|---------|---------|---------|----------------|--------------|
| 81 / 10,000 | 260 | 60 | **2** | 3% |
| 316 / 10,000 | 260 | 60 | 7 | 12% |
| 1,249 / 10,000 | 260 | 60 | 28 | 47% |
| 10,000 / 10,000 | 260 | 60 | 60 | 100% |

Same feed, same batcher, **30x difference** — decided entirely by where the
viewport is. Culling did not just make each frame cheaper; it made most frames
not happen.

While nodes are DOM elements, the canvas repaint count is **zero**, because
nothing it draws depends on status.

---

## The table

| rows | `windowFor` | rows rendered |
|------|-------------|---------------|
| 1,000 | 0.023 µs | 22 |
| 10,000 | 0.009 µs | 22 |
| 100,000 | 0.021 µs | 22 |
| 1,000,000 | 0.015 µs | 22 |

Constant in both columns across four orders of magnitude. Coverage was swept
exhaustively: 342,838 scroll positions at 100,000 rows, zero gaps.

---

## Accessibility

Per keypress at 10,000 nodes:

| | |
|---|---|
| `moveFocus` | 4.98 µs (a linear scan filtered by layer, deliberately not indexed) |
| `buildAccessibleTree` | 0.051 ms |
| describing 150 nodes | 0.029 ms |

Navigation quality, measured across every node of every fixture:

| model | up-then-down retraces | reachable by arrows |
|---|---|---|
| siblings (shared-parent first) | 74.6% | 99.04% |
| siblings (symmetric union) | 74.6% | 99.04% |
| **same layer, sorted** | **100%** | **100%** |

---

## Reproducing all of this

```bash
npm run bench          # every table above except the browser frame times
npm run test:e2e       # the browser frame times
```

`tools/bench-*.ts` bundle with esbuild and run in Node. They assert before they
measure, because a benchmark that measures broken code reports a meaningless
number — usually a flatteringly fast one.
