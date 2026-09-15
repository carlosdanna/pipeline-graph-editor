# Pipeline graph editor

A prototype graph/canvas editor for streaming data pipelines, built to explore
where this class of UI gets hard at scale. Performance characteristics matter
more here than features or polish.

SvelteKit (SPA, `adapter-static`, `ssr = false`) + Svelte 5 runes + TypeScript strict.

```bash
npm run dev      # dev server
npm run build    # static SPA into build/
npm run check    # svelte-check + tsc
```

Decisions and measurements are logged per phase in [NOTES.md](./NOTES.md).

## Current state: phase 2 — layout worker

Fixture generator producing DAG-shaped pipelines at 50 / 500 / 2,000 / 10,000
nodes, a structural validator, and ELK layout running in a dedicated Web Worker.
Adding a stage lays out only the region around it and provably moves no existing
node. Rendering is still the deliberately naive SVG, capped at 600 nodes.

No canvas, no pan/zoom, no interaction yet.
