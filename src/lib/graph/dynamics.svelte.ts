import { NODE_STATUSES, type NodeDynamics, type NodeStatus } from './types';

/**
 * Per-node status and throughput — the *dynamics* half of the split that
 * phase 1 set up and that this phase finally exercises.
 *
 * The rule from `types.ts` was that dynamics must never be reachable from a
 * `PipelineNode`, because touching them would invalidate the `$state.raw`
 * structural snapshot and re-trigger layout. This is the other end of that
 * rule: the data lives in two typed arrays parallel to `graph.nodes`, and the
 * *reactivity* is allocated per node, lazily, only for nodes something is
 * actually rendering.
 *
 * Why not a `$state` array of `{ status, throughput }` objects: at the 10k
 * fixture that is 10,000 proxied objects, and 200 writes a second each walk a
 * proxy to notify a signal nobody is reading — every node is subscribed to by
 * the same `{#each}`, so one write invalidates the whole list. The requirement
 * asks for a status change to repaint *one* node, and an array of objects
 * cannot express that however it is wrapped.
 *
 * Why not one signal per node, allocated up front: 10,000 signals to serve at
 * most a few hundred rendered elements. Cells are created on first read and
 * kept, so the count converges on "nodes that have been on screen", which the
 * cull margin already bounds.
 *
 * The canvas path ignores all of this and reads the typed arrays directly. It
 * does not need reactivity — it is redrawn by the frame loop, not by Svelte.
 */

/** One node's notification channel. Nothing reads its value; only that it changed. */
class NodeCell {
	version = $state(0);
}

/** Index into `NODE_STATUSES`, which is how status is stored. */
export function statusIndex(status: NodeStatus): number {
	return NODE_STATUSES.indexOf(status);
}

export interface LiveDynamics {
	readonly status: NodeStatus;
	readonly throughput: number;
}

export class DynamicsStore {
	/** Index into `NODE_STATUSES`. A byte rather than a string per node. */
	status: Uint8Array;
	/** Records per second. */
	throughput: Float32Array;

	#cells: (NodeCell | undefined)[];

	constructor(count: number) {
		this.status = new Uint8Array(count);
		this.throughput = new Float32Array(count);
		this.#cells = new Array(count);
	}

	static from(dynamics: readonly NodeDynamics[]): DynamicsStore {
		const store = new DynamicsStore(dynamics.length);
		for (let i = 0; i < dynamics.length; i++) {
			store.status[i] = statusIndex(dynamics[i].status);
			store.throughput[i] = dynamics[i].throughput;
		}
		return store;
	}

	get count(): number {
		return this.status.length;
	}

	/**
	 * Grows for a changed graph, keeping what overlaps.
	 *
	 * A prefix copy is safe for the same reason it is for positions and
	 * selection: node indices are append-only, so an existing index never
	 * changes meaning.
	 */
	resize(count: number): void {
		if (count === this.status.length) return;

		const status = new Uint8Array(count);
		status.set(this.status.subarray(0, Math.min(count, this.status.length)));
		const throughput = new Float32Array(count);
		throughput.set(this.throughput.subarray(0, Math.min(count, this.throughput.length)));

		this.status = status;
		this.throughput = throughput;
		this.#cells.length = count;
	}

	/**
	 * A reactive read of one node. The caller is subscribed to this node and to
	 * nothing else — which is the entire point of the class.
	 */
	view(index: number): LiveDynamics {
		let cell = this.#cells[index];
		if (!cell) {
			cell = new NodeCell();
			this.#cells[index] = cell;
		}
		// Reading the version is what registers the dependency. The value is
		// meaningless; only the fact that it changed matters.
		void cell.version;

		return {
			status: NODE_STATUSES[this.status[index]],
			throughput: this.throughput[index]
		};
	}

	/** Non-reactive write. Notifying is a separate, batched step — see the batcher. */
	write(index: number, statusIdx: number, throughput: number): void {
		this.status[index] = statusIdx;
		this.throughput[index] = throughput;
	}

	/**
	 * Notifies whatever is rendering this node, if anything is.
	 *
	 * Nodes that have never been rendered have no cell, so this is a single
	 * array read and a branch — which is what makes 200 updates a second across
	 * a 10,000-node graph cost almost nothing while 81 of them are on screen.
	 */
	notify(index: number): void {
		const cell = this.#cells[index];
		if (cell) cell.version++;
	}

	/** How many nodes have ever been rendered. For the stats strip. */
	get cellCount(): number {
		let count = 0;
		for (let i = 0; i < this.#cells.length; i++) if (this.#cells[i]) count++;
		return count;
	}
}
