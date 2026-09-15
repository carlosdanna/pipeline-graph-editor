import type { PipelineGraph, Rect } from './types';

/**
 * Node positions, stored as parallel Float32Arrays indexed by node index
 * (the node's position in `PipelineGraph.nodes`), not by id.
 *
 * Why not `{ x, y }` objects, or fields on PipelineNode?
 *
 *  - Layout animation (phase 2) interpolates every position every frame. Over an
 *    array of 10k objects that is 10k property reads + allocations per frame;
 *    over two Float32Arrays it is a flat loop the JIT keeps in registers.
 *  - Culling and quadtree rebuilds (phases 4-5) scan positions and nothing else.
 *    Keeping them contiguous means those scans touch ~80KB at 10k nodes instead
 *    of walking the whole node object graph.
 *  - Positions change without structure changing (drag, animate). Separating them
 *    means a drag never has to produce a new PipelineGraph.
 *
 * Cost: everything becomes index-based, so `GraphIndex.nodeIndexById` is now
 * load-bearing rather than a convenience.
 *
 * Float32 precision: coordinates reach ~10^5 at the 10k fixture, where float32
 * resolves to ~0.008px. Irrelevant on screen.
 */
export class PositionStore {
	readonly count: number;
	readonly x: Float32Array;
	readonly y: Float32Array;

	constructor(count: number) {
		this.count = count;
		this.x = new Float32Array(count);
		this.y = new Float32Array(count);
	}

	set(index: number, x: number, y: number): void {
		this.x[index] = x;
		this.y[index] = y;
	}

	/**
	 * A copy sized for `count` nodes, keeping whatever overlaps.
	 *
	 * Node indices are append-only — adding a node never renumbers an existing
	 * one — so growing is a straight prefix copy and every position survives.
	 */
	resized(count: number): PositionStore {
		const copy = new PositionStore(count);
		const keep = Math.min(count, this.count);
		copy.x.set(this.x.subarray(0, keep));
		copy.y.set(this.y.subarray(0, keep));
		return copy;
	}

	clone(): PositionStore {
		const copy = new PositionStore(this.count);
		copy.x.set(this.x);
		copy.y.set(this.y);
		return copy;
	}
}

/** Axis-aligned bounds of every node, in graph units. Used to fit-to-screen. */
export function graphBounds(graph: PipelineGraph, positions: PositionStore): Rect {
	if (graph.nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < graph.nodes.length; i++) {
		const node = graph.nodes[i];
		const x = positions.x[i];
		const y = positions.y[i];
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x + node.width > maxX) maxX = x + node.width;
		if (y + node.height > maxY) maxY = y + node.height;
	}

	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
