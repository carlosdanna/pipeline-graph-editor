/**
 * Windowing arithmetic for the table pane.
 *
 * Pure functions over four numbers. No DOM, no state, no framework — which is
 * what lets the 100,000-row requirement be checked without rendering 100,000 of
 * anything, and what makes the off-by-one cases (empty list, overscrolled,
 * shorter than the viewport) testable rather than hopeful.
 *
 * Rows are a **fixed height**. That is the load-bearing assumption: it makes
 * "which rows are visible" O(1) arithmetic instead of a cumulative-offset
 * structure that has to be maintained as rows change. Variable-height rows
 * would need a prefix-sum tree and a measurement pass, and would buy nothing
 * here — every row holds the same four fields.
 */

/** Row height in CSS pixels. Must match the CSS; see NodeRow.svelte. */
export const ROW_HEIGHT = 24;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Scroll events are coalesced into one animation frame, so at a fast flick the
 * window can be one frame stale. Overscan is what that frame costs: six rows is
 * ~144px of runway, more than a frame's worth of any plausible scroll.
 */
export const OVERSCAN = 6;

export interface VirtualWindow {
	/** Index of the first row to render. */
	readonly first: number;
	/** How many rows to render. */
	readonly count: number;
	/** Where to place the rendered block inside the full-height spacer, in px. */
	readonly offsetY: number;
	/** Height of the spacer that gives the scrollbar its range, in px. */
	readonly totalHeight: number;
}

const EMPTY: VirtualWindow = { first: 0, count: 0, offsetY: 0, totalHeight: 0 };

export function windowFor(
	scrollTop: number,
	viewportHeight: number,
	rowCount: number,
	rowHeight: number = ROW_HEIGHT,
	overscan: number = OVERSCAN
): VirtualWindow {
	const totalHeight = rowCount * rowHeight;
	if (rowCount <= 0 || viewportHeight <= 0) return { ...EMPTY, totalHeight };

	// Overscroll bounce reports a negative scrollTop on macOS, and a scrollTop
	// past the end during a resize. Clamping here rather than trusting the
	// element keeps every downstream index in range by construction.
	const clamped = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));

	const first = Math.max(0, Math.floor(clamped / rowHeight) - overscan);
	const lastExclusive = Math.min(
		rowCount,
		Math.ceil((clamped + viewportHeight) / rowHeight) + overscan
	);

	return {
		first,
		count: Math.max(0, lastExclusive - first),
		offsetY: first * rowHeight,
		totalHeight
	};
}

/**
 * The scrollTop that brings `index` into view, or null if it already is.
 *
 * Returning null for the already-visible case is the whole point: this runs
 * whenever the canvas selection changes, and clicking a row must not make the
 * table jump because the click changed the selection. Only a selection made
 * somewhere else moves the list.
 *
 * When it does move, it centres rather than scrolling minimally. A row that
 * appears flush against the top or bottom edge is easy to miss; one in the
 * middle is where the eye already is.
 */
export function scrollToIndex(
	index: number,
	scrollTop: number,
	viewportHeight: number,
	rowCount: number,
	rowHeight: number = ROW_HEIGHT
): number | null {
	if (index < 0 || index >= rowCount || viewportHeight <= 0) return null;

	const rowTop = index * rowHeight;
	const rowBottom = rowTop + rowHeight;
	if (rowTop >= scrollTop && rowBottom <= scrollTop + viewportHeight) return null;

	const centred = rowTop - (viewportHeight - rowHeight) / 2;
	const maxScroll = Math.max(0, rowCount * rowHeight - viewportHeight);
	return Math.max(0, Math.min(centred, maxScroll));
}
