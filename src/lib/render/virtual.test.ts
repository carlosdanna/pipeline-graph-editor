import { describe, expect, it } from 'vitest';
import { OVERSCAN, ROW_HEIGHT, scrollToIndex, windowFor } from './virtual';

/**
 * The virtual window.
 *
 * The brief asks that 100,000 rows scroll smoothly. The largest fixture is
 * 10,000, because ELK cannot lay out 100,000 nodes — so the claim is checked
 * where it is actually a claim about this code: arithmetic that must be
 * independent of row count.
 */

const VIEWPORT = 240;
const ROWS_ON_SCREEN = Math.ceil(VIEWPORT / ROW_HEIGHT);
const MAX_RENDERED = ROWS_ON_SCREEN + 2 * OVERSCAN + 1;

describe('coverage', () => {
	/**
	 * The property that matters, and the only one a spot check would miss: every
	 * row whose pixels fall inside the viewport must be inside the rendered
	 * range. A gap is a blank row on screen.
	 */
	it.each([1, 7, 37, 1000, 100_000])('covers every visible row at %i rows', (rowCount) => {
		const total = rowCount * ROW_HEIGHT;
		const maxScroll = Math.max(0, total - VIEWPORT);
		let samples = 0;
		let worstCount = 0;

		// Step by a prime so the sweep lands off row boundaries as well as on.
		const step = rowCount > 10_000 ? 997 : 7;
		for (let scroll = -50; scroll <= maxScroll + 50; scroll += step) {
			const w = windowFor(scroll, VIEWPORT, rowCount);
			samples++;
			worstCount = Math.max(worstCount, w.count);

			expect(w.first).toBeGreaterThanOrEqual(0);
			expect(w.first + w.count).toBeLessThanOrEqual(rowCount);

			const clamped = Math.max(0, Math.min(scroll, maxScroll));
			const firstNeeded = Math.floor(clamped / ROW_HEIGHT);
			const lastNeeded = Math.min(rowCount - 1, Math.ceil((clamped + VIEWPORT) / ROW_HEIGHT) - 1);

			for (let i = firstNeeded; i <= lastNeeded; i++) {
				expect(i).toBeGreaterThanOrEqual(w.first);
				expect(i).toBeLessThan(w.first + w.count);
			}
		}

		expect(samples).toBeGreaterThan(10);
		expect(worstCount).toBeLessThanOrEqual(MAX_RENDERED);
	});
});

describe('the rendered count does not grow with the list', () => {
	it('renders the same number at 100 rows and at a million', () => {
		const counts = [100, 1_000, 10_000, 100_000, 1_000_000].map((rowCount) => {
			const scroll = (rowCount * ROW_HEIGHT - VIEWPORT) / 2;
			return windowFor(scroll, VIEWPORT, rowCount).count;
		});

		expect(new Set(counts).size).toBe(1);
		expect(counts[0]).toBe(ROWS_ON_SCREEN + 2 * OVERSCAN);
	});
});

describe('edges', () => {
	it('renders nothing for an empty list', () => {
		const w = windowFor(0, VIEWPORT, 0);
		expect(w.count).toBe(0);
		expect(w.totalHeight).toBe(0);
	});

	it('renders nothing before the viewport has been measured', () => {
		const w = windowFor(0, 0, 1000);
		expect(w.count).toBe(0);
		// But still reports the scroll range, so the scrollbar is right from the start.
		expect(w.totalHeight).toBe(1000 * ROW_HEIGHT);
	});

	it('renders all of a list shorter than the viewport', () => {
		const w = windowFor(0, VIEWPORT, 3);
		expect(w.first).toBe(0);
		expect(w.count).toBe(3);
	});

	it('clamps a negative scrollTop from overscroll bounce', () => {
		const w = windowFor(-120, VIEWPORT, 1000);
		expect(w.first).toBe(0);
		expect(w.offsetY).toBe(0);
	});

	it('clamps a scrollTop past the end, which a resize can leave for a frame', () => {
		const w = windowFor(9_999_999, VIEWPORT, 1000);
		expect(w.first + w.count).toBe(1000);
	});

	it('always places the block on a row boundary', () => {
		const w = windowFor(10 * ROW_HEIGHT + 7, VIEWPORT, 1000);
		expect(w.offsetY).toBe(w.first * ROW_HEIGHT);
	});
});

describe('scrollToIndex', () => {
	it('does not scroll for a row already visible', () => {
		expect(scrollToIndex(5, 0, VIEWPORT, 1000)).toBeNull();
		expect(scrollToIndex(ROWS_ON_SCREEN - 1, 0, VIEWPORT, 1000)).toBeNull();
	});

	it('centres a row that is out of view', () => {
		const next = scrollToIndex(500, 0, VIEWPORT, 1000);
		expect(next).toBeCloseTo(500 * ROW_HEIGHT - (VIEWPORT - ROW_HEIGHT) / 2, 6);
	});

	it('clamps at both ends', () => {
		expect(scrollToIndex(1, 5000, VIEWPORT, 1000)).toBe(0);
		expect(scrollToIndex(999, 0, VIEWPORT, 1000)).toBe(1000 * ROW_HEIGHT - VIEWPORT);
	});

	it('ignores out-of-range indices and an unmeasured viewport', () => {
		expect(scrollToIndex(-1, 0, VIEWPORT, 1000)).toBeNull();
		expect(scrollToIndex(1000, 0, VIEWPORT, 1000)).toBeNull();
		expect(scrollToIndex(5, 0, 0, 1000)).toBeNull();
	});

	it('never asks to scroll for a row the user could have clicked', () => {
		/*
		 * This is what breaks the bidirectional-selection loop without a guard
		 * flag. Clicking a row changes the selection, which asks whether to
		 * scroll; the answer must be no, because the row you clicked is by
		 * definition visible.
		 */
		const rowCount = 100_000;
		for (let scroll = 0; scroll < rowCount * ROW_HEIGHT - VIEWPORT; scroll += 4001) {
			const w = windowFor(scroll, VIEWPORT, rowCount);
			for (let i = 0; i < w.count; i++) {
				const index = w.first + i;
				const top = index * ROW_HEIGHT;
				// Overscan rows are rendered but sit outside the viewport.
				if (top < scroll || top + ROW_HEIGHT > scroll + VIEWPORT) continue;
				expect(scrollToIndex(index, scroll, VIEWPORT, rowCount)).toBeNull();
			}
		}
	});
});
