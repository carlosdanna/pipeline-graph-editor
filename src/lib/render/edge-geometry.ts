import { portOffsetY } from '$lib/graph/generate';
import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph, Point } from '$lib/graph/types';

/**
 * Where an edge starts and ends, in graph units.
 *
 * Lives here rather than in the SVG component because phase 3 draws the same
 * curve on a canvas and phase 4 hit-tests against it. One definition of the
 * curve, three consumers.
 */
export interface EdgeGeometry {
	readonly from: Point;
	readonly to: Point;
	/** Cubic control points, so hit testing and drawing agree exactly. */
	readonly c1: Point;
	readonly c2: Point;
}

/**
 * Horizontal pull of the bezier handles. Scales with the gap so short hops stay
 * tight and long skip-connections bow out enough to be followed by eye.
 */
export function controlOffset(dx: number): number {
	return Math.max(40, Math.min(220, Math.abs(dx) * 0.45));
}

export function edgeGeometry(
	graph: PipelineGraph,
	index: GraphIndex,
	positions: PositionStore,
	edgeIndex: number
): EdgeGeometry | null {
	const edge = graph.edges[edgeIndex];
	const fromNodeIndex = index.nodeIndexById.get(edge.source);
	const toNodeIndex = index.nodeIndexById.get(edge.target);
	if (fromNodeIndex === undefined || toNodeIndex === undefined) return null;

	const fromNode = graph.nodes[fromNodeIndex];
	const toNode = graph.nodes[toNodeIndex];
	const fromSlot = index.portSlotById.get(edge.sourcePort) ?? 0;
	const toSlot = index.portSlotById.get(edge.targetPort) ?? 0;

	// Outputs leave the right edge, inputs enter the left edge.
	const from: Point = {
		x: positions.x[fromNodeIndex] + fromNode.width,
		y: positions.y[fromNodeIndex] + portOffsetY(fromSlot, fromNode.outputs.length, fromNode.height)
	};
	const to: Point = {
		x: positions.x[toNodeIndex],
		y: positions.y[toNodeIndex] + portOffsetY(toSlot, toNode.inputs.length, toNode.height)
	};

	const offset = controlOffset(to.x - from.x);
	return {
		from,
		to,
		c1: { x: from.x + offset, y: from.y },
		c2: { x: to.x - offset, y: to.y }
	};
}

/** SVG path data. Phase 3 will feed the same four points to `ctx.bezierCurveTo`. */
export function bezierPathData(g: EdgeGeometry): string {
	return `M${g.from.x},${g.from.y}C${g.c1.x},${g.c1.y} ${g.c2.x},${g.c2.y} ${g.to.x},${g.to.y}`;
}
