# Testing

Three layers, each answering a different question. They are separate on purpose.

| layer | question | where | cost |
|---|---|---|---|
| **Vitest** | Is it right? | `src/**/*.test.ts` | ~3 s |
| **Playwright** | Does it work in a browser, and is it fast enough? | `e2e/` | ~46 s |
| **Benchmarks** | How fast, and how did that change? | `tools/bench-*.ts` | ~30 s |

```bash
npm test            # the gate
npm run test:e2e    # needs `npx playwright install chromium` once
npm run bench
npm run test:all    # check + test + e2e
```

---

## Vitest — 189 tests

Two projects, because the tests fall into two genuinely different kinds.

**`unit`** runs in plain Node. Most of this codebase is deliberately free of the
DOM — transform maths, quadtree, layout diff, batcher, virtual window, keyboard
navigation — and runs fastest and most honestly there.

**`dom`** runs in jsdom and covers components only. jsdom is slow and unlike a
real browser, so it is confined to `*.dom.test.ts`.

Both extend the Vite config, so `$lib` resolves and `.svelte.ts` modules are
compiled by the Svelte plugin. **That matters more than it sounds**: it means
the runes stores are tested with *real signals*, not with the `$state = identity`
shim the benchmarks must use — and the single worst bug in the project was
invisible to every shimmed test.

| file | tests | covers |
|------|-------|--------|
| `a11y/navigate.test.ts` | 55 | navigation, tree membership, shortcut table |
| `render/virtual.test.ts` | 17 | windowing, to a million rows |
| `interact/selection.test.ts` | 15 | flags, versions, marquee commits |
| `stream/batcher.test.ts` | 14 | coalescing, off-screen updates, DOM mode |
| `layout/incremental.test.ts` | 13 | dirty region, translation fitting |
| `components/AccessibleGraph.dom.test.ts` | 13 | roles, labels, focus, arrow targets |
| `components/TablePane.dom.test.ts` | 13 | virtualization, rows, keyboard |
| `render/viewport.test.ts` | 10 | transform round-trip, zoom anchor, fit, grid |
| `interact/quadtree.test.ts` | 10 | picking vs brute force, coincident points |
| `interact/bezier.test.ts` | 9 | adaptive flattening vs a 4,096-segment reference |
| `a11y/describe.test.ts` | 8 | spoken labels |
| `render/cull.test.ts` | 6 | both geometries, never under-accepting |
| `components/GraphNode.dom.test.ts` | 5 | per-node repaint, with real signals |
| `graph/dynamics.alloc.test.ts` | 1 | what eager cell allocation costs |

### Two techniques worth copying

**Frames are stepped by hand.** `requestAnimationFrame` is replaced with a
queue the test drains. "Batched into one frame-sized flush" is a claim about
frame boundaries, and in a browser you cannot place them.

**Properties are swept, not spot-checked.** The valuable assertions here are
over populations: every node of every fixture, every scroll position of a
100,000-row list, every zoom level the app reaches. Three real bugs were found
this way and none of them was perceptible in use.

Every sweep also asserts it is **not vacuous** — a partial accept rate, a
non-zero hit count — because this repo has shipped tests that passed by never
exercising the path that could fail.

---

## Playwright — 22 tests

Runs against the **production build**, not the dev server. The thing under test
is frame time, and the dev server serves hundreds of unbundled modules with a
different worker pipeline — measuring it would be measuring Vite.

Covers: pan, zoom (including that zoom holds the graph point under the cursor),
`+`/`-`/`0`, click and marquee selection, bidirectional selection with the
table, keyboard navigation, reaching the graph by Tab alone, the canvas fallback
above the DOM limit, `aria-hidden` on the visual layers, and the frame budget at
2,000 and 10,000 nodes.

**The perf assertion reads the app's own HUD.** A second instrument would
measure something adjacent to what the whole project has been tuned against.

**The budget is the frame budget, not the measured number.** Headless timings
are noisier than a real session; a regression that matters will blow through
16.7 ms, one that does not will not, and a test that flakes gets ignored.

`loadFixture` waits for the layout to **settle either way**, because at 10,000
nodes ELK fails in a browser and the app continues on the placeholder layout.

---

## Benchmarks — `tools/`

Bundle with esbuild, run in Node, print tables. They are the provenance of every
number in [performance.md](./performance.md).

**They still assert, now that real tests exist**, because a benchmark that
measures broken code reports a meaningless number — usually a flatteringly fast
one. Each checks the thing it is about before timing it and exits non-zero if
the check fails.

Two shims, both worth knowing about:

- **`$state` is the identity function**, so `.svelte.ts` modules run as plain
  classes. This is exactly the boundary the Vitest suites exist to cover.
- **`Path2D` and `CanvasRenderingContext2D` are call-counting stubs** in
  `bench-draw`. That measures our JavaScript only — rasterisation is the
  browser's and is far larger — so those numbers are a floor and a ratio, never
  a frame time.

---

## What is not covered

See [limitations.md](./limitations.md#testing-gaps): one browser, no screen
reader, no layout in jsdom, loose e2e perf bounds, and the 10,000-node e2e tests
running on the placeholder layout.
