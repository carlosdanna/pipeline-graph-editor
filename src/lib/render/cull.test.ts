import { describe, expect, it } from 'vitest';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { createEdgeGeometry, writeEdgeGeometry, type EdgeGeometry } from './edge-geometry';
import { cullNodes, edgeVisible, viewRectFor, type ViewRect } from './cull';

/**
 * Culling.
 *
 * Only one direction of error matters. Over-accepting costs a draw call;
 * under-accepting means something on screen is not drawn, which is a hole in the
 * picture. Every test below is shaped to catch the second.
 */

const fixture = generateFixture(2000);
const index = buildGraphIndex(fixture.graph);
const positions = layoutLayered(fixture.graph, index).positions;
const anchors = buildEdgeAnchors(fixture.graph, index);
const WIDTH = 1440;
const HEIGHT = 820;

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A viewport centred on a real node, so the sample actually looks at the graph. */
function viewportOnNode(random: () => number): { x: number; y: number; k: number } {
	const i = Math.floor(random() * fixture.graph.nodes.length);
	const k = 0.05 + random() * 1.5;
	return { k, x: WIDTH / 2 - positions.x[i] * k, y: HEIGHT / 2 - positions.y[i] * k };
}

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

const UNBOUNDED: ViewRect = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

describe('cullNodes', () => {
	const buffer = new Int32Array(fixture.graph.nodes.length);

	it('keeps everything under an unbounded view', () => {
		// This is the "culling off" path the HUD comparison depends on being
		// identical to no culling at all.
		expect(cullNodes(fixture.graph, positions, UNBOUNDED, buffer)).toBe(
			fixture.graph.nodes.length
		);
	});

	it('agrees with a brute-force scan across many viewports', () => {
		const random = rng(0x5150);
		let totalKept = 0;

		for (let s = 0; s < 60; s++) {
			const view = viewRectFor(viewportOnNode(random), WIDTH, HEIGHT);
			const count = cullNodes(fixture.graph, positions, view, buffer);
			totalKept += count;

			const expected: number[] = [];
			for (let i = 0; i < fixture.graph.nodes.length; i++) {
				const n = fixture.graph.nodes[i];
				if (positions.x[i] > view.right || positions.x[i] + n.width < view.left) continue;
				if (positions.y[i] > view.bottom || positions.y[i] + n.height < view.top) continue;
				expected.push(i);
			}

			expect([...buffer.subarray(0, count)]).toEqual(expected);
		}

		expect(totalKept).toBeGreaterThan(0);
	});

	it('returns results in ascending index order', () => {
		const view = viewRectFor({ k: 0.5, x: 0, y: 0 }, WIDTH, HEIGHT);
		const count = cullNodes(fixture.graph, positions, view, buffer);
		for (let i = 1; i < count; i++) expect(buffer[i]).toBeGreaterThan(buffer[i - 1]);
	});
});

describe('viewRectFor', () => {
	it('widens the viewport by the margin, in graph units', () => {
		const view = viewRectFor({ k: 0.5, x: 0, y: 0 }, WIDTH, HEIGHT, 100);
		// 100 screen pixels at half scale is 200 graph units.
		expect(view.left).toBeCloseTo(-200, 6);
		expect(view.right).toBeCloseTo(WIDTH / 0.5 + 200, 6);
	});
});

describe('edgeVisible', () => {
	it('never rejects an edge that is actually on screen, in either geometry', () => {
		const g = createEdgeGeometry();

		for (const straight of [false, true]) {
			const random = rng(straight ? 0xaaa : 0xbbb);
			let accepted = 0;
			let tested = 0;

			for (let s = 0; s < 25; s++) {
				const view = viewRectFor(viewportOnNode(random), WIDTH, HEIGHT);

				for (let e = 0; e < fixture.graph.edges.length; e += 5) {
					const from = anchors.source[e];
					const to = anchors.target[e];
					if (from < 0 || to < 0) continue;
					tested++;

					if (edgeVisible(anchors, positions, e, view, straight)) {
						accepted++;
						continue;
					}

					// Rejected — prove nothing that would be drawn was inside.
					let inside = false;
					if (straight) {
						const ax = positions.x[from] + anchors.sourceCentreX[e];
						const ay = positions.y[from] + anchors.sourceCentreY[e];
						const bx = positions.x[to] + anchors.targetCentreX[e];
						const by = positions.y[to] + anchors.targetCentreY[e];
						for (let t = 0; t <= 24 && !inside; t++) {
							const u = t / 24;
							const x = ax + (bx - ax) * u;
							const y = ay + (by - ay) * u;
							inside = x >= view.left && x <= view.right && y >= view.top && y <= view.bottom;
						}
					} else {
						writeEdgeGeometry(g, anchors, positions, e);
						for (let t = 0; t <= 24 && !inside; t++) {
							const [x, y] = cubicAt(g, t / 24);
							inside = x >= view.left && x <= view.right && y >= view.top && y <= view.bottom;
						}
					}

					expect(inside).toBe(false);
				}
			}

			// Both bounds: zero false rejects proves correctness, a partial accept
			// rate proves the rejecting path was exercised rather than the test
			// being vacuous.
			expect(accepted).toBeGreaterThan(0);
			expect(accepted).toBeLessThan(tested);
		}
	});

	it('rejects a dangling edge', () => {
		const broken = { ...anchors, source: Int32Array.from(anchors.source) };
		broken.source[0] = -1;
		expect(edgeVisible(broken, positions, 0, UNBOUNDED, false)).toBe(false);
	});
});
