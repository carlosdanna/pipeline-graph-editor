/**
 * Rendering thresholds, in one place so they can be tuned without hunting.
 */

/**
 * Above this many nodes, nodes are not rendered as DOM elements.
 *
 * Phase 3 simply stops drawing them above this count (edges and the grid still
 * render, and pan/zoom still works, so the canvas cost is measurable at every
 * fixture size). Phase 5 turns this into the real fallback: above the threshold
 * nodes get drawn on the canvas instead.
 *
 * 2,000 is chosen to be uncomfortable rather than safe — it is roughly where a
 * transformed DOM layer starts to cost real frame time, which is what makes it
 * worth watching in the HUD.
 */
export const DOM_NODE_LIMIT = 2000;
