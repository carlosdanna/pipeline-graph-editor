import { portOffsetY } from '$lib/graph/generate';
import type { GraphIndex } from '$lib/graph/indexing';
import type { PipelineGraph } from '$lib/graph/types';

/**
 * Where every edge attaches, resolved once per graph into flat arrays.
 *
 * This replaces the two `Map.get` calls and the `portOffsetY` call that
 * `writeEdgeGeometry` used to make *per edge, per frame* — 29,478 map lookups
 * every frame at the 10k fixture, in the main draw loop, and again on every
 * edge pick. Phase 4's notes flagged it as the most obvious remaining win;
 * phase 5 needs it for a second reason, which is that viewport culling has to
 * decide whether an edge is on screen *before* doing any geometry work, and it
 * can only be cheaper than drawing if the endpoint lookup is free.
 *
 * All of this is structural. A port's vertical offset depends on its slot, its
 * node's port count and its node's height — none of which change without the
 * graph changing — so the only thing left to read per frame is the node's
 * position. Rebuilt alongside the edge colour buckets, whenever structure
 * changes, never per frame.
 */
export interface EdgeAnchors {
	/** Node index the edge leaves, or -1 if the endpoint is dangling. */
	readonly source: Int32Array;
	/** Node index the edge enters, or -1. */
	readonly target: Int32Array;
	/** Source offset from its node's origin. X is the node width: outputs leave the right edge. */
	readonly sourceOffsetX: Float32Array;
	readonly sourceOffsetY: Float32Array;
	/**
	 * Target Y offset from its node's origin. There is no `targetOffsetX`
	 * because inputs always enter the left edge, so it would be an array of
	 * 14,739 zeroes.
	 */
	readonly targetOffsetY: Float32Array;

	// --- Node centres, for the coarsest detail tier --------------------------
	//
	// Below quarter zoom a node is drawn as a dot at its centre, so an edge
	// drawn to the node's *port* would stop half a node width short and hang in
	// space — about 20 screen pixels of line ending in nothing. At that tier
	// edges run centre to centre instead, and these are where.
	//
	// Stored rather than derived so the coarse tier — the one that has to draw
	// every edge in the graph at once, and therefore the one that must be
	// cheapest — stays pure typed-array reads with no object dereferencing.

	readonly sourceCentreX: Float32Array;
	readonly sourceCentreY: Float32Array;
	readonly targetCentreX: Float32Array;
	readonly targetCentreY: Float32Array;
}

export function buildEdgeAnchors(graph: PipelineGraph, index: GraphIndex): EdgeAnchors {
	const count = graph.edges.length;
	const source = new Int32Array(count);
	const target = new Int32Array(count);
	const sourceOffsetX = new Float32Array(count);
	const sourceOffsetY = new Float32Array(count);
	const targetOffsetY = new Float32Array(count);
	const sourceCentreX = new Float32Array(count);
	const sourceCentreY = new Float32Array(count);
	const targetCentreX = new Float32Array(count);
	const targetCentreY = new Float32Array(count);

	for (let e = 0; e < count; e++) {
		const edge = graph.edges[e];
		const from = index.nodeIndexById.get(edge.source);
		const to = index.nodeIndexById.get(edge.target);

		// A dangling endpoint is a validation error, not a rendering one. Mark it
		// and let the draw and pick loops skip it with one comparison.
		source[e] = from ?? -1;
		target[e] = to ?? -1;

		if (from !== undefined) {
			const node = graph.nodes[from];
			const slot = index.portSlotById.get(edge.sourcePort) ?? 0;
			sourceOffsetX[e] = node.width;
			sourceOffsetY[e] = portOffsetY(slot, node.outputs.length, node.height);
			sourceCentreX[e] = node.width / 2;
			sourceCentreY[e] = node.height / 2;
		}
		if (to !== undefined) {
			const node = graph.nodes[to];
			const slot = index.portSlotById.get(edge.targetPort) ?? 0;
			targetOffsetY[e] = portOffsetY(slot, node.inputs.length, node.height);
			targetCentreX[e] = node.width / 2;
			targetCentreY[e] = node.height / 2;
		}
	}

	return {
		source,
		target,
		sourceOffsetX,
		sourceOffsetY,
		targetOffsetY,
		sourceCentreX,
		sourceCentreY,
		targetCentreX,
		targetCentreY
	};
}
