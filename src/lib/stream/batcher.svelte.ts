import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
import { FrameScheduler } from '$lib/render/frame';

/**
 * Turns a stream of individual updates into one flush per frame.
 *
 * The split that makes this cheap: **the data is written immediately, only the
 * notification is batched.** An update writes two typed-array slots — no proxy,
 * no signal, no allocation — and marks the node dirty. Once per frame, the
 * dirty nodes are notified, and a node updated fifty times between two frames
 * is notified once.
 *
 * Two consequences worth stating plainly, because they are the phase:
 *
 *  - **An off-screen update schedules nothing.** Visibility is checked when the
 *    update arrives, against the flag array the cull pass already maintains. At
 *    the 10k fixture zoomed in, 81 of 10,000 nodes are on screen, so roughly 99%
 *    of a 200/second feed costs two array writes and a branch, and no frame
 *    happens at all.
 *  - **A repaint is per-node, not per-graph.** For DOM nodes, notifying a node
 *    invalidates that node's cell and Svelte re-renders one element — and the
 *    canvas is not touched at all, because nothing it draws depends on status.
 *    For canvas nodes there is no such thing as repainting one, so the culled
 *    scene is redrawn: 0.20 ms at 10k zoomed in, and only when a *visible* node
 *    changed. That was the fork; this is the answer we settled on.
 *
 * Nothing here touches the graph, the positions, or the layout. A status change
 * cannot trigger a relayout because there is no path from here to either.
 */

export interface BatcherHost {
	/** Whether the node is inside the current cull region. */
	isVisible(index: number): boolean;
	/**
	 * A visible node's appearance changed. Returns whether a canvas frame was
	 * actually scheduled — false when the DOM owns the nodes, because nothing
	 * the canvas draws depends on status.
	 */
	repaint(): boolean;
}

const PUBLISH_INTERVAL_MS = 250;
/** No updates for this long means the feed has stopped, so the rates are zero. */
const IDLE_AFTER_MS = 600;

/**
 * The numbers behind the streaming half of the HUD.
 *
 * Published on a window like the frame monitor, and for the same reason: an
 * instrument that re-renders on every update would be a bigger workload than
 * the thing it is measuring.
 */
export class StreamMonitor {
	/** Updates delivered by the source. */
	updates = $state(0);
	/** Frame-sized flushes. Cannot exceed the frame rate. */
	flushes = $state(0);
	/** Per-node notifications actually sent — one per dirty node per flush. */
	notified = $state(0);
	/** Updates that landed on a node already dirty this frame, and cost nothing. */
	coalesced = $state(0);
	/** Flushes in which at least one *visible* node had changed. */
	visibleChanges = $state(0);
	/**
	 * Canvas redraws the feed caused. Zero while nodes are DOM elements, because
	 * nothing the canvas draws depends on status.
	 */
	repaints = $state(0);
	active = $state(false);
}

export class UpdateBatcher {
	readonly monitor = new StreamMonitor();

	#dynamics: DynamicsStore;
	#host: BatcherHost;
	#scheduler: FrameScheduler;

	/** 1 while a node is waiting to be notified. Parallel to `graph.nodes`. */
	#dirty: Uint8Array;
	/** The dirty node indices, so a flush is O(changed) rather than O(nodes). */
	#dirtyList: number[] = [];
	/** A node inside the cull region changed this frame. */
	#visibleDirty = false;
	/** That change also required a canvas frame — see `BatcherHost.repaint`. */
	#repaintRequested = false;

	#updates = 0;
	#flushes = 0;
	#notified = 0;
	#coalesced = 0;
	#visibleChanges = 0;
	#repaints = 0;
	#windowStart = 0;
	#lastUpdateAt = 0;

	constructor(dynamics: DynamicsStore, host: BatcherHost) {
		this.#dynamics = dynamics;
		this.#host = host;
		this.#dirty = new Uint8Array(dynamics.count);
		this.#scheduler = new FrameScheduler(() => this.flush());
	}

