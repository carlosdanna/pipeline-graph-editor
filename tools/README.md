# Benchmarks

Measurement scripts. They bundle with esbuild (so `$lib` resolves) and run in
Node — no browser, no test runner. **They are the provenance of the numbers in
[NOTES.md](../NOTES.md)**, and they exist so those numbers can be reproduced
rather than taken on trust.

```bash
npm run bench              # all of them
npm run bench:interact     # quadtree and bezier picking
npm run bench:gestures     # the pointer gesture state machine
npm run bench:stream       # the streaming batcher
npm run bench:table        # the virtual window
npm run bench:a11y         # keyboard navigation and the accessible tree
npm run bench:draw         # what culling and semantic zoom buy, per frame
```

## Why these still assert, now that there are real tests

Correctness lives in the Vitest suites next to the source (`npm test`) — that is
the gate, and it is what CI should fail on. These scripts overlap with it
deliberately, because **a benchmark that measures broken code reports a
meaningless number**, usually a flatteringly fast one. Each script checks the
thing it is about before timing it, and exits non-zero if the check fails.

So the division is: Vitest answers *is it right*, in a form that fails a build.
These answer *how fast, and how does that change*, in a form you can read.

## Two shims, both worth knowing about

- **`$state` is the identity function**, injected by an esbuild banner, so
  `.svelte.ts` modules run as plain classes. The Vitest suites do *not* need
  this — they compile through the Svelte plugin and exercise real signals — and
  the difference matters: a bug where reactivity silently failed to register
  would be invisible here and is caught there.
- **`requestAnimationFrame` is a hand-stepped queue** in the streaming script.
  "Batched into one frame-sized flush" is a claim about frame boundaries, and
  in a browser you cannot place them.

`bench-draw` additionally stubs `Path2D` and `CanvasRenderingContext2D` with a
call-counting proxy. That measures our JavaScript only — rasterisation is the
browser's and is far larger — so its numbers are a floor and a ratio, never a
frame time. Real frame times come from the Playwright suite in `e2e/`.
