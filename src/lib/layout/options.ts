import type { LayoutOptions } from './protocol';

/**
 * ELK option sets, measured on the fixtures in this repo (Node 24, this
 * machine — browser numbers are in the same range). See NOTES.md phase 2 for
 * the full table.
 *
 *   preset     2,000 nodes            10,000 nodes
 *   thorough   2,227ms  22656x68678   24,128ms  203291x489374
 *   fast         632ms  10562x10698    4,579ms   30029x33553
 *
 * Two independent wins are folded into `fast`:
 *
 *  - `thoroughness: 1` cuts crossing-minimisation sweeps. ~3.5x faster, and it
 *    is also what keeps the 10k layout clear of the stack limit.
 *  - `nodePlacement.strategy: SIMPLE` instead of the default BRANDES_KOEPF.
 *    This is the big one and it is not about time: Brandes-Köpf aligns nodes
 *    with their neighbours, which on a fan-out-heavy DAG produces a 489,000px
 *    tall ribbon. SIMPLE packs columns and gives a roughly square graph. A
 *    square graph is worth a great deal to the culling work in phase 5.
 *
 * `thorough` is kept because the quality difference is real — SIMPLE produces
 * visibly less aligned columns — and because it is the honest baseline to
 * compare against.
 */

const SHARED: LayoutOptions = {
	'elk.algorithm': 'layered',
	'elk.direction': 'RIGHT',
	'elk.spacing.nodeNode': '24',
	'elk.layered.spacing.nodeNodeBetweenLayers': '120',
	// We draw our own beziers from our own port anchors, so ELK is never asked
	// to route an edge. POLYLINE is the cheapest routing it will accept, and we
	// discard the result.
	'elk.edgeRouting': 'POLYLINE'
};

export const LAYOUT_PRESETS = {
	fast: {
		...SHARED,
		'elk.layered.thoroughness': '1',
		'elk.layered.nodePlacement.strategy': 'SIMPLE'
	},
	thorough: SHARED
} as const satisfies Record<string, LayoutOptions>;

export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

/** Tune me. */
export const DEFAULT_PRESET: LayoutPreset = 'fast';

/**
 * Options for an incremental run over a dirty subgraph.
 *
 * The INTERACTIVE strategies tell ELK to derive layering and in-layer ordering
 * from the coordinates we seed rather than from scratch, so the small result
 * comes out oriented the same way as the region it will be spliced into.
 *
 * Note that this is *not* what pins the existing nodes — ELK has no real
 * per-node pin. Pinning is enforced on our side in `incremental.ts` by throwing
 * away ELK's coordinates for pinned nodes entirely.
 */
export const INCREMENTAL_OPTIONS: LayoutOptions = {
	...LAYOUT_PRESETS.fast,
	'elk.interactive': 'true',
	'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
	'elk.layered.layering.strategy': 'INTERACTIVE',
	'elk.layered.crossingMinimization.strategy': 'INTERACTIVE'
};
