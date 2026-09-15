/**
 * Phase 6: the streaming feed, the batcher, and the claim that an off-screen
 * update costs nothing.
 *
 * `requestAnimationFrame` is shimmed so frames are stepped by hand. That is the
 * whole reason this is testable: "batched into one frame-sized flush" is a
 * statement about frame boundaries, and in a browser you cannot place them.
 */
let pendingFrames: FrameRequestCallback[] = [];
let nextFrameId = 1;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
	pendingFrames.push(cb);
	return nextFrameId++;
};
(globalThis as any).cancelAnimationFrame = (): void => {};

/** Runs every callback queued since the last frame. */
function runFrame(): number {
	const due = pendingFrames;
	pendingFrames = [];
	for (const cb of due) cb(performance.now());
	return due.length;
}

import { generateFixture } from '$lib/graph/generate';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import { NODE_STATUSES } from '$lib/graph/types';
import { UpdateBatcher } from '$lib/stream/batcher.svelte';
import { MockUpdateSource, UPDATE_RATES } from '$lib/stream/source';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

const fixture = generateFixture(10000);
const NODES = fixture.graph.nodes.length;

/** Mirrors the renderer: a small visible window, like being zoomed in at 10k. */
function harness(visibleFrom = 0, visibleTo = 81, canvasOwnsNodes = true) {
	// A frame left pending by an earlier block would be counted by this one.
	pendingFrames = [];

	const dynamics = DynamicsStore.from(fixture.initialDynamics);
	const calls = { repaint: 0 };
	const notified: number[] = [];

	const batcher = new UpdateBatcher(dynamics, {
		isVisible: (i) => i >= visibleFrom && i < visibleTo,
		repaint: () => {
			calls.repaint++;
			return canvasOwnsNodes;
		}
	});

	// Records which nodes were notified, which is the thing the phase claims to
	// keep small. Wrapping rather than reading a counter, so the assertion is
	// about routing and not about a number the batcher reports about itself.
	const realNotify = dynamics.notify.bind(dynamics);
	dynamics.notify = (i: number) => {
		notified.push(i);
		realNotify(i);
	};

	return { dynamics, batcher, calls, notified };
}

const RUNNING = statusIndex('running');
const DEGRADED = statusIndex('degraded');

console.log('\n=== the write is immediate, the notification is batched ===\n');
{
	const h = harness();
	h.batcher.queue(5, DEGRADED, 1234);
	check('the value is readable before any frame runs',
		h.dynamics.status[5] === DEGRADED && h.dynamics.throughput[5] === 1234,
		`status ${h.dynamics.status[5]}, throughput ${h.dynamics.throughput[5]}`);

	// A cell only exists once something has rendered the node.
	const cell = h.dynamics.view(5);
	check('view() reads the current value', cell.status === 'degraded' && cell.throughput === 1234);
}

console.log('\n=== coalescing ===\n');
{
	const h = harness();
	// Render node 7 so it has a cell to notify.
	h.dynamics.view(7);

	for (let i = 0; i < 50; i++) h.batcher.queue(7, RUNNING, 1000 + i);
	check('fifty updates to one node queue exactly one frame', pendingFrames.length === 1,
		`${pendingFrames.length} frames pending`);

	runFrame();
	check('the last value wins', h.dynamics.throughput[7] === 1049,
		`throughput ${h.dynamics.throughput[7]}`);
	check('one notification, not fifty', h.notified.length === 1,
		`${h.notified.length} notifications`);
	check('one repaint request, not fifty', h.calls.repaint === 1, `${h.calls.repaint} repaints`);
}

{
	// Across a frame boundary, the node goes dirty again.
	const h = harness();
	h.batcher.queue(7, RUNNING, 1);
	runFrame();
	h.batcher.queue(7, RUNNING, 2);
	check('a second frame notifies again', pendingFrames.length === 1);
	runFrame();
	check('and the value is current', h.dynamics.throughput[7] === 2);
}

{
	// Distinct nodes are each notified once.
	const h = harness(0, NODES);
	const touched = [1, 2, 3, 1, 2, 3, 1, 2, 3];
	for (const n of touched) h.batcher.queue(n, RUNNING, n * 10);
	runFrame();
	check('three nodes touched nine times notify three times',
		h.notified.length === 3 && new Set(h.notified).size === 3,
		`${h.notified.length} notifications: [${h.notified.join(', ')}]`);
	check('each node holds its own last value',
		h.dynamics.throughput[1] === 10 &&
			h.dynamics.throughput[2] === 20 &&
			h.dynamics.throughput[3] === 30);
}

