import type { GraphIndex } from '$lib/graph/indexing';
import { graphBounds, type PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';
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
 * Note that the node layer is `pointer-events: none`. All interaction goes
 * through the surface and (from phase 4) the quadtree, so the interaction model
 * is identical whether nodes happen to be DOM elements or canvas pixels.
 */

export interface Scene {
	readonly graph: PipelineGraph;
	readonly index: GraphIndex;
	readonly positions: PositionStore;
	readonly buckets: EdgeBuckets;
}

export class HybridRenderer {
	readonly viewport: Viewport;

	#perf: PerfMonitor;
	#scheduler: FrameScheduler;

	#canvas: HTMLCanvasElement | null = null;
	#ctx: CanvasRenderingContext2D | null = null;
	#layer: HTMLElement | null = null;
	#surface: HTMLElement | null = null;

	#scene: Scene | null = null;
	#cssWidth = 0;
	#cssHeight = 0;
	#dpr = 1;

	// Cached surface origin. Never read inside a pointer handler.
	#left = 0;
	#top = 0;

	#dragging = false;
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

	/** Frame the whole graph on the next draw, once sizes are known. */
	requestFit(): void {
		this.#pendingFit = true;
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

		element.addEventListener('pointerdown', this.#onPointerDown);
		element.addEventListener('pointermove', this.#onPointerMove);
		element.addEventListener('pointerup', this.#onPointerUp);
		element.addEventListener('pointercancel', this.#onPointerUp);
		// Not passive: zooming must preventDefault to stop the page scrolling.
		element.addEventListener('wheel', this.#onWheel, { passive: false });

		const dprWatcher = this.#watchDevicePixelRatio();

		return () => {
			observer.disconnect();
			window.removeEventListener('resize', remeasure);
			window.removeEventListener('scroll', remeasure, { capture: true });
			element.removeEventListener('pointerdown', this.#onPointerDown);
			element.removeEventListener('pointermove', this.#onPointerMove);
			element.removeEventListener('pointerup', this.#onPointerUp);
			element.removeEventListener('pointercancel', this.#onPointerUp);
			element.removeEventListener('wheel', this.#onWheel);
			dprWatcher();
			this.#scheduler.cancel();
			this.#surface = null;
		};
	};

	// --- Input ---------------------------------------------------------------

	#onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		this.#dragging = true;
		this.#lastPointerX = event.clientX;
		this.#lastPointerY = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	};

	#onPointerMove = (event: PointerEvent): void => {
		if (!this.#dragging) return;
		// Deltas between events, so panning needs no knowledge of where the
		// surface is on screen — and therefore no layout read at all.
		this.viewport.panBy(
			event.clientX - this.#lastPointerX,
			event.clientY - this.#lastPointerY
		);
		this.#lastPointerX = event.clientX;
		this.#lastPointerY = event.clientY;
		this.schedule();
	};

	#onPointerUp = (event: PointerEvent): void => {
		if (!this.#dragging) return;
		this.#dragging = false;
		const element = event.currentTarget as HTMLElement;
		if (element.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
	};

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
