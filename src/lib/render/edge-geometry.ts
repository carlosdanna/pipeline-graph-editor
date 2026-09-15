import type { PositionStore } from '$lib/graph/positions';
import type { EdgeAnchors } from './edge-anchors';

/**
 * Where an edge starts, ends, and bends — in graph units.
 *
 * The API is deliberately allocation-free: you create one of these and hand it
 * back on every call. Returning a fresh `{from, to, c1, c2}` per edge would
 * allocate five objects per edge per frame, which at the 10k fixture is ~74,000
 * short-lived objects every 16ms. That is not slow because of the allocation
 * itself so much as the GC pauses it buys you, which show up as exactly the
 * kind of frame-time spike the HUD exists to catch.
 *
 * Since phase 5 the endpoints come from `EdgeAnchors` — flat typed arrays built
 * once per graph — rather than from map lookups into the graph. The function
 * below is now nothing but array reads and arithmetic.
 *
 * One definition of the curve, three consumers: the canvas renderer draws it,
 * hit testing measures against it, phase 8 will describe it.
 */
export interface EdgeGeometry {
	fromX: number;
	fromY: number;
	c1x: number;
	c1y: number;
	c2x: number;
	c2y: number;
	toX: number;
	toY: number;
}

export function createEdgeGeometry(): EdgeGeometry {
	return { fromX: 0, fromY: 0, c1x: 0, c1y: 0, c2x: 0, c2y: 0, toX: 0, toY: 0 };
}

/**
 * Horizontal pull of the bezier handles. Scales with the gap so short hops stay
 * tight and long skip-connections bow out enough to be followed by eye.
 *
 * `MAX_CONTROL_OFFSET` is exported because culling needs to know how far a
 * curve can bulge past its endpoints without computing the curve.
 */
export const MIN_CONTROL_OFFSET = 40;
export const MAX_CONTROL_OFFSET = 220;

export function controlOffset(dx: number): number {
	return Math.max(MIN_CONTROL_OFFSET, Math.min(MAX_CONTROL_OFFSET, Math.abs(dx) * 0.45));
}

/** Fills `out` for one edge. Returns false if either endpoint is missing. */
export function writeEdgeGeometry(
	out: EdgeGeometry,
	anchors: EdgeAnchors,
	positions: PositionStore,
	edgeIndex: number
): boolean {
	const from = anchors.source[edgeIndex];
	const to = anchors.target[edgeIndex];
	if (from < 0 || to < 0) return false;

	// Outputs leave the right edge of a node, inputs enter the left edge.
	out.fromX = positions.x[from] + anchors.sourceOffsetX[edgeIndex];
	out.fromY = positions.y[from] + anchors.sourceOffsetY[edgeIndex];
	out.toX = positions.x[to];
	out.toY = positions.y[to] + anchors.targetOffsetY[edgeIndex];

	const offset = controlOffset(out.toX - out.fromX);
	out.c1x = out.fromX + offset;
	out.c1y = out.fromY;
	out.c2x = out.toX - offset;
	out.c2y = out.toY;
	return true;
}
