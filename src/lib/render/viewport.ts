import type { Rect } from '$lib/graph/types';

/**
 * The single transform shared by the canvas and the DOM node layer.
 *
 * screen = graph * k + translate
 *
 * Deliberately NOT reactive. It is read by imperative draw code every frame and
 * written by pointer handlers several times per frame; wrapping it in `$state`
 * would add proxy overhead to the hottest path in the app and buy nothing,
 * because nothing in the template is derived from it. Anything that needs to
 * *display* the zoom level gets it pushed once per frame by the perf monitor.
 *
 * Every method here is arithmetic only. Nothing in this file touches the DOM,
 * which is what lets pointer handlers call it without a layout read.
 */

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 4;

/** Wheel delta to zoom exponent. Tuned for a trackpad; a mouse wheel is coarser. */
export const WHEEL_ZOOM_RATE = 0.0015;

export class Viewport {
	x = 0;
	y = 0;
	k = 1;

	toScreenX(graphX: number): number {
		return graphX * this.k + this.x;
	}

	toScreenY(graphY: number): number {
		return graphY * this.k + this.y;
	}

	toGraphX(screenX: number): number {
		return (screenX - this.x) / this.k;
	}

	toGraphY(screenY: number): number {
		return (screenY - this.y) / this.k;
	}

	/** Pan by a screen-space delta. */
	panBy(dx: number, dy: number): void {
		this.x += dx;
		this.y += dy;
	}

	/**
	 * Zoom so that the graph point currently under (screenX, screenY) stays
	 * under it. Solve `screenX = g * k' + x'` for the new translation.
	 */
	zoomTo(k: number, screenX: number, screenY: number): void {
		const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
		if (next === this.k) return;

		const graphX = this.toGraphX(screenX);
		const graphY = this.toGraphY(screenY);
		this.k = next;
		this.x = screenX - graphX * next;
		this.y = screenY - graphY * next;
	}

	zoomBy(factor: number, screenX: number, screenY: number): void {
		this.zoomTo(this.k * factor, screenX, screenY);
	}

	/** Frame `bounds` inside a viewport of the given CSS size. */
	fit(bounds: Rect, width: number, height: number, padding = 48): void {
		if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) return;

		const k = Math.min(
			(width - padding * 2) / bounds.width,
			(height - padding * 2) / bounds.height
		);
		this.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
		this.x = width / 2 - (bounds.x + bounds.width / 2) * this.k;
		this.y = height / 2 - (bounds.y + bounds.height / 2) * this.k;
	}

	/** The part of graph space currently on screen. The basis of culling. */
	visibleRect(width: number, height: number): Rect {
		const x = this.toGraphX(0);
		const y = this.toGraphY(0);
		return { x, y, width: width / this.k, height: height / this.k };
	}
}