	resize(count: number): void {
		if (count === this.#dirty.length) return;
		// Anything pending refers to indices that still mean the same thing —
		// node indices are append-only — so the list survives a resize intact.
		const next = new Uint8Array(count);
		next.set(this.#dirty.subarray(0, Math.min(count, this.#dirty.length)));
		this.#dirty = next;
	}

	/** Drops everything pending. Used when the graph is replaced under us. */
	reset(): void {
		for (const index of this.#dirtyList) this.#dirty[index] = 0;
		this.#dirtyList.length = 0;
		this.#visibleDirty = false;
	}

	/**
	 * One update from the source.
	 *
	 * This is the hot path — it runs 200 to 20,000 times a second — so it does
	 * the least possible: two typed-array writes, a dirty check, and at most one
	 * `requestAnimationFrame` that is a no-op if a frame is already pending.
	 */
	queue(nodeIndex: number, statusIndex: number, throughput: number): void {
		this.#dynamics.write(nodeIndex, statusIndex, throughput);
		this.#updates++;
		this.#lastUpdateAt = performance.now();

		if (this.#dirty[nodeIndex] === 1) {
			// Already pending this frame. The write above is the whole update —
			// last value wins, and the node is still notified exactly once.
			this.#coalesced++;
			return;
		}

		this.#dirty[nodeIndex] = 1;
		this.#dirtyList.push(nodeIndex);

		if (!this.#visibleDirty && this.#host.isVisible(nodeIndex)) {
			this.#visibleDirty = true;
			this.#repaintRequested = this.#host.repaint();
		}

		this.#scheduler.request();
	}

	/** Notifies every node that changed since the last frame. */
	flush(): void {
		const list = this.#dirtyList;
		for (let i = 0; i < list.length; i++) {
			const index = list[i];
			this.#dirty[index] = 0;
			// A node that has never been rendered has no cell, so this is a read
			// and a branch. Only nodes something is actually showing cost more.
			this.#dynamics.notify(index);
		}

		this.#notified += list.length;
		this.#flushes++;
		if (this.#visibleDirty) this.#visibleChanges++;
		if (this.#repaintRequested) this.#repaints++;

		list.length = 0;
		this.#visibleDirty = false;
		this.#repaintRequested = false;

		this.#publish(performance.now());
	}

	/** Called on a timer by the HUD, so a stopped feed stops claiming a rate. */
	poll(now: number = performance.now()): void {
		if (this.monitor.active && now - this.#lastUpdateAt > IDLE_AFTER_MS) {
			this.monitor.active = false;
			this.monitor.updates = 0;
			this.monitor.flushes = 0;
			this.monitor.notified = 0;
			this.monitor.coalesced = 0;
			this.monitor.visibleChanges = 0;
			this.monitor.repaints = 0;
			this.#resetWindow(now);
		}
	}

	#publish(now: number): void {
		if (this.#windowStart === 0) this.#windowStart = now;
		const elapsed = now - this.#windowStart;
		if (elapsed < PUBLISH_INTERVAL_MS) return;

		const perSecond = 1000 / elapsed;
		this.monitor.updates = Math.round(this.#updates * perSecond);
		this.monitor.flushes = Math.round(this.#flushes * perSecond);
		this.monitor.notified = Math.round(this.#notified * perSecond);
		this.monitor.coalesced = Math.round(this.#coalesced * perSecond);
		this.monitor.visibleChanges = Math.round(this.#visibleChanges * perSecond);
		this.monitor.repaints = Math.round(this.#repaints * perSecond);
		if (!this.monitor.active) this.monitor.active = true;

		this.#resetWindow(now);
	}

	#resetWindow(now: number): void {
		this.#updates = 0;
		this.#flushes = 0;
		this.#notified = 0;
		this.#coalesced = 0;
		this.#visibleChanges = 0;
		this.#repaints = 0;
		this.#windowStart = now;
	}
}
