import type { PositionStore } from '$lib/graph/positions';
import type { Rect } from '$lib/graph/types';
import type { EdgeAnchors } from '$lib/render/edge-anchors';
import type { PointerInput, InputTarget } from '$lib/render/hybrid-renderer';
import type { Viewport } from '$lib/render/viewport';
import { edgesWithin, hitTest } from './hit-test';
import type { NodeQuadtree } from './quadtree';
import type { SelectionStore } from './selection.svelte';

/**
 * The pointer gesture state machine: pan, marquee, node drag, and picking.
 *
 * Kept out of `HybridRenderer` because the two answer different questions. The
 * renderer owns the DOM plumbing — sizing, device pixel ratio, the cached
 * surface origin, when a frame happens. This owns what a gesture *means*, and
 * needs no DOM at all: it is handed surface-local coordinates and does
 * arithmetic against the viewport. That is also what keeps requirement 4
 * honest — there is no `getBoundingClientRect` in this file to accidentally
 * call, because there is no element to call it on.
 *
 * Bindings (settled with you before writing this):
 *
 *   empty + drag         pan
 *   empty + shift-drag   marquee, added to the existing selection
 *   empty + click        clear
 *   node  + drag         move the selection
 *   node  + shift-click  toggle
 *   edge  + click        select the edge
 *   edge  + drag         pan — an edge under the cursor is not a handle
 *   middle-drag          pan, always
 *
 * The last two lines are the ones that took a test to find. See `#pendingEdge`.
 */

/** Movement below this many CSS pixels is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

export interface InteractionScene {
	readonly positions: PositionStore;
	/** Flat edge endpoints — the same arrays the renderer draws from. */
	readonly anchors: EdgeAnchors;
	readonly tree: NodeQuadtree;
}

export interface InteractionHost {
	readonly viewport: Viewport;
	readonly selection: SelectionStore;
	/** Null until the first layout has produced a spatial index. */
	scene(): InteractionScene | null;
	/** Request a redraw. Coalesced into one frame by the renderer. */
	schedule(): void;
	/** Node positions were written in place; anything mirroring them must catch up. */
	positionsWritten(): void;
	/** A drag is starting — stop any layout animation before it fights the pointer. */
	dragStarted(): void;
	/** A drag finished; the spatial index is stale and should be rebuilt. */
	dragEnded(): void;
}

type Gesture = 'none' | 'pan' | 'marquee' | 'drag-nodes';

export class InteractionController implements InputTarget {
	/**
	 * The live marquee box in GRAPH space, or null.
	 *
	 * Graph space rather than screen space so that zooming mid-marquee keeps the
	 * box over the same nodes instead of over the same pixels. Read imperatively
	 * by the renderer at draw time; nothing reactive depends on it, so a marquee
	 * at 60fps costs no reactivity at all.
	 */
	marquee: Rect | null = null;

	#host: InteractionHost;
	#gesture: Gesture = 'none';

	// Where the gesture began, in both spaces. Screen for the click/drag
	// threshold, graph for everything that has to survive a zoom.
	#startScreenX = 0;
	#startScreenY = 0;
	#startGraphX = 0;
	#startGraphY = 0;
	#moved = false;

	// Drag state. Start positions are snapshotted so the drag is always measured
	// from the origin — accumulating per-frame deltas would drift.
	#dragNodes: number[] = [];
	#dragFromX: Float64Array = new Float64Array(0);
	#dragFromY: Float64Array = new Float64Array(0);

	/**
	 * The edge that was under the cursor when the gesture began, or -1.
	 *
	 * Edge selection is committed on *release*, not on press, and this is what
	 * remembers the candidate in between. The reason is density: at the 10k
	 * fixture an edge is within the 10px pick tolerance of almost anywhere on
	 * screen, so committing on press would mean that starting a pan usually
	 * selected an edge, and that shift-dragging a marquee usually selected an
	 * edge instead of starting one. Pressing on an edge now begins the same
	 * gesture as pressing on empty space; only a press that never moves is
	 * treated as having meant the edge.
	 */
	#pendingEdge = -1;

