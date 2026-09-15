/**
 * Phase 7: the virtual window.
 *
 * The brief asks that 100,000 rows scroll smoothly. The app's largest fixture is
 * 10,000, because ELK cannot lay out 100,000 nodes in any reasonable time — so
 * the 100k claim is tested here, against the windowing arithmetic itself, which
 * is the part that has to be independent of row count. Everything below is pure
 * functions over four numbers; no DOM is involved, and none is needed.
 */
import { ROW_HEIGHT, OVERSCAN, windowFor, scrollToIndex } from '$lib/render/virtual';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

const VIEWPORT = 240;
const ROWS_ON_SCREEN = Math.ceil(VIEWPORT / ROW_HEIGHT);
/** The most rows that can ever be asked for: the screenful plus both overscans. */
const MAX_RENDERED = ROWS_ON_SCREEN + 2 * OVERSCAN + 1;

console.log('\n=== the window covers what is on screen ===\n');
{
	// The property that matters: every row whose pixels fall inside the viewport
	// must be inside the rendered range. A gap here is a blank row on screen.
	for (const rowCount of [1, 7, 37, 1000, 100_000]) {
		const total = rowCount * ROW_HEIGHT;
		const maxScroll = Math.max(0, total - VIEWPORT);
		let gaps = 0;
		let outOfRange = 0;
		let worstCount = 0;
		let samples = 0;

		// Step by a prime so the sweep lands off row boundaries as well as on.
		for (let scroll = -50; scroll <= maxScroll + 50; scroll += 7) {
			const w = windowFor(scroll, VIEWPORT, rowCount);
			samples++;
			worstCount = Math.max(worstCount, w.count);

			if (w.first < 0 || w.first + w.count > rowCount) outOfRange++;

			const clamped = Math.max(0, Math.min(scroll, maxScroll));
			const firstNeeded = Math.floor(clamped / ROW_HEIGHT);
			const lastNeeded = Math.min(
				rowCount - 1,
				Math.ceil((clamped + VIEWPORT) / ROW_HEIGHT) - 1
			);
			for (let i = firstNeeded; i <= lastNeeded; i++) {
				if (i < w.first || i >= w.first + w.count) {
					gaps++;
					break;
				}
			}
		}

		check(
			`covers every visible row  rows=${String(rowCount).padStart(7)}`,
			gaps === 0 && outOfRange === 0,
			`${samples} scroll positions, ${gaps} gaps, ${outOfRange} out of range`
		);
		check(
			`renders a bounded number   rows=${String(rowCount).padStart(7)}`,
			worstCount <= MAX_RENDERED,
			`worst ${worstCount} rows, cap ${MAX_RENDERED}`
		);
	}
}

console.log('\n=== the count does not grow with the list ===\n');
{
	const counts = [100, 1_000, 10_000, 100_000, 1_000_000].map((rowCount) => {
		// Halfway down, the worst case for a window.
		const scroll = (rowCount * ROW_HEIGHT - VIEWPORT) / 2;
		return windowFor(scroll, VIEWPORT, rowCount).count;
	});
	check(
		'100 rows and 1,000,000 rows render the same number',
		new Set(counts).size === 1,
		`counts ${counts.join(', ')}`
	);
	check('and that number is a screenful plus overscan',
		counts[0] === ROWS_ON_SCREEN + 2 * OVERSCAN,
		`${counts[0]} = ${ROWS_ON_SCREEN} on screen + ${2 * OVERSCAN} overscan`);
}

console.log('\n=== edges ===\n');
{
	const empty = windowFor(0, VIEWPORT, 0);
	check('an empty list renders nothing', empty.count === 0 && empty.totalHeight === 0);

	const unmeasured = windowFor(0, 0, 1000);
	check('a zero-height viewport renders nothing', unmeasured.count === 0,
		`${unmeasured.count} rows`);
	check('but still reports the full scroll height', unmeasured.totalHeight === 1000 * ROW_HEIGHT,
		`${unmeasured.totalHeight}px`);

	const short = windowFor(0, VIEWPORT, 3);
	check('a list shorter than the viewport renders all of it', short.count === 3 && short.first === 0,
		`first ${short.first}, count ${short.count}`);

	// macOS overscroll bounce reports a negative scrollTop.
	const bounced = windowFor(-120, VIEWPORT, 1000);
	check('negative scrollTop clamps to the top', bounced.first === 0 && bounced.offsetY === 0,
		`first ${bounced.first}`);

	// A resize can leave scrollTop past the end for a frame.
	const over = windowFor(9_999_999, VIEWPORT, 1000);
	check('scrollTop past the end clamps to the bottom',
		over.first + over.count === 1000, `last ${over.first + over.count}`);

	const aligned = windowFor(10 * ROW_HEIGHT, VIEWPORT, 1000);
	check('offsetY always lands on a row boundary', aligned.offsetY % ROW_HEIGHT === 0,
		`offsetY ${aligned.offsetY}`);
	check('offsetY matches first', aligned.offsetY === aligned.first * ROW_HEIGHT);
}

