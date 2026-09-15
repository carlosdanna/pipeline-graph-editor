import { mulberry32, type Rng } from '$lib/graph/rng';
import { NODE_STATUSES } from '$lib/graph/types';

/**
 * A mock telemetry feed: status and throughput changes arriving faster than
 * frames do.
 *
 * Deliberately *not* driven by `requestAnimationFrame`. A real feed is a socket
 * delivering whenever the network delivers, with no relationship to the display
 * refresh, and the whole point of the batcher downstream is to absorb that
 * mismatch. Driving this from rAF would quietly pre-batch the updates and make
 * the batcher look like it was doing something it wasn't.
 *
 * Seeded, like the fixture generator, so a run is reproducible. A measurement
 * taken against `Math.random()` cannot be compared with the one before it.
 */

export type EmitFn = (nodeIndex: number, statusIndex: number, throughput: number) => void;

/** Updates per second. 200 is what the brief asks for; the rest are for watching it break. */
export const UPDATE_RATES = [200, 1000, 5000, 20000] as const;
export type UpdateRate = (typeof UPDATE_RATES)[number];

/**
 * How often the timer fires. Everything due in the interval is emitted at once,
 * which is what a socket flush looks like anyway.
 */
const TICK_MS = 10;

const IDLE = NODE_STATUSES.indexOf('idle');
const RUNNING = NODE_STATUSES.indexOf('running');
const DEGRADED = NODE_STATUSES.indexOf('degraded');
const FAILED = NODE_STATUSES.indexOf('failed');

/**
 * Most traffic is a stage's rate wobbling; a status transition is an event.
 * Nine in ten updates therefore move throughput only, which is also what makes
 * this a fair test — it means most repaints are a changed *number*, the
 * cheapest possible reason to invalidate a node.
 */
const STATUS_CHANGE_CHANCE = 0.1;

export class MockUpdateSource {
	#emit: EmitFn;
	#rng: Rng;
	#timer: ReturnType<typeof setInterval> | null = null;
	#nodeCount = 0;
	#rate: number = UPDATE_RATES[0];

	/** Statuses as the source last emitted them; it drives its own transitions. */
	#status = new Uint8Array(0);
	#throughput = new Float32Array(0);

	constructor(emit: EmitFn, seed = 0xfeed) {
		this.#emit = emit;
		this.#rng = mulberry32(seed);
	}

	get running(): boolean {
		return this.#timer !== null;
	}

	get rate(): number {
		return this.#rate;
	}

	/**
	 * Points the source at a graph, seeding its idea of current state from the
	 * fixture so the first transitions make sense.
	 */
	reset(status: Uint8Array, throughput: Float32Array): void {
		this.#nodeCount = status.length;
		this.#status = new Uint8Array(status);
		this.#throughput = new Float32Array(throughput);
	}

	setRate(rate: number): void {
		this.#rate = rate;
		if (this.running) {
			this.stop();
			this.start();
		}
	}

	start(): void {
		if (this.#timer !== null || this.#nodeCount === 0) return;
		const perTick = Math.max(1, Math.round((this.#rate * TICK_MS) / 1000));
		this.#timer = setInterval(() => this.#tick(perTick), TICK_MS);
	}

	stop(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}

	#tick(count: number): void {
		for (let i = 0; i < count; i++) {
			const node = Math.floor(this.#rng() * this.#nodeCount);
			const status = this.#nextStatus(node);
			const throughput = this.#nextThroughput(node, status);
			this.#status[node] = status;
			this.#throughput[node] = throughput;
			this.#emit(node, status, throughput);
		}
	}

	/**
	 * A small transition model. Not a Markov chain with tuned probabilities —
	 * just enough that statuses move the way an operator would expect, so the
	 * colours on screen tell a story rather than flickering at random.
	 */
	#nextStatus(node: number): number {
		const current = this.#status[node];
		if (this.#rng() > STATUS_CHANGE_CHANCE) return current;

		const roll = this.#rng();
		switch (current) {
			case IDLE:
				return roll < 0.8 ? RUNNING : IDLE;
			case RUNNING:
				return roll < 0.75 ? DEGRADED : roll < 0.95 ? RUNNING : FAILED;
			case DEGRADED:
				return roll < 0.6 ? RUNNING : roll < 0.9 ? DEGRADED : FAILED;
			default:
				return roll < 0.7 ? IDLE : FAILED;
		}
	}

	#nextThroughput(node: number, status: number): number {
		if (status === IDLE || status === FAILED) return 0;

		const current = this.#throughput[node];
		// A stage coming back up has no rate to jitter from, so give it one.
		const base = current > 0 ? current : 200 + this.#rng() * 40000;
		const jitter = 0.85 + this.#rng() * 0.3;
		const ceiling = status === DEGRADED ? 0.35 : 1;

		return Math.max(1, Math.round(base * jitter * ceiling));
	}
}
