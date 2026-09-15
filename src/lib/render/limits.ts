/**
 * Rendering thresholds, in one place so they can be tuned without hunting.
 */

/**
 * Above this many nodes, nodes are not rendered as DOM elements — the canvas
 * draws them instead.
 *
 * 2,000 is chosen to be uncomfortable rather than safe: it is roughly where a
 * transformed DOM layer starts to cost real frame time, which is what makes it
 * worth watching in the HUD. Turn it down to 200 and the switch becomes
 * visible at the 500-node fixture.
 */
export const DOM_NODE_LIMIT = 2000;

/**
 * Semantic zoom tiers.
 *
 * These are about *information*, not performance — though they buy both. At
 * half scale a 176-unit node is 88 screen pixels and its 11px label is 5.5px,
 * which is not small text, it is noise. At quarter scale the node is 44px and
 * the port dots are a pixel across. Drawing either is worse than not drawing
 * it, so the tiers drop things at the point where they stop carrying meaning.
 */
export const ZOOM_SIMPLE = 0.5;
export const ZOOM_DOT = 0.25;

export type DetailLevel =
	/** Labels, throughput, ports, bezier edges. Nodes may be DOM elements. */
	| 'full'
	/** Plain boxes: kind and status colour only. No labels, no ports. */
	| 'simple'
	/** Nodes as dots, edges as straight lines. */
	| 'dot';

export function detailFor(zoom: number): DetailLevel {
	if (zoom < ZOOM_DOT) return 'dot';
	if (zoom < ZOOM_SIMPLE) return 'simple';
	return 'full';
}

/**
 * How far beyond the viewport edge things are still drawn, in CSS pixels.
 *
 * Two reasons it is not zero. Culling exactly at the edge makes a node pop into
 * existence the instant its top-left corner crosses, which reads as flicker
 * during a fast pan. And the DOM node list crosses into Svelte's reactivity, so
 * it lands a frame after the canvas — the margin is what absorbs that frame,
 * turning a visible lag into nothing at all.
 *
 * 160px is about two node widths at 1x, and roughly 10% of a 1440px viewport.
 */
export const CULL_MARGIN_PX = 160;
