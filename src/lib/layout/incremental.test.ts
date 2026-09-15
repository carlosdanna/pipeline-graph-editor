import { describe, expect, it } from 'vitest';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { addDownstreamStage } from '$lib/graph/mutate';
import { PositionStore } from '$lib/graph/positions';
import { layoutLayered } from './layered';
import { dirtyRegion, incrementalTargets, fullLayoutTargets } from './incremental';
import type { LayoutResult } from './client';

/**
 * Layout diffing.
 *
 * The phase 2 guarantee is absolute and therefore testable exactly: adding a
 * node must not move a single existing one, by a single subpixel. Verified here
 * against the real fixtures rather than against a toy graph, because the thing
 * that would break it is a real graph's connectivity.
 */

const fixture = generateFixture(500);
const index = buildGraphIndex(fixture.graph);
const layout = layoutLayered(fixture.graph, index);

/** Stands in for the worker: ELK's answer, in its own arbitrary coordinate frame. */
function fakeLayoutResult(
	participants: Int32Array,
	place: (node: number, i: number) => [number, number]
): LayoutResult {
	const nodeId = Int32Array.from(participants);
	const x = new Float64Array(participants.length);
	const y = new Float64Array(participants.length);
	for (let i = 0; i < participants.length; i++) {
		const [px, py] = place(participants[i], i);
		x[i] = px;
		y[i] = py;
	}
	return { nodeId, x, y, elkMs: 0, totalMs: 0, retried: false } as LayoutResult;
}

describe('dirtyRegion', () => {
	it('contains the changed nodes as free and nothing else as free', () => {
		const region = dirtyRegion(fixture.graph, index, [42]);
		expect([...region.free]).toEqual([42]);
	});

	it('pulls in exactly the neighbours within the hop limit', () => {
		const region = dirtyRegion(fixture.graph, index, [42], 1);
		const pinned = new Set(region.pinned);

		// Every direct neighbour is present...
		for (const e of index.outgoing[42]) {
			expect(pinned.has(index.nodeIndexById.get(fixture.graph.edges[e].target)!)).toBe(true);
		}
		for (const e of index.incoming[42]) {
			expect(pinned.has(index.nodeIndexById.get(fixture.graph.edges[e].source)!)).toBe(true);
		}

		// ...and every pinned node is reachable in one hop.
		for (const node of pinned) {
			const adjacent =
				index.outgoing[42].some(
					(e) => index.nodeIndexById.get(fixture.graph.edges[e].target) === node
				) ||
				index.incoming[42].some(
					(e) => index.nodeIndexById.get(fixture.graph.edges[e].source) === node
				);
			expect(adjacent).toBe(true);
		}
	});

	it('grows with the hop count but stays far smaller than the graph', () => {
		const sizes = [1, 2, 3].map((hops) => dirtyRegion(fixture.graph, index, [42], hops).participants.length);

		expect(sizes[0]).toBeLessThanOrEqual(sizes[1]);
		expect(sizes[1]).toBeLessThanOrEqual(sizes[2]);
		// The whole point: sub-linear in graph size.
		expect(sizes[2]).toBeLessThan(fixture.graph.nodes.length / 4);
	});

	it('includes only edges with both ends in the region', () => {
		const region = dirtyRegion(fixture.graph, index, [42]);
		const members = new Set([...region.free, ...region.pinned]);

		for (const e of region.edges) {
			const edge = fixture.graph.edges[e];
			expect(members.has(index.nodeIndexById.get(edge.source)!)).toBe(true);
			expect(members.has(index.nodeIndexById.get(edge.target)!)).toBe(true);
		}
	});

	it('never lists a node as both free and pinned', () => {
		const region = dirtyRegion(fixture.graph, index, [10, 200, 480]);
		const free = new Set(region.free);
		for (const node of region.pinned) expect(free.has(node)).toBe(false);
		expect(region.participants.length).toBe(region.free.length + region.pinned.length);
	});

	it('handles a node with no neighbours at all', () => {
		const lonely = { nodes: [fixture.graph.nodes[0]], edges: [] };
		const lonelyIndex = buildGraphIndex(lonely);
		const region = dirtyRegion(lonely, lonelyIndex, [0]);

		expect([...region.free]).toEqual([0]);
		expect(region.pinned.length).toBe(0);
		expect(region.edges.length).toBe(0);
	});
});