	/** The selection as it stood when a marquee began. See `replaceNodes`. */
	#marqueeBase: Uint8Array | null = null;
	#marqueeNodes: number[] = [];
	#marqueeEdges: number[] = [];

	constructor(host: InteractionHost) {
		this.#host = host;
	}

	get dragging(): boolean {
		return this.#gesture === 'drag-nodes';
	}

	// --- Pointer -------------------------------------------------------------

	onPointerDown(event: PointerInput): void {
		const { viewport, selection } = this.#host;

		this.#startScreenX = event.sx;
		this.#startScreenY = event.sy;
		this.#startGraphX = viewport.toGraphX(event.sx);
		this.#startGraphY = viewport.toGraphY(event.sy);
		this.#moved = false;

		// Middle button is always a pan, whatever is underneath.
		if (event.button === 1) {
			this.#gesture = 'pan';
			return;
		}
		if (event.button !== 0) return;

		const scene = this.#host.scene();
		if (!scene) {
			this.#gesture = 'pan';
			return;
		}

		const hit = hitTest(
			scene.tree,
			scene.anchors,
			scene.positions,
			this.#startGraphX,
			this.#startGraphY,
			viewport.k
		);

		if (hit.node >= 0) {
			if (event.shiftKey) {
				// Toggling is a decision, not the start of a move: shift-dragging
				// a node would be ambiguous against the additive marquee.
				selection.toggleNode(hit.node);
				this.#gesture = 'none';
				this.#host.schedule();
				return;
			}
			// Grabbing an unselected node selects it, so the drag that follows
			// moves what you grabbed. Grabbing one that is already selected leaves
			// the selection alone, so a multi-selection can be dragged as a unit —
			// and pointerup narrows it back down if you never actually moved.
			if (!selection.hasNode(hit.node)) selection.selectNode(hit.node, false);
			else selection.primaryNode = hit.node;
			this.#beginNodeDrag(scene);
			this.#host.schedule();
			return;
		}

		// Nothing grabbable under the cursor. Whatever edge may be there is only a
		// candidate until the pointer comes back up without having moved.
		this.#pendingEdge = hit.edge;

		if (event.shiftKey) {
			this.#beginMarquee(selection);
			return;
		}

		this.#gesture = 'pan';
	}

