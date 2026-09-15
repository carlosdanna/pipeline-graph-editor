import type { DetailLevel } from './limits';
import type { SceneStats } from './scene';

/**
 * The numbers behind the HUD.
 *
 * Deliberately publishes to `$state` at ~5Hz rather than every frame. A HUD that
 * re-renders 60 times a second is itself a workload, and it would be measuring
 * partly its own cost — the instrument must not be the thing that breaks the
 * budget it is reporting on. Frames are counted at full rate internally;
 * only the summary crosses into Svelte's reactivity.
 */

const PUBLISH_INTERVAL_MS = 200;
/** No frames for this long means nothing is moving, so FPS is meaningless. */
const IDLE_AFTER_MS = 400;

export class PerfMonitor {
	fps = $state(0);
	/** Mean time inside the draw call, over the last publish window. */
	frameMs = $state(0);
	/** Worst single draw in the last publish window — where degradation shows. */
	frameMaxMs = $state(0);
	visibleNodes = $state(0);
	totalNodes = $state(0);
	visibleEdges = $state(0);
	edgeCount = $state(0);
	zoom = $state(1);
	/** Which semantic-zoom tier the last frame drew at. */
	detail = $state<DetailLevel>('full');
	/** True when the canvas is drawing node bodies rather than the DOM layer. */
	nodesOnCanvas = $state(false);
	/** False when nothing has been drawn recently; FPS is then not reported. */
	active = $state(false);
	/** Pushed by the session, not measured here. */
	layoutMs = $state<number | null>(null);

	#frames = 0;
	#drawMsSum = 0;
	#drawMsMax = 0;
	#windowStart = 0;
	#lastFrameAt = 0;

	record(now: number, stats: SceneStats, zoom: number): void {
		this.#frames++;
		this.#drawMsSum += stats.drawMs;
		if (stats.drawMs > this.#drawMsMax) this.#drawMsMax = stats.drawMs;
		this.#lastFrameAt = now;
		if (this.#windowStart === 0) this.#windowStart = now;

		const elapsed = now - this.#windowStart;
		if (elapsed >= PUBLISH_INTERVAL_MS) {
			this.fps = Math.round((this.#frames * 1000) / elapsed);
			this.frameMs = this.#drawMsSum / this.#frames;
			this.frameMaxMs = this.#drawMsMax;
			this.#frames = 0;
			this.#drawMsSum = 0;
			this.#drawMsMax = 0;
			this.#windowStart = now;
		}

		// Assign only on change: every write here is a potential re-render.
		if (this.visibleNodes !== stats.visibleNodes) this.visibleNodes = stats.visibleNodes;
		if (this.totalNodes !== stats.totalNodes) this.totalNodes = stats.totalNodes;
		if (this.visibleEdges !== stats.visibleEdges) this.visibleEdges = stats.visibleEdges;
		if (this.edgeCount !== stats.edgeCount) this.edgeCount = stats.edgeCount;
		if (this.zoom !== zoom) this.zoom = zoom;
		if (this.detail !== stats.detail) this.detail = stats.detail;
		if (this.nodesOnCanvas !== stats.nodesOnCanvas) this.nodesOnCanvas = stats.nodesOnCanvas;
		if (!this.active) this.active = true;
	}

	/** Called on a timer by the HUD, so an idle app stops claiming a frame rate. */
	poll(now: number = performance.now()): void {
		if (this.active && now - this.#lastFrameAt > IDLE_AFTER_MS) {
			this.active = false;
			this.fps = 0;
			this.#frames = 0;
			this.#drawMsSum = 0;
			this.#windowStart = 0;
		}
	}
}
