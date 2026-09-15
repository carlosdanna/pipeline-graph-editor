import { describe, expect, it } from 'vitest';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { PositionStore } from '$lib/graph/positions';
import { layoutLayered } from '$lib/layout/layered';
import type { PipelineGraph, Rect } from '$lib/graph/types';
import { NodeQuadtree } from './quadtree';

/**
 * The spatial index.
 *
 * Checked against brute force rather than against expected values, because the
 * thing that can go wrong is not "which node is at this point" but the pruning:
 * d3-quadtree indexes points while our nodes are rectangles, so a query has to
 * be widened before it prunes and every survivor re-tested. A subtly wrong
 * widening produces answers that are right almost everywhere.
 */

const fixture = generateFixture(500);
const index = buildGraphIndex(fixture.graph);
const positions = layoutLayered(fixture.graph, index).positions;

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bruteFind(graph: PipelineGraph, pos: PositionStore, px: number, py: number): number {
	let found = -1;
	for (let i = 0; i < graph.nodes.length; i++) {
		const n = graph.nodes[i];
		if (px >= pos.x[i] && px <= pos.x[i] + n.width && py >= pos.y[i] && py <= pos.y[i] + n.height) {
			found = i;
		}
	}
	return found;
}

function bruteRect(graph: PipelineGraph, pos: PositionStore, r: Rect): number[] {
	const out: number[] = [];
	for (let i = 0; i < graph.nodes.length; i++) {
		const n = graph.nodes[i];
		if (
			pos.x[i] <= r.x + r.width &&
			pos.x[i] + n.width >= r.x &&
			pos.y[i] <= r.y + r.height &&
			pos.y[i] + n.height >= r.y
		) {
			out.push(i);
		}
	}
	return out;
}

describe('findNode', () => {
	const tree = new NodeQuadtree(fixture.graph, positions);

	it('agrees with a brute-force scan over thousands of points', () => {
		const random = rng(0x1234);
		let hits = 0;

		for (let s = 0; s < 3000; s++) {
			let px: number;
			let py: number;

			if (s % 2 === 0) {
				// Inside a real node, so hits are well covered rather than incidental.
				const i = Math.floor(random() * fixture.graph.nodes.length);
				px = positions.x[i] + random() * fixture.graph.nodes[i].width;
				py = positions.y[i] + random() * fixture.graph.nodes[i].height;
			} else {
				px = -2000 + random() * 12000;
				py = -2000 + random() * 12000;
			}

			const actual = tree.findNode(px, py);
			const expected = bruteFind(fixture.graph, positions, px, py);
			expect(actual).toBe(expected);
			if (expected >= 0) hits++;
		}

		// Guard against the test passing because it never found anything.
		expect(hits).toBeGreaterThan(1000);
	});

	it('returns -1 far from the graph', () => {
		expect(tree.findNode(-1e7, -1e7)).toBe(-1);
	});

	it('picks the topmost node when they overlap', () => {
		// Paint order is index order, so a click should get what you can see.
		const stacked = new PositionStore(fixture.graph.nodes.length);
		for (let i = 0; i < stacked.count; i++) stacked.set(i, 500, 500);
		const stackedTree = new NodeQuadtree(fixture.graph, stacked);

		expect(stackedTree.findNode(510, 510)).toBe(fixture.graph.nodes.length - 1);
	});

	it('finds every node in a perfect stack', () => {
		/*
		 * d3-quadtree chains exactly-coincident points onto one leaf as a linked
		 * list rather than subdividing forever, and a layout mid-tween can stack
		 * nodes precisely. Walking only `leaf.data` and not `leaf.next` would lose
		 * them silently — it is the one part of the traversal that looks like
		 * boilerplate and is not.
		 */
		const stacked = new PositionStore(fixture.graph.nodes.length);
		for (let i = 0; i < stacked.count; i++) stacked.set(i, 500, 500);
		const stackedTree = new NodeQuadtree(fixture.graph, stacked);

		const found = stackedTree.queryRect({ x: 400, y: 400, width: 400, height: 400 }, []);
		expect(found.length).toBe(fixture.graph.nodes.length);
	});
});

describe('queryRect', () => {
	const tree = new NodeQuadtree(fixture.graph, positions);

	it('agrees with a brute-force scan over many rectangles', () => {
		const random = rng(0xbeef);
		let caught = 0;

		for (let s = 0; s < 200; s++) {
			const rect: Rect = {
				x: -1000 + random() * 8000,
				y: -1000 + random() * 8000,
				width: random() * 3000,
				height: random() * 3000
			};

			const actual = tree.queryRect(rect, []).sort((a, b) => a - b);
			expect(actual).toEqual(bruteRect(fixture.graph, positions, rect));
			caught += actual.length;
		}

		expect(caught).toBeGreaterThan(0);
	});

	it('catches a node the rectangle only clips a corner of', () => {
		const node = fixture.graph.nodes[0];
		const rect: Rect = {
			x: positions.x[0] + node.width - 1,
			y: positions.y[0] + node.height - 1,
			width: 2,
			height: 2
		};
		expect(tree.queryRect(rect, [])).toContain(0);
	});

	it('appends to the caller-owned array rather than allocating', () => {
		const out: number[] = [];
		const returned = tree.queryRect({ x: 0, y: 0, width: 4000, height: 4000 }, out);
		expect(returned).toBe(out);
	});

	it('returns nothing for a rectangle off the graph', () => {
		expect(tree.queryRect({ x: -1e7, y: -1e7, width: 10, height: 10 }, [])).toEqual([]);
	});
});

describe('staleness', () => {
	it('knows when the graph or positions moved out from under it', () => {
		const tree = new NodeQuadtree(fixture.graph, positions);
		expect(tree.matches(fixture.graph, positions)).toBe(true);
		expect(tree.matches(fixture.graph, positions.clone())).toBe(false);
	});
});

describe('an empty graph', () => {
	it('builds and answers without blowing up', () => {
		const empty: PipelineGraph = { nodes: [], edges: [] };
		const tree = new NodeQuadtree(empty, new PositionStore(0));

		expect(tree.findNode(0, 0)).toBe(-1);
		expect(tree.queryRect({ x: -10, y: -10, width: 20, height: 20 }, [])).toEqual([]);
	});
});