console.log('\n=== an off-screen update schedules nothing ===\n');
{
	const h = harness(0, 81);
	for (let n = 200; n < 1200; n++) h.batcher.queue(n, RUNNING, n);
	check('a thousand off-screen updates cause zero repaints', h.calls.repaint === 0,
		`${h.calls.repaint} repaints`);
	check('they still queue exactly one flush', pendingFrames.length === 1);
	runFrame();
	check('and the data is current anyway', h.dynamics.throughput[900] === 900);
	check('nothing renders them, so nothing is notified with a cell',
		h.dynamics.cellCount === 0, `${h.dynamics.cellCount} cells`);
}

{
	const h = harness(0, 81);
	for (let n = 200; n < 1200; n++) h.batcher.queue(n, RUNNING, n);
	h.batcher.queue(40, RUNNING, 7);
	check('one on-screen update among a thousand causes exactly one repaint',
		h.calls.repaint === 1, `${h.calls.repaint} repaints`);
	runFrame();
}

{
	// Per-node notification: only the node that changed is notified, even when
	// both are rendered and both have cells.
	const h = harness(0, NODES);
	h.dynamics.view(10);
	h.dynamics.view(11);

	for (let i = 0; i < 20; i++) h.batcher.queue(10, RUNNING, i);
	runFrame();
	check('only the changed node is notified',
		h.notified.length === 1 && h.notified[0] === 10,
		`notified [${h.notified.join(', ')}]`);
}

console.log('\n=== DOM nodes cost the canvas nothing ===\n');
{
	// The requirement read literally: while nodes are elements, a status change
	// must not touch the canvas, because nothing it draws depends on status.
	const h = harness(0, NODES, false);
	for (let i = 0; i < 200; i++) h.dynamics.view(i);
	for (let i = 0; i < 200; i++) h.batcher.queue(i, DEGRADED, i);
	runFrame();
	check('every node notified', h.notified.length === 200, `${h.notified.length} notified`);
	check('the canvas reported no frame needed', h.batcher.monitor.repaints === 0,
		`${h.batcher.monitor.repaints} repaints`);
}

console.log('\n=== structure is never touched ===\n');
{
	const h = harness(0, NODES);
	const graphBefore = fixture.graph;
	const nodeBefore = fixture.graph.nodes[3];
	for (let i = 0; i < 5000; i++) h.batcher.queue(i % NODES, RUNNING, i);
	runFrame();
	check('the graph object is the same reference', fixture.graph === graphBefore);
	check('the node object is untouched', fixture.graph.nodes[3] === nodeBefore);
	check('no status or throughput field appeared on a node',
		!('status' in nodeBefore) && !('throughput' in nodeBefore));
}

console.log('\n=== the source ===\n');
{
	const emitted: number[] = [];
	const source = new MockUpdateSource((n, s, t) => emitted.push(n, s, t), 1234);
	const dyn = DynamicsStore.from(fixture.initialDynamics);
	source.reset(dyn.status, dyn.throughput);

	// Drive the private tick through start/stop with a fake clock would need a
	// timer shim; instead emit directly by starting and stepping setInterval.
	let ticks = 0;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	let tickFn: (() => void) | null = null;
	(globalThis as any).setInterval = (fn: () => void) => {
		tickFn = fn;
		return 1 as unknown as ReturnType<typeof setInterval>;
	};
	(globalThis as any).clearInterval = () => {
		tickFn = null;
	};

	source.setRate(200);
	source.start();
	check('starting the source installs a timer', tickFn !== null);
	for (let i = 0; i < 100; i++) {
		tickFn?.();
		ticks++;
	}
	source.stop();
	(globalThis as any).setInterval = realSetInterval;
	(globalThis as any).clearInterval = realClearInterval;

	const count = emitted.length / 3;
	// 200/sec over a 10ms tick is 2 per tick; 100 ticks is one second of feed.
	check('200/s emits 2 per 10ms tick', count === 200, `${count} updates over ${ticks} ticks`);

	let badStatus = 0;
	let badThroughput = 0;
	for (let i = 0; i < emitted.length; i += 3) {
		const node = emitted[i];
		const status = emitted[i + 1];
		const throughput = emitted[i + 2];
		if (node < 0 || node >= NODES) badStatus++;
		if (status < 0 || status >= NODE_STATUSES.length) badStatus++;
		if (throughput < 0 || !Number.isFinite(throughput)) badThroughput++;
		// A stopped stage reports nothing.
		const name = NODE_STATUSES[status];
		if ((name === 'idle' || name === 'failed') && throughput !== 0) badThroughput++;
	}
	check('every emitted status and node index is in range', badStatus === 0, `${badStatus} bad`);
	check('idle and failed stages report zero throughput', badThroughput === 0,
		`${badThroughput} bad`);
}

