import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';
import type { EdgeAnchors } from './edge-anchors';
import { controlOffset } from './edge-geometry';
import { CULL_MARGIN_PX } from './limits';

/**
 * What is on screen.
 *
 * Everything here works in graph units against a `ViewRect`, which is the
 * viewport transformed into graph space once per frame. No per-object
 * coordinate arithmetic in screen space, and nothing here touches the DOM.
 *
 * **Why a linear scan rather than the quadtree**, which phase 4 already built
 * and which would answer "what is in this rectangle" in O(log n + k):
 *
 *  1. It is always correct. The quadtree is deliberately stale during a layout
 *     tween and during a node drag — it is rebuilt only when geometry settles.
 *     Culling from a stale index would make dragged nodes vanish.
 *  2. The constant dominates. Ten thousand Float32Array reads and four
 *     comparisons is about 10 µs. The cost culling removes is not the decision,
 *     it is the ~15,000 `bezierCurveTo` calls and ~25,000 port rects behind it.
 *
 * So the scan stays O(n) and the *work* becomes O(visible). That is the whole
 * trade, and it is the right way round: n is bounded by the fixture, while the
 * per-object work is bounded by the screen.
 */

/** The visible region, in graph units, already widened by the cull margin. */
export interface ViewRect {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export function viewRectFor(
	viewport: { x: number; y: number; k: number },
	cssWidth: number,
	cssHeight: number,
	marginPx: number = CULL_MARGIN_PX
): ViewRect {
	const margin = marginPx / viewport.k;
	return {
		left: (0 - viewport.x) / viewport.k - margin,
		top: (0 - viewport.y) / viewport.k - margin,
		right: (cssWidth - viewport.x) / viewport.k + margin,
		bottom: (cssHeight - viewport.y) / viewport.k + margin
	};
}

/**
 * Fills `out` with the indices of every node overlapping `view`, and returns
 * how many. `out` is caller-owned and reused across frames, so a pan allocates
 * nothing at all.
 */
export function cullNodes(
	graph: PipelineGraph,
	positions: PositionStore,
	view: ViewRect,
	out: Int32Array
): number {
	const nodes = graph.nodes;
	let count = 0;

	for (let i = 0; i < nodes.length; i++) {
		const x = positions.x[i];
		const y = positions.y[i];
		const node = nodes[i];
		if (x > view.right || x + node.width < view.left) continue;
		if (y > view.bottom || y + node.height < view.top) continue;
		out[count++] = i;
	}

	return count;
}

/**
 * Whether one edge can possibly touch `view`.
 *
 * `straight` must match how the edge will actually be drawn, because the two
 * tiers use different geometry: a bezier between port anchors, or a straight
 * line between node centres. Culling one shape and drawing the other is how you
 * get edges that flicker out at the viewport edge, so the flag is required
 * rather than defaulted.
 *
 * Deliberately not a call to `writeEdgeGeometry`: this runs for every edge in
 * the graph, and the point of culling is to decide *before* paying for
 * geometry. Either branch is a handful of array reads and four comparisons.
 */
export function edgeVisible(
	anchors: EdgeAnchors,
	positions: PositionStore,
	edgeIndex: number,
	view: ViewRect,
	straight: boolean
): boolean {
	const from = anchors.source[edgeIndex];
	const to = anchors.target[edgeIndex];
	if (from < 0 || to < 0) return false;

	if (straight) {
		// A segment's bounding box is exactly the box of its two endpoints.
		const ax = positions.x[from] + anchors.sourceCentreX[edgeIndex];
		const ay = positions.y[from] + anchors.sourceCentreY[edgeIndex];
		const bx = positions.x[to] + anchors.targetCentreX[edgeIndex];
		const by = positions.y[to] + anchors.targetCentreY[edgeIndex];
		if (Math.min(ay, by) > view.bottom || Math.max(ay, by) < view.top) return false;
		return Math.min(ax, bx) <= view.right && Math.max(ax, bx) >= view.left;
	}

	// Bezier: tested against the bounding box of the four control points, which
	// contains the whole curve — a cubic never leaves the convex hull of its
	// controls, so this rejects but never wrongly accepts.
	//
	// The Y bound is exact rather than conservative: our control points are
	// `c1y = fromY` and `c2y = toY`, so the curve's vertical extent is exactly
	// the span between the two endpoints. Only X needs the handle offsets added.
	const fromY = positions.y[from] + anchors.sourceOffsetY[edgeIndex];
	const toY = positions.y[to] + anchors.targetOffsetY[edgeIndex];
	if (fromY < toY) {
		if (fromY > view.bottom || toY < view.top) return false;
	} else {
		if (toY > view.bottom || fromY < view.top) return false;
	}

	const fromX = positions.x[from] + anchors.sourceOffsetX[edgeIndex];
	const toX = positions.x[to];
	const offset = controlOffset(toX - fromX);

	// The handles push outward from each endpoint, so the extremes are
	// fromX (or fromX + offset) and toX (or toX - offset).
	const minX = Math.min(fromX, toX - offset);
	const maxX = Math.max(toX, fromX + offset);
	return minX <= view.right && maxX >= view.left;
}
