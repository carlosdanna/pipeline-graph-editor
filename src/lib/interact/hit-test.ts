import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';
import { createEdgeGeometry, writeEdgeGeometry } from '$lib/render/edge-geometry';
import { distanceSqToCubic } from './bezier';
import type { NodeQuadtree } from './quadtree';

/**
 * Picking, in graph space.
 *
 * Nodes win over edges, always. An edge that passes under a node is not
 * clickable there — the thing you can see is the thing you get.
 */

/**
 * How far from an edge a click still counts, in CSS pixels.
 *
 * Edges are drawn 1.4px wide. Requirement 5 asks for a widened tolerance so a
 * 2px curve is clickable, and this is that widening — roughly a finger-width of
 * slop at 100% zoom. It is deliberately specified on *screen*, not in graph
 * units: zoomed out to 0.02 the same 10px is 500 graph units of tolerance,
 * which is what makes edges pickable at all at the 10k fixture.
 */
export const EDGE_PICK_TOLERANCE_PX = 10;

export interface HitResult {
	/** Node index, or -1. */
	readonly node: number;
	/** Edge index, or -1. Only set when no node was hit. */
	readonly edge: number;
}

const MISS: HitResult = { node: -1, edge: -1 };

// Reused across every candidate of every pick. Same reasoning as the renderer's.
const geometry = createEdgeGeometry();

export function hitTest(
	tree: NodeQuadtree,
	graph: PipelineGraph,
	index: GraphIndex,
	positions: PositionStore,
	graphX: number,
	graphY: number,
	zoom: number
): HitResult {
	const node = tree.findNode(graphX, graphY);
	if (node >= 0) return { node, edge: -1 };

	const edge = hitTestEdge(graph, index, positions, graphX, graphY, zoom);
	return edge >= 0 ? { node: -1, edge } : MISS;
}

/**
 * Nearest edge within tolerance, or -1.
 *
 * This is a linear scan over every edge, with no spatial index. That is a
 * deliberate omission rather than an oversight: an edge index would have to be
 * rebuilt on every drag frame (edges are derived from node positions, so moving
 * one node invalidates every edge touching it), and the scan is cheap enough
 * that it never happens in a hot path — it runs once per click, and only after
 * the quadtree has already ruled out a node. The control-hull box test inside
 * `distanceSqToCubic` rejects almost everything before any real arithmetic.
 */
export function hitTestEdge(
	graph: PipelineGraph,
	index: GraphIndex,
	positions: PositionStore,
	graphX: number,
	graphY: number,
	zoom: number
): number {
	// Tolerance is fixed on screen, so it grows in graph units as you zoom out.
	const tolerance = EDGE_PICK_TOLERANCE_PX / zoom;
	const toleranceSq = tolerance * tolerance;

	let best = -1;
	let bestSq = toleranceSq;

	for (let e = 0; e < graph.edges.length; e++) {
		if (!writeEdgeGeometry(geometry, graph, index, positions, e)) continue;
		const d = distanceSqToCubic(graphX, graphY, geometry, tolerance);
		if (d < bestSq) {
			bestSq = d;
			best = e;
		}
	}

	return best;
}

/**
 * Edges with both endpoints inside `nodes`.
 *
 * A marquee selects edges implicitly rather than by testing the curve against
 * the rectangle: an edge is part of what you dragged a box around only if both
 * of its ends are. Testing the curve would catch edges that merely pass
 * through, which is almost never what someone means, and would cost a
 * curve/rect intersection per edge instead of two set lookups.
 */
export function edgesWithin(
	graph: PipelineGraph,
	index: GraphIndex,
	nodeFlags: Uint8Array,
	out: number[]
): number[] {
	for (let e = 0; e < graph.edges.length; e++) {
		const edge = graph.edges[e];
		const from = index.nodeIndexById.get(edge.source);
		const to = index.nodeIndexById.get(edge.target);
		if (from === undefined || to === undefined) continue;
		if (nodeFlags[from] === 1 && nodeFlags[to] === 1) out.push(e);
	}
	return out;
}
