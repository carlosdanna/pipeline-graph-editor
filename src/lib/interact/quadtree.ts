import { quadtree, type Quadtree, type QuadtreeLeaf } from 'd3-quadtree';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph, Rect } from '$lib/graph/types';

/**
 * Spatial index over node bounds, for picking and marquee selection.
 *
 * Two things are worth explaining here, because neither is obvious.
 *
 * **The tree stores node indices, not node objects.** `d3-quadtree` is generic
 * over its datum and only ever touches it through the x/y accessors, so the
 * datum can be the integer index and the accessors can read straight out of the
 * position Float32Arrays. The alternative — inserting `{ id, x, y }` records —
 * would allocate a parallel 10,000-object shadow of the graph purely to be
 * clicked on, which is exactly the pointer-chasing the Float32Array positions
 * exist to avoid.
 *
 * **d3-quadtree indexes points; nodes are rectangles.** A node is indexed by
 * its top-left corner, so a query has to be widened by the largest node's size
 * before pruning, and every surviving candidate re-tested against its real
 * bounds. A node whose top-left is at `tx` contains `px` only if
 * `tx <= px <= tx + width`, so `tx` lies in `[px - maxWidth, px]`. That widened
 * box is what prunes the tree; the exact test then removes the false positives.
 * Storing centres instead would need the same widening by half-extents and
 * would not be cheaper.
 *
 * Build cost is the honest price of using a tree at all: see NOTES for numbers.
 * It is paid on structural change, on layout settling, and on drag end — never
 * inside a pointer handler.
 */

export class NodeQuadtree {
	readonly buildMs: number;

	#tree: Quadtree<number>;
	#graph: PipelineGraph;
	#positions: PositionStore;
	#maxWidth = 0;
	#maxHeight = 0;

	constructor(graph: PipelineGraph, positions: PositionStore) {
		const startedAt = performance.now();

		this.#graph = graph;
		this.#positions = positions;

		for (const node of graph.nodes) {
			if (node.width > this.#maxWidth) this.#maxWidth = node.width;
			if (node.height > this.#maxHeight) this.#maxHeight = node.height;
		}

		const indices = new Array<number>(graph.nodes.length);
		for (let i = 0; i < indices.length; i++) indices[i] = i;

		this.#tree = quadtree<number>()
			.x((i) => positions.x[i])
			.y((i) => positions.y[i])
			.addAll(indices);

		this.buildMs = performance.now() - startedAt;
	}

	/** True once positions have moved out from under the tree. */
	matches(graph: PipelineGraph, positions: PositionStore): boolean {
		return this.#graph === graph && this.#positions === positions;
	}

	/**
	 * The topmost node containing the point, or -1.
	 *
	 * "Topmost" means the highest index, matching paint order: later nodes are
	 * drawn over earlier ones, so a click should pick what you can actually see.
	 */
	findNode(px: number, py: number): number {
		let found = -1;

		this.#visitRange(px - this.#maxWidth, py - this.#maxHeight, px, py, (i) => {
			if (i <= found) return;
			const node = this.#graph.nodes[i];
			const x = this.#positions.x[i];
			const y = this.#positions.y[i];
			if (px >= x && px <= x + node.width && py >= y && py <= y + node.height) found = i;
		});

		return found;
	}

	/** Appends every node whose bounds intersect `rect` to `out`. */
	queryRect(rect: Rect, out: number[]): number[] {
		const rightEdge = rect.x + rect.width;
		const bottomEdge = rect.y + rect.height;

		this.#visitRange(
			rect.x - this.#maxWidth,
			rect.y - this.#maxHeight,
			rightEdge,
			bottomEdge,
			(i) => {
				const node = this.#graph.nodes[i];
				const x = this.#positions.x[i];
				const y = this.#positions.y[i];
				if (x <= rightEdge && x + node.width >= rect.x && y <= bottomEdge && y + node.height >= rect.y) {
					out.push(i);
				}
			}
		);

		return out;
	}

	/**
	 * Calls `visitor` for every indexed point inside the given box, pruning
	 * whole quadrants that cannot overlap it.
	 *
	 * The `leaf.next` walk is not optional: d3-quadtree chains coincident points
	 * into a linked list on one leaf rather than subdividing forever, and a
	 * layout that stacks nodes exactly (which ours can, mid-animation) produces
	 * precisely that. Reading only `leaf.data` would silently lose them.
	 */
	#visitRange(
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
		visitor: (index: number) => void
	): void {
		this.#tree.visit((node, x0, y0, x1, y1) => {
			if (x0 > maxX || x1 < minX || y0 > maxY || y1 < minY) return true;
			if (!('length' in node)) {
				let leaf: QuadtreeLeaf<number> | undefined = node;
				do {
					const i = leaf.data;
					const x = this.#positions.x[i];
					const y = this.#positions.y[i];
					if (x >= minX && x <= maxX && y >= minY && y <= maxY) visitor(i);
				} while ((leaf = leaf.next));
			}
			return false;
		});
	}
}
