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
 * The cells are allocated **up front**, one per node, and that is not the
 * design I wanted. Creating them lazily on first read is obviously better —
 * 10,000 signals to serve a few hundred rendered elements is waste — and it is
 * what this did until phase 9's component tests caught it silently not working.
 *
 * A `$state` created *during the evaluation of a `$derived`* does not reliably
 * register as a dependency of that derived. `view()` is called from
 * `$derived(dynamics.view(index))` inside `GraphNode`, so the very first render
 * of a node both created its cell and tried to subscribe to it, and the
 * subscription did not stick: the node then never repainted, however many times
 * it was notified. `untrack()` around the creation does not help, because the
 * problem is when the signal is created rather than what is tracked while it is.
 *
 * Allocating in the constructor moves every signal's creation out of any
 * reactive context, which removes the whole class of problem. The cost is one
 * pass at fixture load — measured at about a millisecond for 10,000 nodes,
 * against a 40 ms generate and a multi-second layout — and some memory that is
 * small next to the position and anchor arrays.
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
	/** Bumped on every notification. Carried so the subscribing read cannot be elided. */
	readonly version: number;
	readonly status: NodeStatus;
	readonly throughput: number;
}

export class DynamicsStore {
	/** Index into `NODE_STATUSES`. A byte rather than a string per node. */
	status: Uint8Array;
	/** Records per second. */
	throughput: Float32Array;

	#cells: NodeCell[];

	constructor(count: number) {
		this.status = new Uint8Array(count);
		this.throughput = new Float32Array(count);
		this.#cells = new Array(count);
		for (let i = 0; i < count; i++) this.#cells[i] = new NodeCell();
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

		// Append-only indices, so existing cells keep their meaning and only the
		// new tail needs filling.
		const had = this.#cells.length;
		this.#cells.length = count;
		for (let i = had; i < count; i++) this.#cells[i] = new NodeCell();
	}

	/**
	 * A reactive read of one node. The caller is subscribed to this node and to
	 * nothing else — which is the entire point of the class.
	 */
	view(index: number): LiveDynamics {
		// Reading the version is what registers the dependency. The value is
		// meaningless on its own; only the fact that it changed matters. It is
		// returned rather than discarded so that nothing — a minifier, a future
		// refactor — can decide the read was pointless and remove it.
		return {
			version: this.#cells[index].version,
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
	 * Notifies whatever is rendering this node.
	 *
	 * One signal write. A node nothing is rendering has no subscribers, so the
	 * write propagates nowhere — which is what makes 200 updates a second across
	 * a 10,000-node graph cost almost nothing while 81 of them are on screen.
	 */
	notify(index: number): void {
		this.#cells[index].version++;
	}
}
