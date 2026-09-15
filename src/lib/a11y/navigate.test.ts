import { describe, expect, it } from 'vitest';
import { generateFixture, FIXTURE_SIZES } from '$lib/graph/generate';
import { buildGraphIndex, computeLayers } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { downstream, moveFocus, upstream, type Direction, type NavigationContext } from './navigate';
import { buildAccessibleTree, A11Y_NODE_LIMIT } from './tree';
import { actionFor, KEY_ZOOM_STEP } from './shortcuts';

/**
 * Keyboard navigation.
 *
 * These are the tests that changed the design. Using the first model felt fine —
 * arrows moved, focus went somewhere sensible — and it was quietly broken:
 * pressing down then up returned to the start only 74% of the time and 42 of the
 * 10,000 fixture's stages were reachable from nothing at all. Both are invisible
 * to anyone who has not walked all ten thousand.
 */

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

const built = FIXTURE_SIZES.map((size) => {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	const positions = layoutLayered(fixture.graph, index).positions;
	const layers = computeLayers(fixture.graph, index) ?? new Int32Array(fixture.graph.nodes.length);
	return {
		size,
		graph: fixture.graph,
		index,
		layers,
		anchors: buildEdgeAnchors(fixture.graph, index),
		ctx: { graph: fixture.graph, index, positions, layers } satisfies NavigationContext
	};
});

function centreY(ctx: NavigationContext, node: number): number {
	return ctx.positions.y[node] + ctx.graph.nodes[node].height / 2;
}

describe.each(built)('at $size nodes', (f) => {
	it('never moves to itself or out of range', () => {
		for (let n = 0; n < f.graph.nodes.length; n++) {
			for (const direction of DIRECTIONS) {
				const to = moveFocus(f.ctx, n, direction);
				if (to < 0) continue;
				expect(to).not.toBe(n);
				expect(to).toBeLessThan(f.graph.nodes.length);
			}
		}
	});

	it('left and right follow an edge; up and down stay in the layer', () => {
		for (let n = 0; n < f.graph.nodes.length; n++) {
			const right = moveFocus(f.ctx, n, 'right');
			if (right >= 0) expect(downstream(f.ctx, n)).toContain(right);

			const left = moveFocus(f.ctx, n, 'left');
			if (left >= 0) expect(upstream(f.ctx, n)).toContain(left);

			for (const direction of ['up', 'down'] as const) {
				const to = moveFocus(f.ctx, n, direction);
				if (to >= 0) expect(f.layers[to]).toBe(f.layers[n]);
			}
		}
	});

	it('down then up returns to exactly where it started', () => {
		/*
		 * The property a keyboard user actually feels, and the reason up and down
		 * walk the layer rather than the sibling set: a layer is a total order
		 * once sorted, so this is 100%. "Nearest sibling" managed 74%.
		 */
		let tried = 0;

		for (let n = 0; n < f.graph.nodes.length; n++) {
			const down = moveFocus(f.ctx, n, 'down');
			if (down >= 0) {
				tried++;
				expect(moveFocus(f.ctx, down, 'up')).toBe(n);
			}
			const up = moveFocus(f.ctx, n, 'up');
			if (up >= 0) {
				tried++;
				expect(moveFocus(f.ctx, up, 'down')).toBe(n);
			}
		}

		expect(tried).toBeGreaterThan(0);
	});

	it('moves up and down in the direction it says', () => {
		for (let n = 0; n < f.graph.nodes.length; n++) {
			const up = moveFocus(f.ctx, n, 'up');
			if (up >= 0) {
				// Strictly earlier in the (y, index) order. The index tiebreak is
				// load-bearing: a layered layout can place two nodes on the same row.
				const earlier =
					centreY(f.ctx, up) < centreY(f.ctx, n) ||
					(centreY(f.ctx, up) === centreY(f.ctx, n) && up < n);
				expect(earlier).toBe(true);
			}

			const down = moveFocus(f.ctx, n, 'down');
			if (down >= 0) {
				const later =
					centreY(f.ctx, down) > centreY(f.ctx, n) ||
					(centreY(f.ctx, down) === centreY(f.ctx, n) && down > n);
				expect(later).toBe(true);
			}
		}
	});

	it('reaches every stage from the keyboard', () => {
		// Breadth-first over the four arrow moves only. Anything not reached is a
		// stage a keyboard user simply cannot get to.
		const seen = new Uint8Array(f.graph.nodes.length);
		const queue = [0];
		seen[0] = 1;
		let count = 1;

		for (let head = 0; head < queue.length; head++) {
			for (const direction of DIRECTIONS) {
				const next = moveFocus(f.ctx, queue[head], direction);
				if (next >= 0 && seen[next] === 0) {
					seen[next] = 1;
					count++;
					queue.push(next);
				}
			}
		}

		expect(count).toBe(f.graph.nodes.length);
	});

	it('terminates when one arrow is held down', () => {
		const starts = Math.min(200, f.graph.nodes.length);
		for (let s = 0; s < starts; s++) {
			const start = Math.floor((s * f.graph.nodes.length) / starts);
			for (const direction of DIRECTIONS) {
				const seen = new Set<number>([start]);
				let at = start;
				for (let step = 0; step < 5000; step++) {
					const next = moveFocus(f.ctx, at, direction);
					if (next < 0) break;
					expect(seen.has(next)).toBe(false);
					seen.add(next);
					at = next;
				}
			}
		}
	});

	it('stays put at the end of a branch rather than wrapping', () => {
		// Wrapping would teleport across a 10,000-node graph with no way to notice.
		const sinks = [];
		for (let n = 0; n < f.graph.nodes.length && sinks.length < 5; n++) {
			if (f.index.outgoing[n].length === 0) sinks.push(n);
		}
		expect(sinks.length).toBeGreaterThan(0);
		for (const sink of sinks) expect(moveFocus(f.ctx, sink, 'right')).toBe(-1);
	});

	it('ignores an out-of-range starting point', () => {
		expect(moveFocus(f.ctx, -1, 'right')).toBe(-1);
		expect(moveFocus(f.ctx, f.graph.nodes.length, 'right')).toBe(-1);
	});
});

