/**
 * What is selected.
 *
 * The membership itself lives in two `Uint8Array`s parallel to `graph.nodes`
 * and `graph.edges`, *not* in a reactive `Set`. Three reasons, in order of how
 * much they mattered:
 *
 *  1. The canvas draw loop asks "is this selected?" once per visible node and
 *     once per visible edge, every frame. A flag array answers that with an
 *     array read; a `Set` answers it with a hash lookup, and a `$state` Set
 *     answers it with a hash lookup through a proxy.
 *  2. Selection is drawn on the canvas, so a marquee sweeping across the
 *     2,000-node fixture must not touch Svelte's reactivity at all. If the DOM
 *     node elements carried a `.selected` class, every marquee frame would
 *     re-evaluate 2,000 class bindings — and the marquee is the one gesture
 *     that changes selection at 60fps.
 *  3. It survives phase 5. When nodes above the threshold stop being DOM
 *     elements, selection rendering does not change at all, because it never
 *     depended on there being an element.
 *
 * What *is* reactive is the summary — the counts and the primary index — which
 * is what the header and, later, the table pane read. Same bridge pattern as
 * the perf monitor: bulk data stays out of the proxy, a summary crosses in.
 */
export class SelectionStore {
	/** 1 if selected. Parallel to `graph.nodes`. Read directly by the renderer. */
	nodeFlags: Uint8Array;
	/** 1 if selected. Parallel to `graph.edges`. */
	edgeFlags: Uint8Array;

	nodeCount = $state(0);
	edgeCount = $state(0);

	/**
	 * Bumped on every change, including ones that leave the counts alone.
	 *
	 * Needed from phase 7, because the table pane has to re-read the flags when
	 * the selection changes and the counts are not a sufficient signal: clicking
	 * node A and then node B leaves `nodeCount` at 1 throughout while the
	 * selected node is different. Same shape as `positionsVersion` — bulk data
	 * stays in typed arrays, one counter tells Svelte it moved.
	 *
	 * This is the only reactivity a marquee touches: one signal write per frame,
	 * which the ~40 visible table rows derive from. The canvas still reads the
	 * flags directly and is unaffected.
	 */
	version = $state(0);

	/**
	 * The most recently picked node, or -1. Distinct from "the selection" so a
	 * multi-select still has a subject — phase 7 pans the table to it, phase 8
	 * navigates outward from it with the arrow keys.
	 */
	primaryNode = $state(-1);

	constructor(nodeCapacity: number, edgeCapacity: number) {
		this.nodeFlags = new Uint8Array(nodeCapacity);
		this.edgeFlags = new Uint8Array(edgeCapacity);
	}

	/**
	 * Grows the flag arrays for a changed graph, keeping what overlaps.
	 *
	 * Safe as a prefix copy for exactly the reason positions are: node and edge
	 * indices are append-only, so an existing index never changes meaning.
	 */
	resize(nodeCapacity: number, edgeCapacity: number): void {
		if (nodeCapacity !== this.nodeFlags.length) {
			const next = new Uint8Array(nodeCapacity);
			next.set(this.nodeFlags.subarray(0, Math.min(nodeCapacity, this.nodeFlags.length)));
			this.nodeFlags = next;
		}
		if (edgeCapacity !== this.edgeFlags.length) {
			const next = new Uint8Array(edgeCapacity);
			next.set(this.edgeFlags.subarray(0, Math.min(edgeCapacity, this.edgeFlags.length)));
			this.edgeFlags = next;
		}
		this.#recount();
		this.version++;
	}

	hasNode(index: number): boolean {
		return this.nodeFlags[index] === 1;
	}

	clear(): void {
		if (this.nodeCount === 0 && this.edgeCount === 0 && this.primaryNode === -1) return;
		this.nodeFlags.fill(0);
		this.edgeFlags.fill(0);
		this.nodeCount = 0;
		this.edgeCount = 0;
		this.primaryNode = -1;
		this.version++;
	}

	/** Selects one node, replacing the selection unless `additive`. */
	selectNode(index: number, additive = false): void {
		if (!additive) {
			this.nodeFlags.fill(0);
			this.edgeFlags.fill(0);
			this.edgeCount = 0;
			this.nodeCount = 0;
		}
		if (this.nodeFlags[index] === 0) {
			this.nodeFlags[index] = 1;
			this.nodeCount++;
		}
		this.primaryNode = index;
		this.version++;
	}

	/** Adds or removes one node. The shift-click path. */
	toggleNode(index: number): void {
		if (this.nodeFlags[index] === 1) {
			this.nodeFlags[index] = 0;
			this.nodeCount--;
			if (this.primaryNode === index) this.primaryNode = -1;
		} else {
			this.nodeFlags[index] = 1;
			this.nodeCount++;
			this.primaryNode = index;
		}
		this.version++;
	}

	selectEdge(index: number, additive = false): void {
		if (!additive) {
			this.nodeFlags.fill(0);
			this.edgeFlags.fill(0);
			this.nodeCount = 0;
			this.edgeCount = 0;
			this.primaryNode = -1;
		}
		if (this.edgeFlags[index] === 0) {
			this.edgeFlags[index] = 1;
			this.edgeCount++;
		}
		this.version++;
	}

	/**
	 * Replaces the selected *nodes* with `nodes`, on top of a base snapshot.
	 *
	 * It rewrites from that snapshot rather than accumulating, so dragging a
	 * marquee smaller *deselects* — the box shows the result, not a high-water
	 * mark. `base` is the selection as it stood when the drag began; null means
	 * start from nothing.
	 *
	 * Edges are deliberately not touched here. Which edges a marquee implies
	 * depends on the node flags this call produces, so it can only be decided
	 * afterwards — see `setEdges`.
	 */
	replaceNodes(nodes: readonly number[], base: Uint8Array | null): void {
		if (base) this.nodeFlags.set(base);
		else this.nodeFlags.fill(0);

		for (const i of nodes) this.nodeFlags[i] = 1;

		let count = 0;
		for (let i = 0; i < this.nodeFlags.length; i++) count += this.nodeFlags[i];
		if (this.nodeCount !== count) this.nodeCount = count;
		if (this.primaryNode >= 0 && this.nodeFlags[this.primaryNode] !== 1) this.primaryNode = -1;
		this.version++;
	}

	/** Replaces the selected edges wholesale. The second half of a marquee frame. */
	setEdges(edges: readonly number[]): void {
		this.edgeFlags.fill(0);
		for (const e of edges) this.edgeFlags[e] = 1;
		if (this.edgeCount !== edges.length) this.edgeCount = edges.length;
		this.version++;
	}

	/** The selected node indices, as a fresh array. Called once per drag, not per frame. */
	selectedNodes(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.nodeFlags.length; i++) {
			if (this.nodeFlags[i] === 1) out.push(i);
		}
		return out;
	}

	#recount(): void {
		let nodes = 0;
		for (let i = 0; i < this.nodeFlags.length; i++) nodes += this.nodeFlags[i];
		let edges = 0;
		for (let i = 0; i < this.edgeFlags.length; i++) edges += this.edgeFlags[i];
		if (this.nodeCount !== nodes) this.nodeCount = nodes;
		if (this.edgeCount !== edges) this.edgeCount = edges;
		if (this.primaryNode >= 0 && this.nodeFlags[this.primaryNode] !== 1) this.primaryNode = -1;
	}
}
