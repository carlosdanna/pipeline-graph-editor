import { portOffsetY } from '$lib/graph/generate';
import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';

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
 * One definition of the curve, three consumers: the canvas renderer draws it,
 * phase 4 hit-tests against it, phase 8 describes it.
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
 */
export function controlOffset(dx: number): number {
	return Math.max(40, Math.min(220, Math.abs(dx) * 0.45));
}

/** Fills `out` for one edge. Returns false if either endpoint is missing. */
export function writeEdgeGeometry(
	out: EdgeGeometry,
	graph: PipelineGraph,
	index: GraphIndex,
	positions: PositionStore,
	edgeIndex: number
): boolean {
	const edge = graph.edges[edgeIndex];
	const fromNodeIndex = index.nodeIndexById.get(edge.source);
	const toNodeIndex = index.nodeIndexById.get(edge.target);
	if (fromNodeIndex === undefined || toNodeIndex === undefined) return false;

	const fromNode = graph.nodes[fromNodeIndex];
	const toNode = graph.nodes[toNodeIndex];
	const fromSlot = index.portSlotById.get(edge.sourcePort) ?? 0;
	const toSlot = index.portSlotById.get(edge.targetPort) ?? 0;

	// Outputs leave the right edge of a node, inputs enter the left edge.
	out.fromX = positions.x[fromNodeIndex] + fromNode.width;
	out.fromY =
		positions.y[fromNodeIndex] + portOffsetY(fromSlot, fromNode.outputs.length, fromNode.height);
	out.toX = positions.x[toNodeIndex];
	out.toY = positions.y[toNodeIndex] + portOffsetY(toSlot, toNode.inputs.length, toNode.height);

	const offset = controlOffset(out.toX - out.fromX);
	out.c1x = out.fromX + offset;
	out.c1y = out.fromY;
	out.c2x = out.toX - offset;
	out.c2y = out.toY;
	return true;
}