describe('the accessible tree', () => {
	const f = built[3];
	const visible: number[] = [];
	for (let i = 0; i < A11Y_NODE_LIMIT; i++) visible.push(i);

	it('always describes the focused node and every arrow target', () => {
		/*
		 * The load-bearing invariant: an arrow key must have an element to move
		 * focus to, and it must exist before the viewport pans to reveal it. The
		 * tree asks `moveFocus` rather than assuming one-hop neighbours, which is
		 * what makes it survive a change to the navigation model — and it had to,
		 * because once up and down walked the layer, 28% of arrow presses had
		 * nowhere to land.
		 */
		for (let p = 0; p < 200; p++) {
			const focused = Math.floor((p * f.graph.nodes.length) / 200);
			const tree = buildAccessibleTree(f.ctx, f.anchors, visible, f.graph.nodes.length, focused);
			const members = new Set(tree.nodes);

			expect(members.has(focused)).toBe(true);
			for (const direction of DIRECTIONS) {
				const target = moveFocus(f.ctx, focused, direction);
				if (target >= 0) expect(members.has(target)).toBe(true);
			}
		}
	});

	it('stays bounded whatever is on screen', () => {
		const everything: number[] = [];
		for (let i = 0; i < f.graph.nodes.length; i++) everything.push(i);

		const tree = buildAccessibleTree(f.ctx, f.anchors, everything, f.graph.nodes.length, 5000);
		const extras = f.index.incoming[5000].length + f.index.outgoing[5000].length + 5;
		expect(tree.nodes.length).toBeLessThanOrEqual(A11Y_NODE_LIMIT + extras);
	});

	it('reports truncation, so nothing is quietly elided', () => {
		const tree = buildAccessibleTree(f.ctx, f.anchors, visible, 9000, 5000);
		expect(tree.truncated).toBe(true);
		expect(tree.visibleCount).toBe(9000);
		expect(tree.nodes).toContain(5000);
	});

	it('reports no truncation when it described everything on screen', () => {
		const few = [1, 2, 3, 4];
		const tree = buildAccessibleTree(f.ctx, f.anchors, few, few.length, -1);
		expect(tree.truncated).toBe(false);
		expect(tree.nodes).toEqual(few);
	});

	it('describes only edges that touch the tree', () => {
		const tree = buildAccessibleTree(f.ctx, f.anchors, visible, f.graph.nodes.length, 300);
		const members = new Set(tree.nodes);

		for (const e of tree.edges) {
			const touches = members.has(f.anchors.source[e]) || members.has(f.anchors.target[e]);
			expect(touches).toBe(true);
		}
	});

	it('still describes the screen with nothing focused', () => {
		const tree = buildAccessibleTree(f.ctx, f.anchors, visible, visible.length, -1);
		expect(tree.nodes).toEqual(visible);
	});
});

describe('shortcuts', () => {
	it.each([
		['ArrowUp', 'move'],
		['ArrowDown', 'move'],
		['ArrowLeft', 'move'],
		['ArrowRight', 'move'],
		['Enter', 'select'],
		['Escape', 'clear'],
		['+', 'zoom'],
		['=', 'zoom'],
		['Add', 'zoom'],
		['-', 'zoom'],
		['_', 'zoom'],
		['Subtract', 'zoom'],
		['0', 'fit']
	])('maps %s to %s', (key, type) => {
		expect(actionFor({ key })?.type).toBe(type);
	});

	it('zooms in on plus and out on minus', () => {
		const zoomIn = actionFor({ key: '+' });
		const zoomOut = actionFor({ key: '-' });
		expect(zoomIn).toEqual({ type: 'zoom', factor: KEY_ZOOM_STEP });
		expect(zoomOut?.type).toBe('zoom');
		expect((zoomOut as { factor: number }).factor).toBeCloseTo(1 / KEY_ZOOM_STEP, 12);
	});

	it('treats shift and Enter as additive', () => {
		expect(actionFor({ key: 'Enter' })).toEqual({ type: 'select', additive: false });
		expect(actionFor({ key: 'Enter', shiftKey: true })).toEqual({ type: 'select', additive: true });
	});

	it('leaves the browser its own shortcuts', () => {
		// Ctrl+`-` is page zoom and Meta+0 resets it. Taking those would break the
		// one zoom control a low-vision user already knows.
		for (const key of ['-', '+', '0', 'ArrowDown', 'Enter']) {
			expect(actionFor({ key, ctrlKey: true })).toBeNull();
			expect(actionFor({ key, metaKey: true })).toBeNull();
			expect(actionFor({ key, altKey: true })).toBeNull();
		}
	});

	it('claims nothing it does not own', () => {
		for (const key of ['a', 'Z', 'Tab', 'F5', ' ', 'PageDown', '1', 'Backspace']) {
			expect(actionFor({ key })).toBeNull();
		}
	});
});
