/**
 * Rendering thresholds, in one place so they can be tuned without hunting.
 *
 * Phases 3 and 5 add the canvas-fallback node count and the semantic-zoom
 * levels here.
 */

/**
 * Above this many nodes the SVG renderer refuses to draw at all.
 *
 * One DOM element per node, per port, per label and per edge stops being
 * viable somewhere in the low hundreds — at the 10k fixture it is ~90,000
 * elements. This is the exhibit that phases 3 and 5 exist to replace, not a
 * safety valve. Raising it is an instructive way to waste thirty seconds.
 */
export const SVG_NODE_LIMIT = 600;