{
	// Determinism: the same seed replays exactly.
	const run = (): string => {
		const out: number[] = [];
		const source = new MockUpdateSource((n, s, t) => out.push(n, s, Math.round(t)), 99);
		const dyn = DynamicsStore.from(fixture.initialDynamics);
		source.reset(dyn.status, dyn.throughput);
		let tickFn: (() => void) | null = null;
		const realSetInterval = globalThis.setInterval;
		(globalThis as any).setInterval = (fn: () => void) => {
			tickFn = fn;
			return 1 as unknown as ReturnType<typeof setInterval>;
		};
		source.start();
		for (let i = 0; i < 50; i++) tickFn?.();
		source.stop();
		(globalThis as any).setInterval = realSetInterval;
		return out.join(',');
	};
	check('the same seed replays the same feed', run() === run());
}

console.log('\n=== what a second of feed actually costs ===\n');
console.log('  visible        | updates/s | flushes/s | repaints/s | frames drawn');
console.log('  ---------------|-----------|-----------|------------|-------------');

for (const [label, visible] of [
	['81 / 10,000', 81],
	['316 / 10,000', 316],
	['1,249 / 10,000', 1249],
	['10,000 / 10,000', NODES]
] as const) {
	const h = harness(0, visible as number);
	for (let i = 0; i < (visible as number); i++) h.dynamics.view(i);

	// One second of a 200/s feed, stepped at 60 frames.
	const RATE = 200;
	let flushes = 0;
	let emitted = 0;
	const rng = (() => {
		let a = 0x2468;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	})();

	for (let frame = 0; frame < 60; frame++) {
		for (let i = 0; i < RATE / 60; i++) {
			h.batcher.queue(Math.floor(rng() * NODES), RUNNING, i);
			emitted++;
		}
		// Partial updates accumulate; emit the remainder on some frames.
		if (frame % 3 === 0) {
			h.batcher.queue(Math.floor(rng() * NODES), RUNNING, frame);
			emitted++;
		}
		flushes += runFrame();
	}

	console.log(
		`  ${label.padStart(14)} | ${String(emitted).padStart(9)} | ` +
			`${String(flushes).padStart(9)} | ${String(h.calls.repaint).padStart(10)} | ` +
			`${((h.calls.repaint / 60) * 100).toFixed(0)}% of frames`
	);
}

console.log('\n=== cost ===\n');
console.log('  rate      | per frame | queue ms/frame | flush ms/frame | total ms/frame | budget');
console.log('  ----------|-----------|----------------|----------------|----------------|-------');

function median(v: number[]): number {
	return [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
}

for (const rate of UPDATE_RATES) {
	const h = harness(0, 81);
	// Give the on-screen nodes cells, as the DOM layer would.
	for (let i = 0; i < 81; i++) h.dynamics.view(i);

	const perFrame = Math.round(rate / 60);
	const queueTimes: number[] = [];
	const flushTimes: number[] = [];

	for (let frame = 0; frame < 120; frame++) {
		const t0 = performance.now();
		for (let i = 0; i < perFrame; i++) {
			const node = (frame * 7919 + i * 104729) % NODES;
			h.batcher.queue(node, RUNNING, i);
		}
		const t1 = performance.now();
		runFrame();
		const t2 = performance.now();
		if (frame >= 20) {
			queueTimes.push(t1 - t0);
			flushTimes.push(t2 - t1);
		}
	}

	const q = median(queueTimes);
	const f = median(flushTimes);
	const total = q + f;
	console.log(
		`  ${(rate.toLocaleString() + '/s').padStart(9)} | ${String(perFrame).padStart(9)} | ` +
			`${q.toFixed(3).padStart(14)} | ${f.toFixed(3).padStart(14)} | ` +
			`${total.toFixed(3).padStart(14)} | ${((total / 16.7) * 100).toFixed(1)}%`
	);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
