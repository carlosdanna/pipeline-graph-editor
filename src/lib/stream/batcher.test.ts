import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import { UpdateBatcher, type BatcherHost } from './batcher.svelte';

/**
 * Batching.
 *
 * `requestAnimationFrame` is replaced with a queue stepped by hand. That is the
 * only reason any of this is testable: "batched into one frame-sized flush" is a
 * claim about frame boundaries, and in a real browser you cannot place them.
 *
 * Unlike the tools/ benchmarks, this runs against real runes — the Svelte plugin
 * compiles `.svelte.ts` here — so the store under test is the one that ships.
 */

let pending: FrameRequestCallback[] = [];

function runFrame(): void {
	const due = pending;
	pending = [];
	for (const cb of due) cb(performance.now());
}

beforeEach(() => {
	pending = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		pending.push(cb);
		return pending.length;
	});
	vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => vi.unstubAllGlobals());

const RUNNING = statusIndex('running');
const FAILED = statusIndex('failed');
const NODES = 500;

function harness(isVisible: (i: number) => boolean = () => true, canvasOwnsNodes = true) {
	const dynamics = new DynamicsStore(NODES);
	const notified: number[] = [];
	let repaintCalls = 0;

	const realNotify = dynamics.notify.bind(dynamics);
	dynamics.notify = (i: number) => {
		notified.push(i);
		realNotify(i);
	};

	const host: BatcherHost = {
		isVisible,
		repaint: () => {
			repaintCalls++;
			return canvasOwnsNodes;
		}
	};

	const batcher = new UpdateBatcher(dynamics, host);
	return {
		dynamics,
		batcher,
		notified,
		get repaintCalls() {
			return repaintCalls;
		}
	};
}

describe('the write is immediate, the notification is batched', () => {
	it('exposes the new value before any frame runs', () => {
		const h = harness();
		h.batcher.queue(5, FAILED, 1234);

		expect(h.dynamics.status[5]).toBe(FAILED);
		expect(h.dynamics.throughput[5]).toBe(1234);
		expect(h.notified).toEqual([]);
	});

	it('notifies on the next frame', () => {
		const h = harness();
		h.batcher.queue(5, RUNNING, 10);
		runFrame();
		expect(h.notified).toEqual([5]);
	});
});

describe('coalescing', () => {
	it('collapses many updates to one node into one notification', () => {
		const h = harness();
		for (let i = 0; i < 50; i++) h.batcher.queue(7, RUNNING, 1000 + i);

		expect(pending.length).toBe(1);
		runFrame();

		expect(h.notified).toEqual([7]);
		// Last write wins — coalescing falls out of the storage, not from merging.
		expect(h.dynamics.throughput[7]).toBe(1049);
	});

	it('notifies each distinct node exactly once', () => {
		const h = harness();
		for (const n of [1, 2, 3, 1, 2, 3, 1]) h.batcher.queue(n, RUNNING, n * 10);
		runFrame();

		expect([...h.notified].sort((a, b) => a - b)).toEqual([1, 2, 3]);
		expect(h.dynamics.throughput[1]).toBe(10);
		expect(h.dynamics.throughput[3]).toBe(30);
	});

	it('goes dirty again across a frame boundary', () => {
		const h = harness();
		h.batcher.queue(7, RUNNING, 1);
		runFrame();
		h.batcher.queue(7, RUNNING, 2);
		runFrame();

		expect(h.notified).toEqual([7, 7]);
		expect(h.dynamics.throughput[7]).toBe(2);
	});

	it('requests at most one frame however many updates arrive', () => {
		const h = harness();
		for (let n = 0; n < NODES; n++) h.batcher.queue(n, RUNNING, n);
		expect(pending.length).toBe(1);
		runFrame();
		expect(h.notified.length).toBe(NODES);
	});
});

describe('off-screen updates schedule nothing', () => {
	const onlyFirst80 = (i: number) => i < 80;

	it('asks for no repaint when nothing visible changed', () => {
		const h = harness(onlyFirst80);
		for (let n = 100; n < 400; n++) h.batcher.queue(n, RUNNING, n);

		expect(h.repaintCalls).toBe(0);
		runFrame();
		// The data is still current — only the painting was skipped.
		expect(h.dynamics.throughput[250]).toBe(250);
	});

	it('asks exactly once when one visible node is among many', () => {
		const h = harness(onlyFirst80);
		for (let n = 100; n < 400; n++) h.batcher.queue(n, RUNNING, n);
		h.batcher.queue(40, RUNNING, 7);
		h.batcher.queue(41, RUNNING, 8);

		expect(h.repaintCalls).toBe(1);
	});

	it('still notifies them, so anything that later renders them is correct', () => {
		// Notification is cheap and unconditional; it is the *repaint* that is
		// gated on visibility. Skipping the notify would leave a node stale the
		// moment it scrolled into view.
		const h = harness(onlyFirst80);
		for (let n = 100; n < 110; n++) h.batcher.queue(n, RUNNING, n);
		runFrame();
		expect(h.notified.length).toBe(10);
	});
});

describe('DOM nodes cost the canvas nothing', () => {
	it('reports no repaints while the canvas does not own the bodies', () => {
		// Requirement 3 read literally: nothing the canvas draws depends on
		// status, so while nodes are elements a status change must not touch it.
		const h = harness(
			() => true,
			/* canvasOwnsNodes */ false
		);
		for (let n = 0; n < 200; n++) h.batcher.queue(n, FAILED, n);
		runFrame();

		expect(h.notified.length).toBe(200);
		expect(h.batcher.monitor.repaints).toBe(0);
	});
});

describe('resize and reset', () => {
	it('keeps pending work valid when the graph grows', () => {
		const h = harness();
		h.batcher.queue(10, RUNNING, 1);
		h.batcher.resize(NODES + 1);
		runFrame();
		expect(h.notified).toEqual([10]);
	});

	it('drops everything pending on reset', () => {
		const h = harness();
		h.batcher.queue(10, RUNNING, 1);
		h.batcher.reset();
		runFrame();
		expect(h.notified).toEqual([]);
	});

	it('lets a node go dirty again after a reset', () => {
		const h = harness();
		h.batcher.queue(10, RUNNING, 1);
		h.batcher.reset();
		h.batcher.queue(10, RUNNING, 2);
		runFrame();
		expect(h.notified).toEqual([10]);
	});
});

describe('structure is never touched', () => {
	it('adds no fields and changes no object identity', () => {
		const h = harness();
		const statusArray = h.dynamics.status;

		for (let i = 0; i < 1000; i++) h.batcher.queue(i % NODES, RUNNING, i);
		runFrame();

		// The store writes in place; only a resize may replace the arrays.
		expect(h.dynamics.status).toBe(statusArray);
	});
});
