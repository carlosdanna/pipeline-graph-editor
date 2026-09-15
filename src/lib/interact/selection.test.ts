import { describe, expect, it } from 'vitest';
import { SelectionStore } from './selection.svelte';

/**
 * Selection.
 *
 * Membership lives in `Uint8Array`s rather than a reactive `Set`, so that the
 * canvas can ask "is this selected?" with an array read and a marquee over 2,000
 * nodes costs no DOM work. What *is* reactive is the summary, and the `version`
 * counter that phase 7 had to add — because counts alone are not a sufficient
 * change signal, which is the subtlest thing in this file.
 */

function store(): SelectionStore {
	return new SelectionStore(100, 200);
}

describe('single selection', () => {
	it('selects one node and names it primary', () => {
		const s = store();
		s.selectNode(7);
		expect(s.nodeCount).toBe(1);
		expect(s.hasNode(7)).toBe(true);
		expect(s.primaryNode).toBe(7);
	});

	it('replaces rather than accumulating', () => {
		const s = store();
		s.selectNode(7);
		s.selectNode(9);
		expect(s.nodeCount).toBe(1);
		expect(s.hasNode(7)).toBe(false);
		expect(s.hasNode(9)).toBe(true);
	});

	it('bumps the version even when the count does not change', () => {
		/*
		 * The reason `version` exists. Clicking node A then node B leaves
		 * `nodeCount` at 1 throughout while the selection is different, so a table
		 * watching the count alone would keep highlighting the wrong row.
		 */
		const s = store();
		s.selectNode(7);
		const countBefore = s.nodeCount;
		const versionBefore = s.version;

		s.selectNode(9);

		expect(s.nodeCount).toBe(countBefore);
		expect(s.version).toBeGreaterThan(versionBefore);
	});
});

describe('toggle', () => {
	it('adds then removes', () => {
		const s = store();
		s.selectNode(1);
		s.toggleNode(2);
		expect(s.nodeCount).toBe(2);

		s.toggleNode(2);
		expect(s.nodeCount).toBe(1);
		expect(s.hasNode(1)).toBe(true);
	});

	it('gives up primary when the primary is toggled off', () => {
		const s = store();
		s.selectNode(4);
		s.toggleNode(4);
		expect(s.primaryNode).toBe(-1);
	});
});

describe('edges', () => {
	it('selecting an edge replaces the node selection', () => {
		const s = store();
		s.selectNode(3);
		s.selectEdge(11);
		expect(s.nodeCount).toBe(0);
		expect(s.edgeCount).toBe(1);
		expect(s.primaryNode).toBe(-1);
	});

	it('keeps the node selection when additive', () => {
		const s = store();
		s.selectNode(3);
		s.selectEdge(11, true);
		expect(s.nodeCount).toBe(1);
		expect(s.edgeCount).toBe(1);
	});
});

describe('marquee commits', () => {
	it('replaces from a base snapshot, so shrinking deselects', () => {
		const s = store();
		s.selectNode(1);
		const base = new Uint8Array(s.nodeFlags);

		s.replaceNodes([5, 6, 7], base);
		expect(s.nodeCount).toBe(4);

		// The box shows the result, not a high-water mark.
		s.replaceNodes([5], base);
		expect(s.nodeCount).toBe(2);
		expect(s.hasNode(1)).toBe(true);
		expect(s.hasNode(6)).toBe(false);
	});

	it('starts from nothing with a null base', () => {
		const s = store();
		s.selectNode(1);
		s.replaceNodes([5, 6], null);
		expect(s.nodeCount).toBe(2);
		expect(s.hasNode(1)).toBe(false);
	});

	it('keeps the reported edge count in step with the flags', () => {
		const s = store();
		s.setEdges([2, 4, 6]);
		let counted = 0;
		for (let e = 0; e < s.edgeFlags.length; e++) counted += s.edgeFlags[e];
		expect(s.edgeCount).toBe(counted);
	});
});

describe('resize', () => {
	it('keeps existing selection when the graph grows', () => {
		// Safe as a prefix copy because node indices are append-only.
		const s = store();
		s.selectNode(7);
		s.toggleNode(8);
		s.resize(150, 250);

		expect(s.nodeCount).toBe(2);
		expect(s.hasNode(7)).toBe(true);
		expect(s.nodeFlags.length).toBe(150);
	});

	it('recounts after a shrink drops members', () => {
		const s = store();
		s.selectNode(7);
		s.toggleNode(80);
		s.resize(50, 200);

		expect(s.nodeCount).toBe(1);
		expect(s.hasNode(7)).toBe(true);
	});
});

describe('selectedNodes', () => {
	it('lists members in ascending order', () => {
		const s = store();
		s.selectNode(9);
		s.toggleNode(2);
		s.toggleNode(5);
		expect(s.selectedNodes()).toEqual([2, 5, 9]);
	});
});

describe('clear', () => {
	it('empties everything', () => {
		const s = store();
		s.selectNode(1);
		s.selectEdge(2, true);
		s.clear();

		expect(s.nodeCount).toBe(0);
		expect(s.edgeCount).toBe(0);
		expect(s.primaryNode).toBe(-1);
	});

	it('does nothing when already empty', () => {
		const s = store();
		const version = s.version;
		s.clear();
		expect(s.version).toBe(version);
	});
});
