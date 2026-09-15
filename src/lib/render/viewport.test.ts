import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, Viewport } from './viewport';
import { gridStep } from './scene';

/**
 * The transform maths.
 *
 * Every pixel the app draws goes through this, and it is the one part of the
 * renderer that is pure arithmetic, so it can be pinned down exactly rather
 * than eyeballed. The properties below are the ones the rest of the app assumes
 * without checking.
 */

describe('screen and graph coordinates round-trip', () => {
	it('inverts exactly across the whole zoom range', () => {
		const viewport = new Viewport();
		let worst = 0;

		for (const k of [MIN_ZOOM, 0.05, 0.25, 1, 2.5, MAX_ZOOM]) {
			viewport.k = k;
			viewport.x = -1234.5;
			viewport.y = 987.25;

			for (const value of [-50000, -1000, 0, 37.5, 1000, 50000]) {
				worst = Math.max(worst, Math.abs(viewport.toGraphX(viewport.toScreenX(value)) - value));
				worst = Math.max(worst, Math.abs(viewport.toGraphY(viewport.toScreenY(value)) - value));
			}
		}

		expect(worst).toBeLessThan(1e-8);
	});
});

describe('zoom holds the point under the cursor', () => {
	/**
	 * The defining property of zoom-toward-cursor, and the one that is instantly
	 * obvious when broken but easy to get subtly wrong: whatever graph point sits
	 * under the pointer must still sit under it afterwards.
	 */
	it('keeps the anchored graph point fixed at every scale and factor', () => {
		const viewport = new Viewport();
		let worst = 0;

		for (const startK of [0.05, 0.2, 1, 3]) {
			for (const factor of [0.1, 0.5, 0.99, 1.01, 2, 4]) {
				for (const [sx, sy] of [
					[0, 0],
					[720, 410],
					[1439, 819]
				]) {
					viewport.k = startK;
					viewport.x = 100;
					viewport.y = -250;

					const before = [viewport.toGraphX(sx), viewport.toGraphY(sy)];
					viewport.zoomBy(factor, sx, sy);
					const after = [viewport.toGraphX(sx), viewport.toGraphY(sy)];

					// Skip the clamped cases: at the limits the anchor cannot hold,
					// because the zoom did not fully happen.
					if (viewport.k === MIN_ZOOM || viewport.k === MAX_ZOOM) continue;

					worst = Math.max(worst, Math.abs(after[0] - before[0]));
					worst = Math.max(worst, Math.abs(after[1] - before[1]));
				}
			}
		}

		expect(worst).toBeLessThan(1e-9);
	});

	it('clamps to the zoom limits without moving the view wildly', () => {
		const viewport = new Viewport();

		viewport.k = MAX_ZOOM;
		viewport.zoomBy(10, 100, 100);
		expect(viewport.k).toBe(MAX_ZOOM);

		viewport.k = MIN_ZOOM;
		viewport.zoomBy(0.001, 100, 100);
		expect(viewport.k).toBe(MIN_ZOOM);
	});

	it('does nothing at all when the scale would not change', () => {
		const viewport = new Viewport();
		viewport.k = MAX_ZOOM;
		viewport.x = 42;
		viewport.y = -17;

		viewport.zoomBy(2, 500, 300);

		expect(viewport.x).toBe(42);
		expect(viewport.y).toBe(-17);
	});
});

describe('pan', () => {
	it('moves by the screen delta, independent of zoom', () => {
		const viewport = new Viewport();
		viewport.k = 0.25;
		viewport.panBy(30, -12);
		expect(viewport.x).toBe(30);
		expect(viewport.y).toBe(-12);
	});
});

describe('fit', () => {
	const WIDTH = 1440;
	const HEIGHT = 820;

	it('centres the bounds and keeps them inside the padding', () => {
		const viewport = new Viewport();
		const bounds = { x: -500, y: 2000, width: 30029, height: 33553 };
		viewport.fit(bounds, WIDTH, HEIGHT);

		const left = viewport.toScreenX(bounds.x);
		const right = viewport.toScreenX(bounds.x + bounds.width);
		const top = viewport.toScreenY(bounds.y);
		const bottom = viewport.toScreenY(bounds.y + bounds.height);

		expect(left).toBeGreaterThanOrEqual(-0.001);
		expect(right).toBeLessThanOrEqual(WIDTH + 0.001);
		expect(top).toBeGreaterThanOrEqual(-0.001);
		expect(bottom).toBeLessThanOrEqual(HEIGHT + 0.001);

		// Centred: the margins match on each axis.
		expect(left).toBeCloseTo(WIDTH - right, 6);
		expect(top).toBeCloseTo(HEIGHT - bottom, 6);
	});

	it('leaves a degenerate or unmeasured viewport alone', () => {
		const viewport = new Viewport();
		viewport.k = 1;
		viewport.x = 5;

		viewport.fit({ x: 0, y: 0, width: 0, height: 100 }, WIDTH, HEIGHT);
		viewport.fit({ x: 0, y: 0, width: 100, height: 100 }, 0, 0);

		expect(viewport.k).toBe(1);
		expect(viewport.x).toBe(5);
	});

	it('still clamps when the graph is far larger than the floor allows', () => {
		// The 10k fixture needs k = 0.0216 against a floor of 0.02 — nearly
		// binding. A much bigger graph must clamp rather than go below it.
		const viewport = new Viewport();
		viewport.fit({ x: 0, y: 0, width: 5_000_000, height: 5_000_000 }, WIDTH, HEIGHT);
		expect(viewport.k).toBe(MIN_ZOOM);
	});
});

describe('visibleRect', () => {
	it('describes exactly the graph region on screen', () => {
		const viewport = new Viewport();
		viewport.k = 0.4;
		viewport.x = -300;
		viewport.y = 120;

		const rect = viewport.visibleRect(1440, 820);

		expect(viewport.toScreenX(rect.x)).toBeCloseTo(0, 9);
		expect(viewport.toScreenY(rect.y)).toBeCloseTo(0, 9);
		expect(viewport.toScreenX(rect.x + rect.width)).toBeCloseTo(1440, 9);
		expect(viewport.toScreenY(rect.y + rect.height)).toBeCloseTo(820, 9);
	});
});

describe('grid spacing', () => {
	/**
	 * `gridStep` contains two `while` loops over the zoom. An unbounded one would
	 * hang the frame rather than merely look wrong, which is why this is tested
	 * across the range rather than at a couple of points.
	 */
	it('keeps on-screen spacing between 24 and 96 pixels at every zoom', () => {
		let worstLines = 0;

		for (let k = MIN_ZOOM; k <= MAX_ZOOM; k *= 1.05) {
			const step = gridStep(k);
			const onScreen = step * k;

			expect(onScreen).toBeGreaterThanOrEqual(24);
			expect(onScreen).toBeLessThanOrEqual(96);
			expect(step).toBeGreaterThan(0);
			expect(Number.isFinite(step)).toBe(true);

			worstLines = Math.max(worstLines, 1440 / onScreen);
		}

		// Bounded line count is the real guarantee: 1440 / 24 = 60.
		expect(worstLines).toBeLessThanOrEqual(60);
	});
});
