# Verification harnesses

Headless checks for the parts of the app that are pure logic. They bundle with
esbuild (so `$lib` resolves) and run in Node — no browser, no test runner. Phase
9 turns these into proper Vitest suites; until then they are the evidence behind
the numbers in [NOTES.md](../NOTES.md).

```bash
npm run verify              # all three
npm run verify:interact     # quadtree and bezier, vs brute force
npm run verify:gestures     # the pointer gesture state machine
npm run verify:draw         # what selection costs the draw loop
```

`verify-interact` and `verify-gestures` exit non-zero on failure.
`verify-draw` only reports numbers.

Two shims make this possible, and both are worth knowing about:

- **`$state` is defined as the identity function** via an esbuild banner, so
  `selection.svelte.ts` runs as a plain class. Its reactivity is not what is
  under test; its set arithmetic is.
- **`Path2D` is stubbed** in `verify-draw`, along with a proxy standing in for
  `CanvasRenderingContext2D` that counts draw calls. That measures our
  JavaScript only — rasterisation is the browser's and is far larger.

The gesture harness can drive the real `InteractionController` because gesture
meaning was deliberately kept out of `HybridRenderer`: there is no DOM in the
path. See the note at the top of `src/lib/interact/controller.ts`.