	onPointerMove(event: PointerInput): void {
		if (this.#gesture === 'none') return;

		if (!this.#moved) {
			const dx = event.sx - this.#startScreenX;
			const dy = event.sy - this.#startScreenY;
			if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
			this.#moved = true;
		}

		switch (this.#gesture) {
			case 'pan':
				// Deltas between successive events, so panning never needs to know
				// where the surface is — and therefore never reads layout.
				this.#host.viewport.panBy(event.dx, event.dy);
				break;
			case 'marquee':
				this.#updateMarquee(event);
				break;
			case 'drag-nodes':
				this.#updateNodeDrag(event);
				break;
		}

		this.#host.schedule();
	}

	onPointerUp(): void {
		const gesture = this.#gesture;
		this.#gesture = 'none';

		if (gesture === 'marquee') {
			this.marquee = null;
			this.#marqueeBase = null;
			// A shift-press that never moved is a shift-click: add the edge under
			// it, if there was one. A shift-click on genuinely empty space does
			// nothing at all — it must not clear, because shift means "and also".
			if (!this.#moved && this.#pendingEdge >= 0) {
				this.#host.selection.selectEdge(this.#pendingEdge, true);
			}
			this.#pendingEdge = -1;
			this.#host.schedule();
			return;
		}

		if (gesture === 'drag-nodes') {
			this.#dragNodes = [];
			// Positions moved, so the quadtree no longer describes the graph.
			// Rebuilt here rather than per frame: a 10k rebuild is ~10ms, which
			// is a whole frame budget, and nothing hit-tests mid-drag anyway.
			this.#host.dragEnded();
			return;
		}

		if (gesture === 'pan' && !this.#moved) {
			// A press and release that went nowhere. If an edge was under it, that
			// is what was meant; otherwise panning by zero pixels is how you say
			// "nothing", and the selection is cleared.
			if (this.#pendingEdge >= 0) this.#host.selection.selectEdge(this.#pendingEdge, false);
			else this.#host.selection.clear();
			this.#host.schedule();
		}

		this.#pendingEdge = -1;
	}

	/** Called when the gesture is abandoned — pointer cancelled, window blurred. */
	cancel(): void {
		if (this.#gesture === 'drag-nodes') {
			// Put everything back. A cancelled drag must not leave the graph in a
			// position no layout ever produced.
			const scene = this.#host.scene();
			if (scene) {
				for (let i = 0; i < this.#dragNodes.length; i++) {
					scene.positions.set(this.#dragNodes[i], this.#dragFromX[i], this.#dragFromY[i]);
				}
				this.#host.positionsWritten();
			}
			this.#dragNodes = [];
		}
		this.#gesture = 'none';
		this.marquee = null;
		this.#marqueeBase = null;
		this.#pendingEdge = -1;
		this.#host.schedule();
	}

	// --- Gestures ------------------------------------------------------------

	#beginNodeDrag(scene: InteractionScene): void {
		this.#host.dragStarted();

		this.#dragNodes = this.#host.selection.selectedNodes();
		this.#dragFromX = new Float64Array(this.#dragNodes.length);
		this.#dragFromY = new Float64Array(this.#dragNodes.length);
		for (let i = 0; i < this.#dragNodes.length; i++) {
			const n = this.#dragNodes[i];
			this.#dragFromX[i] = scene.positions.x[n];
			this.#dragFromY[i] = scene.positions.y[n];
		}

		this.#gesture = 'drag-nodes';
	}

	/**
	 * Moves the dragged nodes by writing straight into the position arrays.
	 *
	 * No new `PipelineGraph`, no layout run, and nothing at all done to the
	 * edges. Edges are re-derived from node positions every frame by
	 * `writeEdgeGeometry`, so they follow a drag for free — which is the payoff
	 * of the phase 2 decision to keep edge geometry stateless rather than
	 * storing ELK's bend points.
	 */
	#updateNodeDrag(event: PointerInput): void {
		const scene = this.#host.scene();
		if (!scene) return;

		const { viewport } = this.#host;
		const dx = viewport.toGraphX(event.sx) - this.#startGraphX;
		const dy = viewport.toGraphY(event.sy) - this.#startGraphY;

		for (let i = 0; i < this.#dragNodes.length; i++) {
			scene.positions.set(this.#dragNodes[i], this.#dragFromX[i] + dx, this.#dragFromY[i] + dy);
		}

		this.#host.positionsWritten();
	}

	#beginMarquee(selection: SelectionStore): void {
		// Snapshot what was selected so the marquee is additive to *that*, and
		// shrinking the box gives back what it no longer covers.
		this.#marqueeBase = new Uint8Array(selection.nodeFlags);
		this.marquee = { x: this.#startGraphX, y: this.#startGraphY, width: 0, height: 0 };
		this.#gesture = 'marquee';
	}

	#updateMarquee(event: PointerInput): void {
		const scene = this.#host.scene();
		if (!scene) return;

		const { viewport, selection } = this.#host;
		const currentX = viewport.toGraphX(event.sx);
		const currentY = viewport.toGraphY(event.sy);

		// Normalised, so dragging up or left works.
		const rect: Rect = {
			x: Math.min(this.#startGraphX, currentX),
			y: Math.min(this.#startGraphY, currentY),
			width: Math.abs(currentX - this.#startGraphX),
			height: Math.abs(currentY - this.#startGraphY)
		};
		this.marquee = rect;

		// Reused arrays: a marquee runs at 60fps and would otherwise allocate two
		// arrays of up to 10,000 entries every frame.
		this.#marqueeNodes.length = 0;
		scene.tree.queryRect(rect, this.#marqueeNodes);

		selection.replaceNodes(this.#marqueeNodes, this.#marqueeBase);

		// Edges are selected implicitly, from the node flags that call just
		// committed, so an edge counts only when the box holds both of its ends.
		this.#marqueeEdges.length = 0;
		edgesWithin(scene.anchors, selection.nodeFlags, this.#marqueeEdges);
		selection.setEdges(this.#marqueeEdges);
	}
}
