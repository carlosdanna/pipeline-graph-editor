/**
 * The bridge between the frame loop and the DOM node layer.
 *
 * Culling is decided imperatively, inside the rAF callback, against the same
 * transform the canvas draws with. But the DOM nodes are rendered by Svelte, so
 * *which* nodes exist has to cross into reactivity — and that crossing lands a
 * microtask after the frame that decided it.
 *
 * Two things make that acceptable rather than the frame-lag bug phase 3 was
 * built to avoid:
 *
 *  - **Position never crosses.** Nodes move because their shared container is
 *    transformed, and that write happens in the same rAF callback as the canvas
 *    draw. A node already on screen can never lag its own edges. Only a node
 *    *entering* the viewport appears a frame late.
 *  - **The cull margin absorbs it.** Nodes are kept for 160px beyond the
 *    viewport edge, which at any plausible pan speed is many frames of runway.
 *
 * The publish also diffs before writing, so holding still, zooming in place, or
 * panning within the margin costs Svelte nothing at all.
 */
export class VisibleNodes {
	/**
	 * Node indices the DOM layer should render. Empty whenever the canvas owns
	 * the nodes — above the DOM limit, or below the full detail tier.
	 */
	indices = $state.raw<readonly number[]>([]);

	/** False when the canvas is drawing node bodies instead. */
	domNodes = $state(false);

	#current: number[] = [];

	/**
	 * Publishes the culled list, if it actually changed.
	 *
	 * The comparison is O(visible) — a few dozen integers — against the cost of
	 * invalidating a keyed each block, so it is worth doing on every frame.
	 */
	publish(buffer: Int32Array, count: number): void {
		if (!this.domNodes) this.domNodes = true;

		if (this.#current.length === count) {
			let same = true;
			for (let i = 0; i < count; i++) {
				if (this.#current[i] !== buffer[i]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}

		const next = new Array<number>(count);
		for (let i = 0; i < count; i++) next[i] = buffer[i];
		this.#current = next;
		this.indices = next;
	}

	/** The canvas has taken over the nodes; the DOM layer should render nothing. */
	clear(): void {
		if (this.domNodes) this.domNodes = false;
		if (this.#current.length === 0) return;
		this.#current = [];
		this.indices = this.#current;
	}
}