console.log('\n=== scrollToIndex ===\n');
{
	check('a visible row does not scroll',
		scrollToIndex(5, 0, VIEWPORT, 1000) === null, 'row 5 at scrollTop 0');
	check('the last fully visible row does not scroll',
		scrollToIndex(ROWS_ON_SCREEN - 1, 0, VIEWPORT, 1000) === null);

	const down = scrollToIndex(500, 0, VIEWPORT, 1000);
	check('a row below the fold centres', down !== null && Math.abs(down - (500 * ROW_HEIGHT - (VIEWPORT - ROW_HEIGHT) / 2)) < 1,
		`scrollTop ${down}`);

	const nearTop = scrollToIndex(1, 5000, VIEWPORT, 1000);
	check('a row near the top clamps to zero', nearTop === 0, `scrollTop ${nearTop}`);

	const nearEnd = scrollToIndex(999, 0, VIEWPORT, 1000);
	const maxScroll = 1000 * ROW_HEIGHT - VIEWPORT;
	check('a row near the end clamps to the maximum', nearEnd === maxScroll,
		`scrollTop ${nearEnd}, max ${maxScroll}`);

	check('an out-of-range index does nothing',
		scrollToIndex(-1, 0, VIEWPORT, 1000) === null &&
			scrollToIndex(1000, 0, VIEWPORT, 1000) === null);
	check('an unmeasured viewport does nothing', scrollToIndex(5, 0, 0, 1000) === null);
}

console.log('\n=== clicking a row must not make the list jump ===\n');
{
	// The bidirectional cycle: a click selects, the selection effect asks whether
	// to scroll, and the answer has to be "no" for every row that was clickable.
	let jumps = 0;
	const rowCount = 100_000;
	for (let scroll = 0; scroll < rowCount * ROW_HEIGHT - VIEWPORT; scroll += 977) {
		const w = windowFor(scroll, VIEWPORT, rowCount);
		for (let i = 0; i < w.count; i++) {
			const index = w.first + i;
			const top = index * ROW_HEIGHT;
			// Only rows actually inside the viewport are clickable; overscan rows
			// are rendered but sit outside it.
			if (top < scroll || top + ROW_HEIGHT > scroll + VIEWPORT) continue;
			if (scrollToIndex(index, scroll, VIEWPORT, rowCount) !== null) jumps++;
		}
	}
	check('no clickable row asks the list to scroll', jumps === 0, `${jumps} jumps`);
}

console.log('\n=== cost ===\n');
{
	function median(v: number[]): number {
		return [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
	}

	console.log('  rows       | windowFor | full scroll pass | rows rendered');
	console.log('  -----------|-----------|------------------|--------------');

	for (const rowCount of [1_000, 10_000, 100_000, 1_000_000]) {
		const maxScroll = rowCount * ROW_HEIGHT - VIEWPORT;

		const single: number[] = [];
		for (let r = 0; r < 9; r++) {
			const t0 = performance.now();
			for (let i = 0; i < 10_000; i++) windowFor((i * 37) % maxScroll, VIEWPORT, rowCount);
			single.push((performance.now() - t0) / 10_000);
		}

		// One frame per scroll step, top to bottom, as a flick would produce.
		const passes: number[] = [];
		let rendered = 0;
		for (let r = 0; r < 5; r++) {
			const t0 = performance.now();
			rendered = 0;
			for (let scroll = 0; scroll <= maxScroll; scroll += VIEWPORT) {
				rendered += windowFor(scroll, VIEWPORT, rowCount).count;
			}
			passes.push(performance.now() - t0);
		}

		console.log(
			`  ${rowCount.toLocaleString().padStart(9)}  | ` +
				`${(median(single) * 1000).toFixed(3).padStart(6)} µs | ` +
				`${median(passes).toFixed(2).padStart(13)} ms | ` +
				`${MAX_RENDERED} max, ${rendered.toLocaleString()} over the pass`
		);
	}
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
