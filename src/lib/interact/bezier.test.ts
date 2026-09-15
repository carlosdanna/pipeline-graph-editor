import { describe, expect, it } from 'vitest';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { createEdgeGeometry, writeEdgeGeometry, type EdgeGeometry } from '$lib/render/edge-geometry';
import { distanceSqToCubic, pointSegmentDistanceSq, segmentsFor } from './bezier';

/**
 * Distance to a bezier, and the adaptive flattening that makes it honest.
 *
 * The error budget is the interesting property. A fixed segment count — which is
 * what this was first — is wrong in both directions at once: too coarse on the
 * steep edges a layered layout produces, and wasteful when zoomed out where the
 * tolerance is enormous. Each case below pins one end of that.
 */

const fixture = generateFixture(500);
const index = buildGraphIndex(fixture.graph);
const positions = layoutLayered(fixture.graph, index).positions;
const anchors = buildEdgeAnchors(fixture.graph, index);

function cubicAt(g: EdgeGeometry, t: number): [number, number] {
	const u = 1 - t;
	const w0 = u * u * u;
	const w1 = 3 * u * u * t;
	const w2 = 3 * u * t * t;
	const w3 = t * t * t;
	return [
		w0 * g.fromX + w1 * g.c1x + w2 * g.c2x + w3 * g.toX,
		w0 * g.fromY + w1 * g.c1y + w2 * g.c2y + w3 * g.toY
	];
}

/** Reference distance, flattened far finer than the implementation ever would. */
function referenceDistanceSq(px: number, py: number, g: EdgeGeometry): number {
	const N = 4096;
	let best = Infinity;
	let [prevX, prevY] = cubicAt(g, 0);
	for (let s = 1; s <= N; s++) {
		const [x, y] = cubicAt(g, s / N);
		best = Math.min(best, pointSegmentDistanceSq(px, py, prevX, prevY, x, y));
		prevX = x;
		prevY = y;
	}
	return best;
}

describe('pointSegmentDistanceSq', () => {
	it('clamps to the endpoints rather than the infinite line', () => {
		expect(pointSegmentDistanceSq(-10, 0, 0, 0, 10, 0)).toBe(100);
		expect(pointSegmentDistanceSq(20, 0, 0, 0, 10, 0)).toBe(100);
		expect(pointSegmentDistanceSq(5, 3, 0, 0, 10, 0)).toBe(9);
	});

	it('handles a degenerate segment as a point', () => {
		expect(pointSegmentDistanceSq(3, 4, 0, 0, 0, 0)).toBe(25);
	});
});

describe('segmentsFor', () => {
	it('asks for more segments as the tolerance tightens', () => {
		const g = createEdgeGeometry();
		writeEdgeGeometry(g, anchors, positions, 0);

		const coarse = segmentsFor(g, 100);
		const fine = segmentsFor(g, 0.5);
		expect(fine).toBeGreaterThan(coarse);
	});

	it('stays inside its guard rails for a straight line and a wild curve', () => {
		const straight = createEdgeGeometry();
		Object.assign(straight, { fromX: 0, fromY: 0, c1x: 1, c1y: 0, c2x: 2, c2y: 0, toX: 3, toY: 0 });
		expect(segmentsFor(straight, 1)).toBe(4);

		const wild = createEdgeGeometry();
		Object.assign(wild, {
			fromX: 0,
			fromY: 0,
			c1x: 1e6,
			c1y: -1e6,
			c2x: -1e6,
			c2y: 1e6,
			toX: 10,
			toY: 10
		});
		expect(segmentsFor(wild, 0.001)).toBe(64);
	});
});

describe('distanceSqToCubic', () => {
	it('stays inside the error budget at every zoom the app reaches', () => {
		const g = createEdgeGeometry();

		for (const zoom of [3, 1, 0.25, 0.05, 0.02]) {
			const tolerance = 10 / zoom;
			const budget = tolerance * 0.25;
			let worst = 0;
			let samples = 0;

			for (let e = 0; e < 200; e++) {
				if (!writeEdgeGeometry(g, anchors, positions, e)) continue;
				for (let s = 0; s <= 8; s++) {
					const [cx, cy] = cubicAt(g, s / 8);
					const px = cx + ((s % 3) - 1) * tolerance * 0.5;
					const py = cy + ((s % 5) - 2) * tolerance * 0.3;

					const got = Math.sqrt(distanceSqToCubic(px, py, g, tolerance));
					if (!Number.isFinite(got)) continue;
					worst = Math.max(worst, Math.abs(got - Math.sqrt(referenceDistanceSq(px, py, g))));
					samples++;
				}
			}

			expect(samples).toBeGreaterThan(500);
			expect(worst).toBeLessThanOrEqual(budget);
		}
	});

	it('reads ~0 for points sitting exactly on the curve', () => {
		const g = createEdgeGeometry();
		writeEdgeGeometry(g, anchors, positions, 0);

		const tolerance = 10 / 3;
		for (let s = 0; s <= 20; s++) {
			const [x, y] = cubicAt(g, s / 20);
			expect(Math.sqrt(distanceSqToCubic(x, y, g, tolerance))).toBeLessThanOrEqual(tolerance * 0.25);
		}
	});

	it('never rejects a point that is genuinely on the curve', () => {
		// The control-hull box is the broad phase. It may over-accept; it must
		// never under-accept, or edges become unclickable in places.
		const g = createEdgeGeometry();
		for (let e = 0; e < 400; e++) {
			if (!writeEdgeGeometry(g, anchors, positions, e)) continue;
			const [x, y] = cubicAt(g, 0.5);
			expect(Number.isFinite(distanceSqToCubic(x, y, g, 10))).toBe(true);
		}
	});

	it('rejects far points cheaply', () => {
		const g = createEdgeGeometry();
		writeEdgeGeometry(g, anchors, positions, 0);
		expect(distanceSqToCubic(1e7, 1e7, g, 10)).toBe(Infinity);
	});

	it('resolves the steepest edge in the fixture accurately', () => {
		// The case that broke the fixed-count version: long vertical spans with
		// handles capped at 220 horizontally are the highest-curvature shape here.
		const g = createEdgeGeometry();
		let steepest = 0;
		let mostSegments = 0;

		for (let e = 0; e < fixture.graph.edges.length; e++) {
			if (!writeEdgeGeometry(g, anchors, positions, e)) continue;
			const n = segmentsFor(g, 2.5);
			if (n > mostSegments) {
				mostSegments = n;
				steepest = e;
			}
		}

		writeEdgeGeometry(g, anchors, positions, steepest);
		const [mx, my] = cubicAt(g, 0.5);
		expect(Math.sqrt(distanceSqToCubic(mx, my, g, 10))).toBeLessThan(2.5);
	});
});
