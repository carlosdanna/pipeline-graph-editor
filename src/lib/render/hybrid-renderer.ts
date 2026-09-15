import type { GraphIndex } from '$lib/graph/indexing';
import { graphBounds, type PositionStore } from '$lib/graph/positions';
import type { PipelineGraph, Rect } from '$lib/graph/types';
import type { SelectionStore } from '$lib/interact/selection.svelte';
import type { EdgeBuckets } from './edge-buckets';
import { FrameScheduler } from './frame';
import type { PerfMonitor } from './perf.svelte';
import { drawScene } from './scene';
import { WHEEL_ZOOM_RATE, type Viewport } from './viewport';

/**
 * Drives the hybrid renderer: a canvas for the grid and edges, and a
 * CSS-transformed DOM layer for node elements, both moved by the same
 * transform in the same frame.
 *
 * Why one class rather than logic inside the component:
 *
 *  - The canvas draw and the DOM layer transform must happen in the *same*
 *    frame. If the layer were positioned through Svelte's reactivity it could
 *    land a frame after the canvas, and nodes would visibly lag their own
 *    edges during a pan. Putting both writes in one rAF callback makes that
 *    impossible by construction.
 *  - Pointer handlers must not read layout. The surface rectangle is measured
 *    in a ResizeObserver and cached here; handlers only ever do arithmetic.
 *  - None of this needs to be reactive, and making it reactive would put proxy
 *    overhead on the hottest path in the app.
 *
 * What it deliberately does NOT own, from phase 4, is what a gesture *means*.
 * DOM events are normalised here — origin-corrected into surface-local CSS
 * pixels, with the delta since the last move — and handed to an `InputTarget`.
 * The split is not tidiness: it is what lets the gesture logic be exercised
 * without a browser, and it keeps the layout-read ban enforceable, because the
 * half of the code that decides things has no element to measure.
 *
 * Note that the node layer is `pointer-events: none`. All interaction goes
 * through the surface and the quadtree, never through a node's own event
 * target, so the interaction model is identical whether nodes happen to be DOM
 * elements or canvas pixels.
 */

export interface Scene {
	readonly graph: PipelineGraph;
	readonly index: GraphIndex;
	readonly positions: PositionStore;
	readonly buckets: EdgeBuckets;
	readonly selection: SelectionStore;
}

/**
 * A pointer event, already reduced to what a gesture needs.
 *
 * `sx`/`sy` are surface-local CSS pixels — the origin correction has already
 * happened, using a rectangle cached outside the pointer path. `dx`/`dy` are
 * the screen-space delta since the previous move, which is what panning wants
 * and which is why panning needs no origin at all.
 */
export interface PointerInput {
	readonly sx: number;
	readonly sy: number;
	readonly dx: number;
	readonly dy: number;
	readonly shiftKey: boolean;
	readonly button: number;
}

export interface InputTarget {
	onPointerDown(event: PointerInput): void;
	onPointerMove(event: PointerInput): void;
	onPointerUp(event: PointerInput): void;
	/** Gesture abandoned — pointer cancelled, or the window lost focus. */
	cancel(): void;
	/** Overlay the gesture wants drawn, in graph units. Read once per frame. */
	readonly marquee: Rect | null;
}

export class HybridRenderer {
	readonly viewport: Viewport;

	#perf: PerfMonitor;
	#scheduler: FrameScheduler;

	#canvas: HTMLCanvasElement | null = null;
	#ctx: CanvasRenderingContext2D | null = null;
	#layer: HTMLElement | null = null;
	#surface: HTMLElement | null = null;
	#input: InputTarget | null = null;

	#scene: Scene | null = null;
	#cssWidth = 0;
	#cssHeight = 0;
	#dpr = 1;

	// Cached surface origin. Never read inside a pointer handler.
	#left = 0;
	#top = 0;

	#pointerId: number | null = null;
	#lastPointerX = 0;
	#lastPointerY = 0;
	#pendingFit = false;