describe('incrementalTargets', () => {
	it('never returns a target for an existing node', () => {
		const mutation = addDownstreamStage(fixture.graph, 42);
		const nextIndex = buildGraphIndex(mutation.graph);
		const region = dirtyRegion(mutation.graph, nextIndex, mutation.addedIndices);

		const positions = layout.positions.resized(mutation.graph.nodes.length);
		// ELK answers in a frame translated a long way from ours.
		const result = fakeLayoutResult(region.participants, (node) => [
			positions.x[node] + 9999,
			positions.y[node] - 4444
		]);

		const targets = incrementalTargets(result, region, positions);
		const free = new Set(region.free);

		expect(targets.nodeId.length).toBe(region.free.length);
		for (const node of targets.nodeId) expect(free.has(node)).toBe(true);
	});

	it('cancels a pure translation exactly', () => {
		const mutation = addDownstreamStage(fixture.graph, 42);
		const nextIndex = buildGraphIndex(mutation.graph);
		const region = dirtyRegion(mutation.graph, nextIndex, mutation.addedIndices);

		const positions = layout.positions.resized(mutation.graph.nodes.length);
		const added = mutation.addedIndices[0];
		positions.set(added, 1000, 2000);

		// ELK returns everything shifted by a constant. The fitted offset should
		// undo it precisely, so the free node lands where ELK meant it to.
		const SHIFT_X = -8123.5;
		const SHIFT_Y = 6042.25;
		const result = fakeLayoutResult(region.participants, (node) => [
			positions.x[node] + SHIFT_X,
			positions.y[node] + SHIFT_Y
		]);

		const targets = incrementalTargets(result, region, positions);

		expect(targets.nodeId[0]).toBe(added);
		expect(targets.x[0]).toBeCloseTo(positions.x[added], 6);
		expect(targets.y[0]).toBeCloseTo(positions.y[added], 6);
	});

	it('fits the mean offset when the ring does not agree', () => {
		// Least squares for a pure translation is the mean, so a ring that
		// disagrees should land on the average rather than on any one member.
		const region = dirtyRegion(fixture.graph, index, [42], 1);
		const positions = layout.positions.clone();
		const free = new Set(region.free);

		let pinnedCount = 0;
		const result = fakeLayoutResult(region.participants, (node) => {
			if (free.has(node)) return [0, 0];
			// Offsets of 100, 200, 300, ... so the mean is knowable.
			pinnedCount++;
			return [positions.x[node] - pinnedCount * 100, positions.y[node]];
		});

		const targets = incrementalTargets(result, region, positions);
		const expectedOffset = ((pinnedCount + 1) / 2) * 100;

		expect(targets.x[0]).toBeCloseTo(expectedOffset, 6);
	});

	it('falls back to no offset when there is nothing pinned to fit against', () => {
		const region = dirtyRegion(fixture.graph, index, [42], 0);
		expect(region.pinned.length).toBe(0);

		const positions = layout.positions.clone();
		const result = fakeLayoutResult(region.participants, () => [777, 888]);
		const targets = incrementalTargets(result, region, positions);

		expect(targets.x[0]).toBe(777);
		expect(targets.y[0]).toBe(888);
	});

	it('leaves every existing position untouched, end to end', () => {
		// The phase 2 headline, as an executable claim.
		const mutation = addDownstreamStage(fixture.graph, 200);
		const nextIndex = buildGraphIndex(mutation.graph);
		const region = dirtyRegion(mutation.graph, nextIndex, mutation.addedIndices);

		const positions = layout.positions.resized(mutation.graph.nodes.length);
		const before = positions.clone();

		const result = fakeLayoutResult(region.participants, (node, i) => [
			positions.x[node] + 3000 + i * 0.5,
			positions.y[node] + 3000 - i * 0.25
		]);

		const targets = incrementalTargets(result, region, positions);
		for (let i = 0; i < targets.nodeId.length; i++) {
			positions.set(targets.nodeId[i], targets.x[i], targets.y[i]);
		}

		let moved = 0;
		for (let v = 0; v < fixture.graph.nodes.length; v++) {
			if (positions.x[v] !== before.x[v] || positions.y[v] !== before.y[v]) moved++;
		}

		expect(moved).toBe(0);
	});
});

describe('fullLayoutTargets', () => {
	it('passes the result through unchanged', () => {
		const result = fakeLayoutResult(Int32Array.from([3, 1, 2]), (node) => [node * 10, node * 20]);
		const targets = fullLayoutTargets(result);

		expect([...targets.nodeId]).toEqual([3, 1, 2]);
		expect([...targets.x]).toEqual([30, 10, 20]);
	});
});

describe('PositionStore.resized', () => {
	it('keeps every existing position when growing', () => {
		const store = new PositionStore(3);
		store.set(0, 1, 2);
		store.set(1, 3, 4);
		store.set(2, 5, 6);

		const grown = store.resized(5);

		expect([...grown.x.subarray(0, 3)]).toEqual([1, 3, 5]);
		expect([...grown.y.subarray(0, 3)]).toEqual([2, 4, 6]);
		expect(grown.x[3]).toBe(0);
		expect(grown.count).toBe(5);
	});
});
