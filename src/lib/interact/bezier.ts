import type { EdgeGeometry } from '$lib/render/edge-geometry';

/**
 * Distance from a point to a cubic bezier, by flattening.
 *
 * There is no closed form: the exact answer is a root of a quintic. The
 * alternatives were Newton iteration on the distance derivative (converges to a
 * *local* minimum, and an S-shaped edge has several) and recursive subdivision
 * with a flatness test. Flattening wins here because we never need the true
 * distance — we only need to know whether it is under a tolerance — so the
 * accuracy can be dialled to exactly that question and no further.
 *
 * Which is the whole trick in this file: **the caller's tolerance sets the
 * segment count**. A generous tolerance (zoomed out, where a 10px slop is 500
 * graph units) needs four segments; a tight one on a steeply curved edge needs
 * forty. Picking a fixed count instead is what the first version of this did,
 * and it was wrong in both directions at once — wasteful when zoomed out, and
 * off by 5.8 graph units on the steep edges the placeholder layout produces,
 * which is most of the way through a 10-unit tolerance.
 */

/**
 * Chord error is allowed to eat this fraction of the caller's tolerance.
 *
 * A point is therefore only ever misclassified if it sits within 25% of the
 * tolerance boundary — where the user's aim is the dominant error anyway.
 */
const ERROR_BUDGET = 0.25;

/** Guard rails on the adaptive count: enough to be a curve, few enough to be cheap. */
const MIN_SEGMENTS = 4;
const MAX_SEGMENTS = 64;

/** Squared distance from a point to the segment ab. Squared to avoid a sqrt per segment. */
export function pointSegmentDistanceSq(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const abx = bx - ax;
	const aby = by - ay;
	const lengthSq = abx * abx + aby * aby;

	// Project p onto ab, clamped to the segment. A degenerate segment (both
	// endpoints equal) collapses to the point distance, which is why t is
	// guarded rather than the division.
	let t = lengthSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lengthSq : 0;
	if (t < 0) t = 0;
	else if (t > 1) t = 1;

	const dx = px - (ax + abx * t);
	const dy = py - (ay + aby * t);
	return dx * dx + dy * dy;
}

/**
 * How many chords this curve needs to be approximated to within `maxError`.
 *
 * Standard bound: a cubic sampled at n+1 uniform parameter values deviates from
 * the resulting polyline by at most `max|B''| / (8n²)`, and for a cubic
 * `max|B''| <= 6 * max(|P0 - 2P1 + P2|, |P1 - 2P2 + P3|)`. Those two second
 * differences are the only measure of "how bent" the curve is, and they are two
 * subtractions each. Solving for n gives the expression below.
 */
export function segmentsFor(g: EdgeGeometry, maxError: number): number {
	const ax = g.fromX - 2 * g.c1x + g.c2x;
	const ay = g.fromY - 2 * g.c1y + g.c2y;
	const bx = g.c1x - 2 * g.c2x + g.toX;
	const by = g.c1y - 2 * g.c2y + g.toY;

	const bend = Math.sqrt(Math.max(ax * ax + ay * ay, bx * bx + by * by));
	if (bend <= 0 || maxError <= 0) return MIN_SEGMENTS;

	// error <= 6 * bend / (8n^2)  ->  n >= sqrt(3 * bend / (4 * error))
	const n = Math.ceil(Math.sqrt((3 * bend) / (4 * maxError)));
	return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, n));
}

/**
 * Squared distance from a point to the curve, accurate enough to decide whether
 * it is within `tolerance`. Returns `Infinity` when the curve's control hull is
 * further away than that.
 *
 * The early out is the broad phase. A cubic is contained in the convex hull of
 * its four control points, so the axis-aligned box of those points is a
 * conservative bound: if the point is outside that box by more than the
 * tolerance, no amount of flattening will bring the curve closer. At the 10k
 * fixture this rejects nearly all 14,739 edges with four comparisons each,
 * leaving a handful to actually measure.
 */
export function distanceSqToCubic(
	px: number,
	py: number,
	g: EdgeGeometry,
	tolerance: number
): number {
	const minX = Math.min(g.fromX, g.c1x, g.c2x, g.toX) - tolerance;
	const maxX = Math.max(g.fromX, g.c1x, g.c2x, g.toX) + tolerance;
	const minY = Math.min(g.fromY, g.c1y, g.c2y, g.toY) - tolerance;
	const maxY = Math.max(g.fromY, g.c1y, g.c2y, g.toY) + tolerance;
	if (px < minX || px > maxX || py < minY || py > maxY) return Infinity;

	const segments = segmentsFor(g, tolerance * ERROR_BUDGET);

	let best = Infinity;
	let prevX = g.fromX;
	let prevY = g.fromY;

	for (let s = 1; s <= segments; s++) {
		const t = s / segments;
		const u = 1 - t;
		// Bernstein basis, written out. A de Casteljau loop would be tidier and
		// about three times the arithmetic.
		const w0 = u * u * u;
		const w1 = 3 * u * u * t;
		const w2 = 3 * u * t * t;
		const w3 = t * t * t;

		const x = w0 * g.fromX + w1 * g.c1x + w2 * g.c2x + w3 * g.toX;
		const y = w0 * g.fromY + w1 * g.c1y + w2 * g.c2y + w3 * g.toY;

		const d = pointSegmentDistanceSq(px, py, prevX, prevY, x, y);
		if (d < best) best = d;

		prevX = x;
		prevY = y;
	}

	return best;
}
