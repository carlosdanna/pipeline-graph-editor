/**
 * Coalesces any number of "something changed" calls into one animation frame.
 *
 * Pointer events can arrive faster than the display refreshes — a 1000Hz mouse
 * will deliver several `pointermove`s per frame, and a trackpad fires `wheel`
 * in bursts. Drawing per event would do the same work several times and show
 * none of it. Every input handler in this app therefore does arithmetic and
 * calls `request()`; exactly one draw happens per frame, no matter how many
 * events fed it.
 */
export class FrameScheduler {
	#handle: number | null = null;
	#draw: (now: number) => void;

	constructor(draw: (now: number) => void) {
		this.#draw = draw;
	}

	get pending(): boolean {
		return this.#handle !== null;
	}

	request(): void {
		if (this.#handle !== null) return;
		this.#handle = requestAnimationFrame((now) => {
			this.#handle = null;
			this.#draw(now);
		});
	}

	cancel(): void {
		if (this.#handle !== null) cancelAnimationFrame(this.#handle);
		this.#handle = null;
	}
}
