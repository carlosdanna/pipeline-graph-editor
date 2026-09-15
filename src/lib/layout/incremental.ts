import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';
import type { LayoutResult } from './client';

/**
 * Stable incremental layout.
 *
 * The requirement is that adding a node must not rearrange the graph. ELK has
 * no real per-node pin — the INTERACTIVE strategies take existing coordinates
 * as *hints*, not constraints, and will happily shift everything by a few
 * hundred pixels. So pinning is enforced here instead, in three steps:
 *
 *   1. Lay out only a dirty region: the changed nodes plus a ring of their
 *      neighbours. Sub-linear in graph size — adding a node to the 10k fixture
 *      lays out ~10 nodes, not 10,000.
 *   2. Fit a single translation to the ring, by least squares (which for a pure
 *      translation is just the mean offset). This is how ELK's local coordinate
 *      frame gets aligned with the real one.
 *   3. Throw away ELK's coordinates for the ring entirely and apply the
 *      translated coordinates only to the changed nodes.
 *
 * Step 3 is what makes the guarantee absolute: an existing node's position is
 * never written, so it cannot drift by even a subpixel.
 *
 * Known limitation: a new node is placed relative to its neighbours with no
 * knowledge of the rest of the graph, so it can land on top of an unrelated
 * node. The honest fix is a local overlap-removal pass after splicing; it is
 * not in this phase.
 */

export interface DirtyRegion {
	/** Nodes whose positions this layout is allowed to change. */
	readonly free: Int32Array;
	/** Neighbouring nodes included for context, whose positions are kept. */
	readonly pinned: Int32Array;
	/** free + pinned, the nodes actually sent to ELK. */
	readonly participants: Int32Array;
	/** Edge indices with both endpoints among the participants. */
	readonly edges: Int32Array;
}

/** How many hops of context to drag in around a changed node. */
export const DEFAULT_CONTEXT_HOPS = 2;

export function dirtyRegion(
	graph: PipelineGraph,
	index: GraphIndex,
	dirty: readonly number[],
	hops: number = DEFAULT_CONTEXT_HOPS
): DirtyRegion {
	const nodeCount = graph.nodes.length;
	// 0 = not in region, 1 = free, 2 = pinned context.
	const membership = new Uint8Array(nodeCount);

	for (const v of dirty) membership[v] = 1;

	let frontier = dirty.slice();
	for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
		const next: number[] = [];
		for (const v of frontier) {
			for (const e of index.outgoing[v]) {
				const other = index.nodeIndexById.get(graph.edges[e].target);
				if (other !== undefined && membership[other] === 0) {
					membership[other] = 2;
					next.push(other);
				}
			}
			for (const e of index.incoming[v]) {
				const other = index.nodeIndexById.get(graph.edges[e].source);
				if (other !== undefined && membership[other] === 0) {
					membership[other] = 2;
					next.push(other);
				}
			}
		}
		frontier = next;
	}

	const free: number[] = [];
	const pinned: number[] = [];
	for (let v = 0; v < nodeCount; v++) {
		if (membership[v] === 1) free.push(v);
		else if (membership[v] === 2) pinned.push(v);
	}

	const edges: number[] = [];
	for (let e = 0; e < graph.edges.length; e++) {
		const from = index.nodeIndexById.get(graph.edges[e].source);
		const to = index.nodeIndexById.get(graph.edges[e].target);
		if (from === undefined || to === undefined) continue;
		if (membership[from] !== 0 && membership[to] !== 0) edges.push(e);
	}

	return {
		free: Int32Array.from(free),
		pinned: Int32Array.from(pinned),
		participants: Int32Array.from([...free, ...pinned]),
		edges: Int32Array.from(edges)
	};
}

/** Where a set of nodes should end up. Consumed by the animator. */
export interface PositionTargets {
	readonly nodeId: Int32Array;
	readonly x: Float64Array;
	readonly y: Float64Array;
}

export function fullLayoutTargets(result: LayoutResult): PositionTargets {
	return { nodeId: result.nodeId, x: result.x, y: result.y };
}

/**
 * Targets for the changed nodes only, in the existing graph's coordinate frame.
 */
export function incrementalTargets(
	result: LayoutResult,
	region: DirtyRegion,
	positions: PositionStore
): PositionTargets {
	const isFree = new Set<number>(region.free);

	// Fit the translation on the pinned ring: the mean of (where it really is)
	// minus (where ELK just put it).
	let sumDx = 0;
	let sumDy = 0;
	let pinnedSeen = 0;
	for (let i = 0; i < result.nodeId.length; i++) {
		const v = result.nodeId[i];
		if (isFree.has(v)) continue;
		sumDx += positions.x[v] - result.x[i];
		sumDy += positions.y[v] - result.y[i];
		pinnedSeen++;
	}
	const offsetX = pinnedSeen > 0 ? sumDx / pinnedSeen : 0;
	const offsetY = pinnedSeen > 0 ? sumDy / pinnedSeen : 0;

	const nodeId = new Int32Array(region.free.length);
	const x = new Float64Array(region.free.length);
	const y = new Float64Array(region.free.length);
	let out = 0;
	for (let i = 0; i < result.nodeId.length; i++) {
		const v = result.nodeId[i];
		if (!isFree.has(v)) continue;
		nodeId[out] = v;
		x[out] = result.x[i] + offsetX;
		y[out] = result.y[i] + offsetY;
		out++;
	}

	return { nodeId: nodeId.subarray(0, out), x: x.subarray(0, out), y: y.subarray(0, out) };
}
