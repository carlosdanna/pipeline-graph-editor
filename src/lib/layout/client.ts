import {
	requestTransfers,
	type LayoutOptions,
	type LayoutRequestMessage,
	type WorkerOutbound
} from './protocol';

/**
 * Main-thread handle on the layout worker.
 *
 * Three policies live here, all of them forced by how elkjs actually behaves:
 *
 * 1. **One job at a time, and a new job cancels the old one by terminating the
 *    worker.** A worker is single-threaded and ELK cannot be interrupted, so
 *    without this a "switch to the 50-node fixture" click would sit behind a
 *    4.6-second 10k layout that nobody wants any more.
 *
 * 2. **Recycle the worker after a large layout.** A warm elkjs instance blows
 *    the JS stack intermittently on a repeat 10k layout — measured here as
 *    ok / fail / ok across three identical runs in one process. Throwing the
 *    instance away after a big job costs a few milliseconds of worker startup
 *    and makes the failure go away.
 *
 * 3. **Retry a stack overflow once, on a fresh worker.** Belt and braces for
 *    the same defect, since it is intermittent rather than deterministic.
 */

export interface LayoutJob {
	readonly nodeId: Int32Array;
	readonly width: Float64Array;
	readonly height: Float64Array;
	/** Empty for a full layout; current positions for an incremental one. */
	readonly seedX: Float64Array;
	readonly seedY: Float64Array;
	readonly edgeSource: Int32Array;
	readonly edgeTarget: Int32Array;
	readonly options: LayoutOptions;
}

export interface LayoutResult {
	readonly nodeId: Int32Array;
	readonly x: Float64Array;
	readonly y: Float64Array;
	/** Time inside elk.layout(). */
	readonly elkMs: number;
	/** Wall clock including worker startup, transfer and retries. */
	readonly totalMs: number;
	readonly retried: boolean;
}

/** Above this many nodes, throw the worker away once the job is done. */
export const WORKER_RECYCLE_NODE_COUNT = 1000;

export class LayoutCancelledError extends Error {
	constructor() {
		super('layout cancelled');
		this.name = 'LayoutCancelledError';
	}
}

interface Inflight {
	readonly requestId: number;
	readonly resolve: (message: WorkerOutbound) => void;
	readonly reject: (error: Error) => void;
}

export class LayoutClient {
	#worker: Worker | null = null;
	#nextRequestId = 1;
	#inflight: Inflight | null = null;

	#spawn(): Worker {
		if (this.#worker) return this.#worker;

		const worker = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module' });
		worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
			const pending = this.#inflight;
			// A response for a job we have already abandoned. Cannot normally
			// happen because cancelling terminates the worker, but a terminated
			// worker's last message can still be in flight.
			if (!pending || pending.requestId !== event.data.requestId) return;
			this.#inflight = null;
			pending.resolve(event.data);
		};
		worker.onerror = (event) => {
			const pending = this.#inflight;
			this.#inflight = null;
			this.#kill();
			pending?.reject(new Error(event.message || 'layout worker crashed'));
		};

		this.#worker = worker;
		return worker;
	}

	#kill(): void {
		this.#worker?.terminate();
		this.#worker = null;
	}

	/** Abandon any running job. The worker dies with it; the next job respawns one. */
	cancel(): void {
		const pending = this.#inflight;
		this.#inflight = null;
		if (pending) {
			this.#kill();
			pending.reject(new LayoutCancelledError());
		}
	}

	async layout(job: LayoutJob): Promise<LayoutResult> {
		this.cancel();
		const startedAt = performance.now();

		let response = await this.#post(job);
		let retried = false;

		if (response.type === 'layout-error' && response.stackOverflow) {
			this.#kill();
			retried = true;
			response = await this.#post(job);
		}

		if (response.type === 'layout-error') {
			this.#kill();
			throw new Error(response.message);
		}

		if (job.nodeId.length >= WORKER_RECYCLE_NODE_COUNT) this.#kill();

		return {
			nodeId: response.nodeId,
			x: response.x,
			y: response.y,
			elkMs: response.elkMs,
			totalMs: performance.now() - startedAt,
			retried
		};
	}

	#post(job: LayoutJob): Promise<WorkerOutbound> {
		const worker = this.#spawn();
		const requestId = this.#nextRequestId++;

		// Copies, because posting transfers the buffers away and a retry needs to
		// send the same data again. Copying ~400KB of typed arrays is well under a
		// millisecond; re-deriving the job from the graph would not be.
		const message: LayoutRequestMessage = {
			type: 'layout',
			requestId,
			nodeId: job.nodeId.slice(),
			width: job.width.slice(),
			height: job.height.slice(),
			seedX: job.seedX.slice(),
			seedY: job.seedY.slice(),
			edgeSource: job.edgeSource.slice(),
			edgeTarget: job.edgeTarget.slice(),
			options: job.options
		};

		return new Promise<WorkerOutbound>((resolve, reject) => {
			this.#inflight = { requestId, resolve, reject };
			worker.postMessage(message, requestTransfers(message));
		});
	}

	dispose(): void {
		this.cancel();
		this.#kill();
	}
}
