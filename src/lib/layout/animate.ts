import type { PositionStore } from '$lib/graph/positions';
import type { PositionTargets } from './incremental';

/**
 * Tweens positions toward a layout result instead of snapping to it.
 *
 * Snapping loses the one piece of information that makes an incremental layout
 * legible: which node moved where. Half a second of motion is the difference
 * between "the graph changed somehow" and "that node slid in there".
 *
 * The animator writes straight into the Float32Arrays of the PositionStore —
 * no allocation per frame, no new graph object, no layout re-run. Svelte cannot
 * see those writes, so callers get an `onFrame(done)` callback and are
 * responsible for triggering a repaint — which the session does by scheduling a
 * canvas frame directly. `done` is true on the final frame, for work that should
 * happen once the graph has settled rather than every frame. In phase 1-2 that means bumping a version counter
 * the SVG depends on; from phase 3 it will just be a canvas redraw, which is
 * what this shape is designed for.
 */

export const LAYOUT_ANIMATION_MS = 420;

/** Decelerating; fast enough to feel responsive, slow enough to follow. */
function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

export function snapTo(positions: PositionStore, targets: PositionTargets): void {
	for (let i = 0; i < targets.nodeId.length; i++) {
		positions.set(targets.nodeId[i], targets.x[i], targets.y[i]);
	}
}

export class PositionAnimator {
	#frame: number | null = null;
	#stopped = true;

	get running(): boolean {
		return !this.#stopped;
	}

	start(
		positions: PositionStore,
		targets: PositionTargets,
		onFrame: (done: boolean) => void,
		durationMs: number = LAYOUT_ANIMATION_MS
	): void {
		this.stop();

		const count = targets.nodeId.length;
		if (count === 0 || durationMs <= 0) {
			snapTo(positions, targets);
			onFrame(true);
			return;
		}

		// Snapshot the starting point once. Reading it per frame would mean
		// interpolating from a value we ourselves just wrote.
		const fromX = new Float64Array(count);
		const fromY = new Float64Array(count);
		for (let i = 0; i < count; i++) {
			fromX[i] = positions.x[targets.nodeId[i]];
			fromY[i] = positions.y[targets.nodeId[i]];
		}

		this.#stopped = false;
		const startedAt = performance.now();

		const step = (now: number): void => {
			const t = Math.min(1, (now - startedAt) / durationMs);
			const e = easeOutCubic(t);

			for (let i = 0; i < count; i++) {
				const v = targets.nodeId[i];
				positions.x[v] = fromX[i] + (targets.x[i] - fromX[i]) * e;
				positions.y[v] = fromY[i] + (targets.y[i] - fromY[i]) * e;
			}

			if (t < 1) {
				onFrame(false);
				this.#frame = requestAnimationFrame(step);
			} else {
				this.#frame = null;
				this.#stopped = true;
				onFrame(true);
			}
		};

		this.#frame = requestAnimationFrame(step);
	}

	stop(): void {
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
		this.#frame = null;
		this.#stopped = true;
	}
}