	constructor(viewport: Viewport, perf: PerfMonitor) {
		this.viewport = viewport;
		this.#perf = perf;
		this.#scheduler = new FrameScheduler((now) => this.#draw(now));
	}

	schedule(): void {
		this.#scheduler.request();
	}

	setScene(scene: Scene): void {
		this.#scene = scene;
		this.schedule();
	}

	/** Hands gesture interpretation to the interaction controller. */
	setInput(target: InputTarget): void {
		this.#input = target;
	}

	/** Frame the whole graph on the next draw, once sizes are known. */
	requestFit(): void {
		this.#pendingFit = true;
		this.schedule();
	}

	/** Frame a specific region. Used by "fit selection". */
	fitTo(bounds: Rect): void {
		if (this.#cssWidth === 0) this.#measure();
		this.viewport.fit(bounds, this.#cssWidth, this.#cssHeight);
		this.schedule();
	}

	// --- Attachments ---------------------------------------------------------

	attachCanvas = (element: HTMLCanvasElement): (() => void) => {
		this.#canvas = element;
		this.#ctx = element.getContext('2d', { alpha: false });
		this.#syncSize();
		this.schedule();

		return () => {
			this.#canvas = null;
			this.#ctx = null;
		};
	};

	attachLayer = (element: HTMLElement): (() => void) => {
		this.#layer = element;
		this.#applyLayerTransform();

		return () => {
			this.#layer = null;
		};
	};

	attachSurface = (element: HTMLElement): (() => void) => {
		this.#surface = element;

		const observer = new ResizeObserver(() => {
			this.#measure();
			this.#syncSize();
			this.schedule();
		});
		observer.observe(element);

		// Scroll and resize move the surface without changing its size, so the
		// cached origin has to be refreshed. Both are outside the pointer path.
		const remeasure = () => this.#measure();
		window.addEventListener('resize', remeasure, { passive: true });
		window.addEventListener('scroll', remeasure, { passive: true, capture: true });
		window.addEventListener('blur', this.#onBlur);

		element.addEventListener('pointerdown', this.#onPointerDown);
		element.addEventListener('pointermove', this.#onPointerMove);
		element.addEventListener('pointerup', this.#onPointerUp);
		element.addEventListener('pointercancel', this.#onPointerCancel);
		// Not passive: zooming must preventDefault to stop the page scrolling.
		element.addEventListener('wheel', this.#onWheel, { passive: false });

		const dprWatcher = this.#watchDevicePixelRatio();

		return () => {
			observer.disconnect();
			window.removeEventListener('resize', remeasure);
			window.removeEventListener('scroll', remeasure, { capture: true });
			window.removeEventListener('blur', this.#onBlur);
			element.removeEventListener('pointerdown', this.#onPointerDown);
			element.removeEventListener('pointermove', this.#onPointerMove);
			element.removeEventListener('pointerup', this.#onPointerUp);
			element.removeEventListener('pointercancel', this.#onPointerCancel);
			element.removeEventListener('wheel', this.#onWheel);
			dprWatcher();
			this.#scheduler.cancel();
			this.#surface = null;
		};
	};

	// --- Input ---------------------------------------------------------------

	/**
	 * Normalises a DOM pointer event. The only place client coordinates are
	 * turned into surface coordinates, and it uses the cached origin — so no
	 * pointer handler in this app ever triggers a layout.
	 */
	#normalise(event: PointerEvent): PointerInput {
		const dx = event.clientX - this.#lastPointerX;
		const dy = event.clientY - this.#lastPointerY;
		this.#lastPointerX = event.clientX;
		this.#lastPointerY = event.clientY;

		return {
			sx: event.clientX - this.#left,
			sy: event.clientY - this.#top,
			dx,
			dy,
			shiftKey: event.shiftKey,
			button: event.button
		};
	}

	#onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0 && event.button !== 1) return;
		// Stops middle-click autoscroll, and stops a drag from selecting page text.
		event.preventDefault();

		this.#lastPointerX = event.clientX;
		this.#lastPointerY = event.clientY;
		this.#pointerId = event.pointerId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

		this.#input?.onPointerDown(this.#normalise(event));
	};

	#onPointerMove = (event: PointerEvent): void => {
		if (this.#pointerId !== event.pointerId) return;
		this.#input?.onPointerMove(this.#normalise(event));
	};

	#onPointerUp = (event: PointerEvent): void => {
		if (this.#pointerId !== event.pointerId) return;
		this.#releaseCapture(event);
		this.#input?.onPointerUp(this.#normalise(event));
	};

	#onPointerCancel = (event: PointerEvent): void => {
		if (this.#pointerId !== event.pointerId) return;
		this.#releaseCapture(event);
		this.#input?.cancel();
	};

	#onBlur = (): void => {
		// A drag interrupted by an alt-tab never sees a pointerup, and would
		// otherwise resume the next time the pointer moved over the surface.
		if (this.#pointerId !== null) {
			this.#pointerId = null;
			this.#input?.cancel();
		}
	};

	#releaseCapture(event: PointerEvent): void {
		this.#pointerId = null;
		const element = event.currentTarget as HTMLElement | null;
		if (element?.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
	}

	#onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		// deltaMode 1 is lines rather than pixels — Firefox reports it for mouse
		// wheels. Exponential so that zooming feels the same at every scale.
		const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
		this.viewport.zoomBy(
			Math.exp(-pixels * WHEEL_ZOOM_RATE),
			event.clientX - this.#left,
			event.clientY - this.#top
		);
		this.schedule();
	};

	// --- Sizing --------------------------------------------------------------

	#measure(): void {
		if (!this.#surface) return;
		const rect = this.#surface.getBoundingClientRect();
		this.#left = rect.left;
		this.#top = rect.top;
		this.#cssWidth = rect.width;
		this.#cssHeight = rect.height;
	}

	/**
	 * Sizes the canvas backing store for the current device pixel ratio. The CSS
	 * size stays in CSS pixels; the backing store is dpr times bigger, and the
	 * draw code compensates with a single setTransform.
	 */
	#syncSize(): void {
		if (!this.#canvas) return;
		if (this.#cssWidth === 0) this.#measure();

		this.#dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(this.#cssWidth * this.#dpr));
		const height = Math.max(1, Math.round(this.#cssHeight * this.#dpr));

		// Assigning width/height clears the canvas, so only do it on real change.
		if (this.#canvas.width !== width) this.#canvas.width = width;
		if (this.#canvas.height !== height) this.#canvas.height = height;
	}

	/** Re-syncs when the window moves between displays of different density. */
	#watchDevicePixelRatio(): () => void {
		let query: MediaQueryList | null = null;

		const listen = (): void => {
			query?.removeEventListener('change', onChange);
			query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
			query.addEventListener('change', onChange);
		};
		const onChange = (): void => {
			this.#syncSize();
			this.schedule();
			listen();
		};

		listen();
		return () => query?.removeEventListener('change', onChange);
	}

	// --- Frame ---------------------------------------------------------------

	#applyLayerTransform(): void {
		if (!this.#layer) return;
		const { x, y, k } = this.viewport;
		this.#layer.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
	}

	#draw(now: number): void {
		const scene = this.#scene;
		const ctx = this.#ctx;
		if (!scene || !ctx) return;

		if (this.#pendingFit && this.#cssWidth > 0) {
			this.viewport.fit(
				graphBounds(scene.graph, scene.positions),
				this.#cssWidth,
				this.#cssHeight
			);
			this.#pendingFit = false;
		}

		const stats = drawScene(ctx, {
			graph: scene.graph,
			index: scene.index,
			positions: scene.positions,
			buckets: scene.buckets,
			selection: scene.selection,
			marquee: this.#input?.marquee ?? null,
			viewport: this.viewport,
			cssWidth: this.#cssWidth,
			cssHeight: this.#cssHeight,
			devicePixelRatio: this.#dpr
		});

		// Same frame as the canvas draw. This is the whole point of the class.
		this.#applyLayerTransform();

		this.#perf.record(now, stats, this.viewport.k);
	}
}
