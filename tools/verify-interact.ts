/**
 * Phase 4 verification harness. Bundled with esbuild (so `$lib` resolves) and
 * run in Node. Everything under test here is plain TypeScript with no DOM and
 * no runes, which is exactly why the interaction logic was split out of the
 * renderer.
 */
import { generateFixture, FIXTURE_SIZES } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { PositionStore } from '$lib/graph/positions';
import { NodeQuadtree } from '$lib/interact/quadtree';
import { distanceSqToCubic, pointSegmentDistanceSq, segmentsFor } from '$lib/interact/bezier';
import { hitTest, hitTestEdge, edgesWithin, EDGE_PICK_TOLERANCE_PX } from '$lib/interact/hit-test';
import { createEdgeGeometry, writeEdgeGeometry } from '$lib/render/edge-geometry';
import type { PipelineGraph, Rect } from '$lib/graph/types';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

// Deterministic RNG so a failure is reproducible.
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function bruteFindNode(graph: PipelineGraph, pos: PositionStore, px: number, py: number): number {
	let found = -1;
	for (let i = 0; i < graph.nodes.length; i++) {
		const n = graph.nodes[i];
		const x = pos.x[i];
		const y = pos.y[i];
		if (px >= x && px <= x + n.width && py >= y && py <= y + n.height) found = i;
	}
	return found;
}

function bruteQueryRect(graph: PipelineGraph, pos: PositionStore, r: Rect): number[] {
	const out: number[] = [];
	const right = r.x + r.width;
	const bottom = r.y + r.height;
	for (let i = 0; i < graph.nodes.length; i++) {
		const n = graph.nodes[i];
		const x = pos.x[i];
		const y = pos.y[i];
		if (x <= right && x + n.width >= r.x && y <= bottom && y + n.height >= r.y) out.push(i);
	}
	return out;
}

function cubicAt(g: ReturnType<typeof createEdgeGeometry>, t: number): [number, number] {
	const u = 1 - t;
	const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
	return [
		w0 * g.fromX + w1 * g.c1x + w2 * g.c2x + w3 * g.toX,
		w0 * g.fromY + w1 * g.c1y + w2 * g.c2y + w3 * g.toY
	];
}

/** Reference distance, flattened far finer than the implementation. */
function referenceDistanceSq(px: number, py: number, g: ReturnType<typeof createEdgeGeometry>): number {
	const N = 4096;
	let best = Infinity;
	let [prevX, prevY] = cubicAt(g, 0);
	for (let s = 1; s <= N; s++) {
		const [x, y] = cubicAt(g, s / N);
		const d = pointSegmentDistanceSq(px, py, prevX, prevY, x, y);
		if (d < best) best = d;
		prevX = x; prevY = y;
	}
	return best;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

console.log('\n=== quadtree correctness vs brute force ===\n');

const built = FIXTURE_SIZES.map((size) => {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	const layout = layoutLayered(fixture.graph, index);
	return { size, graph: fixture.graph, index, positions: layout.positions };
});

for (const f of built) {
	const tree = new NodeQuadtree(f.graph, f.positions);
	const random = rng(0x1234 + f.size);

	// Bounds to sample from: the graph extent, padded so misses are sampled too.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < f.graph.nodes.length; i++) {
		minX = Math.min(minX, f.positions.x[i]);
		minY = Math.min(minY, f.positions.y[i]);
		maxX = Math.max(maxX, f.positions.x[i] + f.graph.nodes[i].width);
		maxY = Math.max(maxY, f.positions.y[i] + f.graph.nodes[i].height);
	}

	let mismatches = 0;
	let hits = 0;
	const SAMPLES = 4000;
	for (let s = 0; s < SAMPLES; s++) {
		let px: number, py: number;
		if (s % 2 === 0) {
			// Half the samples land inside a real node, so hits are well covered.
			const i = Math.floor(random() * f.graph.nodes.length);
			px = f.positions.x[i] + random() * f.graph.nodes[i].width;
			py = f.positions.y[i] + random() * f.graph.nodes[i].height;
		} else {
			px = minX - 200 + random() * (maxX - minX + 400);
			py = minY - 200 + random() * (maxY - minY + 400);
		}
		const actual = tree.findNode(px, py);
		const expected = bruteFindNode(f.graph, f.positions, px, py);
		if (actual !== expected) mismatches++;
		if (expected >= 0) hits++;
	}
	check(
		`findNode n=${String(f.size).padStart(5)}`,
		mismatches === 0,
		`${SAMPLES} samples, ${hits} hits, ${mismatches} mismatches`
	);

	let rectMismatches = 0;
	for (let s = 0; s < 200; s++) {
		const w = random() * (maxX - minX) * 0.3;
		const h = random() * (maxY - minY) * 0.3;
		const r: Rect = {
			x: minX + random() * (maxX - minX),
			y: minY + random() * (maxY - minY),
			width: w,
			height: h
		};
		const actual = tree.queryRect(r, []).sort((a, b) => a - b);
		const expected = bruteQueryRect(f.graph, f.positions, r);
		if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
			rectMismatches++;
		}
	}
	check(`queryRect n=${String(f.size).padStart(5)}`, rectMismatches === 0, `200 rects`);
}

console.log('\n=== coincident nodes (the leaf.next path) ===\n');
{
	const f = built[0];
	const stacked = new PositionStore(f.graph.nodes.length);
	for (let i = 0; i < stacked.count; i++) stacked.set(i, 500, 500);
	const tree = new NodeQuadtree(f.graph, stacked);
	const found = tree.findNode(510, 510);
	check('findNode returns topmost of a perfect stack', found === f.graph.nodes.length - 1, `got ${found}`);
	const all = tree.queryRect({ x: 400, y: 400, width: 400, height: 400 }, []);
	check('queryRect returns every stacked node', all.length === f.graph.nodes.length, `got ${all.length}`);
}

console.log('\n=== bezier distance vs 4096-segment reference ===\n');
{
	const f = built[1];
	const g = createEdgeGeometry();

	// The tolerances that actually occur: 10 CSS px divided by the zoom, from
	// fully zoomed in to fully zoomed out.
	for (const zoom of [3, 1, 0.25, 0.05, 0.02]) {
		const tolerance = 10 / zoom;
		const random = rng(0xbeef);
		let worstAbs = 0;
		let samples = 0;
		let segSum = 0;
		let segMax = 0;

		for (let e = 0; e < Math.min(400, f.graph.edges.length); e++) {
			if (!writeEdgeGeometry(g, f.graph, f.index, f.positions, e)) continue;
			segSum += segmentsFor(g, tolerance * 0.25);
			segMax = Math.max(segMax, segmentsFor(g, tolerance * 0.25));
			for (let s = 0; s < 8; s++) {
				const [cx, cy] = cubicAt(g, random());
				const px = cx + (random() - 0.5) * tolerance * 2;
				const py = cy + (random() - 0.5) * tolerance * 2;
				const got = Math.sqrt(distanceSqToCubic(px, py, g, tolerance));
				if (!Number.isFinite(got)) continue;
				const want = Math.sqrt(referenceDistanceSq(px, py, g));
				worstAbs = Math.max(worstAbs, Math.abs(got - want));
				samples++;
			}
		}
		const budget = tolerance * 0.25;
		check(
			`zoom ${String(zoom).padStart(5)}  tol ${tolerance.toFixed(0).padStart(4)}u  error within budget`,
			worstAbs <= budget,
			`worst ${worstAbs.toFixed(3)}u of ${budget.toFixed(2)}u budget, ` +
				`${(segSum / 400).toFixed(1)} segments avg / ${segMax} max, ${samples} samples`
		);
	}

	// A point exactly on the curve must read as on the curve, at the tightest
	// tolerance we ever use.
	writeEdgeGeometry(g, f.graph, f.index, f.positions, 0);
	let worstOn = 0;
	for (let s = 0; s <= 20; s++) {
		const [x, y] = cubicAt(g, s / 20);
		worstOn = Math.max(worstOn, Math.sqrt(distanceSqToCubic(x, y, g, 10 / 3)));
	}
	check('points on the curve read within budget', worstOn <= (10 / 3) * 0.25, `worst ${worstOn.toExponential(2)}`);

	// The control-hull early out must never reject a point that is genuinely close.
	let falseRejects = 0;
	for (let e = 0; e < Math.min(400, f.graph.edges.length); e++) {
		if (!writeEdgeGeometry(g, f.graph, f.index, f.positions, e)) continue;
		const [x, y] = cubicAt(g, 0.5);
		if (!Number.isFinite(distanceSqToCubic(x, y, g, 10))) falseRejects++;
	}
	check('control-hull early out never rejects a midpoint', falseRejects === 0);

	// The steepest edges in the whole set — the ones that broke the fixed count.
	let steepest = 0;
	let steepestSegs = 0;
	for (let e = 0; e < f.graph.edges.length; e++) {
		if (!writeEdgeGeometry(g, f.graph, f.index, f.positions, e)) continue;
		const n = segmentsFor(g, 2.5);
		if (n > steepestSegs) {
			steepestSegs = n;
			steepest = e;
		}
	}
	writeEdgeGeometry(g, f.graph, f.index, f.positions, steepest);
	const [mx, my] = cubicAt(g, 0.5);
	const gotSteep = Math.sqrt(distanceSqToCubic(mx, my, g, 10));
	check(
		'the steepest edge in the fixture is accurate at its midpoint',
		gotSteep <= 2.5,
		`edge ${steepest}, ${steepestSegs} segments, midpoint reads ${gotSteep.toExponential(2)}`
	);
}

console.log('\n=== edge picking ===\n');
for (const f of built) {
	const g = createEdgeGeometry();
	const random = rng(0xfeed + f.size);
	const tree = new NodeQuadtree(f.graph, f.positions);
	let recovered = 0;
	let attempted = 0;

	for (let s = 0; s < 300; s++) {
		const e = Math.floor(random() * f.graph.edges.length);
		if (!writeEdgeGeometry(g, f.graph, f.index, f.positions, e)) continue;
		const [x, y] = cubicAt(g, 0.5);
		// Skip midpoints that land under a node — nodes win, by design.
		if (tree.findNode(x, y) >= 0) continue;
		attempted++;
		const picked = hitTestEdge(f.graph, f.index, f.positions, x, y, 1);
		// Another edge may genuinely be closer at that point; accept it only if
		// it really is at least as close.
		if (picked === e) recovered++;
		else if (picked >= 0) {
			const other = createEdgeGeometry();
			writeEdgeGeometry(other, f.graph, f.index, f.positions, picked);
			if (distanceSqToCubic(x, y, other, 1e6) <= 1e-6) recovered++;
		}
	}
	check(
		`midpoint picks its own edge n=${String(f.size).padStart(5)}`,
		recovered === attempted,
		`${recovered}/${attempted}`
	);

	// A point far from everything must miss.
	const miss = hitTestEdge(f.graph, f.index, f.positions, -1e6, -1e6, 1);
	check(`far point misses n=${String(f.size).padStart(5)}`, miss === -1, `got ${miss}`);
}

console.log('\n=== nodes win over edges ===\n');
{
	const f = built[0];
	const tree = new NodeQuadtree(f.graph, f.positions);
	const random = rng(7);
	let violations = 0;
	for (let s = 0; s < 500; s++) {
		const i = Math.floor(random() * f.graph.nodes.length);
		const px = f.positions.x[i] + f.graph.nodes[i].width * random();
		const py = f.positions.y[i] + f.graph.nodes[i].height * random();
		const hit = hitTest(tree, f.graph, f.index, f.positions, px, py, 1);
		if (hit.node < 0 || hit.edge !== -1) violations++;
	}
	check('a point inside a node never returns an edge', violations === 0, `${violations} violations`);
}

console.log('\n=== marquee: edges need both ends inside ===\n');
{
	const f = built[1];
	const tree = new NodeQuadtree(f.graph, f.positions);
	const flags = new Uint8Array(f.graph.nodes.length);
	const nodes = tree.queryRect({ x: 0, y: 0, width: 3000, height: 3000 }, []);
	for (const n of nodes) flags[n] = 1;

	const edges = edgesWithin(f.graph, f.index, flags, []);
	let bad = 0;
	for (const e of edges) {
		const edge = f.graph.edges[e];
		const from = f.index.nodeIndexById.get(edge.source)!;
		const to = f.index.nodeIndexById.get(edge.target)!;
		if (flags[from] !== 1 || flags[to] !== 1) bad++;
	}
	check(
		'every implied edge has both endpoints selected',
		bad === 0,
		`${nodes.length} nodes -> ${edges.length} edges`
	);

	// And no qualifying edge is missed.
	let missed = 0;
	const chosen = new Set(edges);
	for (let e = 0; e < f.graph.edges.length; e++) {
		const edge = f.graph.edges[e];
		const from = f.index.nodeIndexById.get(edge.source)!;
		const to = f.index.nodeIndexById.get(edge.target)!;
		if (flags[from] === 1 && flags[to] === 1 && !chosen.has(e)) missed++;
	}
	check('no qualifying edge is missed', missed === 0, `${missed} missed`);
}

console.log('\n=== cost ===\n');
console.log('  fixture |  tree build | findNode (hit) | edge pick (miss) | marquee 20% | drag write');
console.log('  --------|-------------|----------------|------------------|-------------|-----------');

for (const f of built) {
	const random = rng(99 + f.size);

	// Tree build, best of 5.
	let buildMs = Infinity;
	let tree = new NodeQuadtree(f.graph, f.positions);
	for (let r = 0; r < 5; r++) {
		tree = new NodeQuadtree(f.graph, f.positions);
		buildMs = Math.min(buildMs, tree.buildMs);
	}

	// findNode on points that are inside a node.
	const pts: [number, number][] = [];
	for (let s = 0; s < 2000; s++) {
		const i = Math.floor(random() * f.graph.nodes.length);
		pts.push([
			f.positions.x[i] + f.graph.nodes[i].width * 0.5,
			f.positions.y[i] + f.graph.nodes[i].height * 0.5
		]);
	}
	const findTimes: number[] = [];
	for (let r = 0; r < 5; r++) {
		const t0 = performance.now();
		for (const [x, y] of pts) tree.findNode(x, y);
		findTimes.push((performance.now() - t0) / pts.length);
	}

	// Edge pick on empty space — the worst case, since nothing short-circuits.
	const emptyPts: [number, number][] = [];
	for (let s = 0; s < 200; s++) {
		const i = Math.floor(random() * f.graph.nodes.length);
		emptyPts.push([f.positions.x[i] - 400, f.positions.y[i] - 400]);
	}
	const edgeTimes: number[] = [];
	for (let r = 0; r < 5; r++) {
		const t0 = performance.now();
		for (const [x, y] of emptyPts) hitTestEdge(f.graph, f.index, f.positions, x, y, 1);
		edgeTimes.push((performance.now() - t0) / emptyPts.length);
	}

	// One marquee frame covering ~20% of the graph: query + implied edges.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < f.graph.nodes.length; i++) {
		minX = Math.min(minX, f.positions.x[i]);
		minY = Math.min(minY, f.positions.y[i]);
		maxX = Math.max(maxX, f.positions.x[i]);
		maxY = Math.max(maxY, f.positions.y[i]);
	}
	const box: Rect = {
		x: minX,
		y: minY,
		width: (maxX - minX) * 0.45,
		height: (maxY - minY) * 0.45
	};
	const flags = new Uint8Array(f.graph.nodes.length);
	const nodeOut: number[] = [];
	const edgeOut: number[] = [];
	let caught = 0;
	const marqueeTimes: number[] = [];
	for (let r = 0; r < 10; r++) {
		const t0 = performance.now();
		nodeOut.length = 0;
		tree.queryRect(box, nodeOut);
		flags.fill(0);
		for (const n of nodeOut) flags[n] = 1;
		edgeOut.length = 0;
		edgesWithin(f.graph, f.index, flags, edgeOut);
		marqueeTimes.push(performance.now() - t0);
		caught = nodeOut.length;
	}

	// One drag frame: write every position (the worst case, select-all then drag).
	const all: number[] = [];
	for (let i = 0; i < f.graph.nodes.length; i++) all.push(i);
	const fromX = Float64Array.from(all, (i) => f.positions.x[i]);
	const fromY = Float64Array.from(all, (i) => f.positions.y[i]);
	const dragTimes: number[] = [];
	for (let r = 0; r < 20; r++) {
		const t0 = performance.now();
		for (let i = 0; i < all.length; i++) f.positions.set(all[i], fromX[i] + r, fromY[i] + r);
		dragTimes.push(performance.now() - t0);
	}

	console.log(
		`  ${String(f.size).padStart(6)}  | ${buildMs.toFixed(2).padStart(8)} ms | ` +
			`${(median(findTimes) * 1000).toFixed(1).padStart(10)} µs | ` +
			`${(median(edgeTimes)).toFixed(2).padStart(13)} ms | ` +
			`${median(marqueeTimes).toFixed(2).padStart(8)} ms | ` +
			`${median(dragTimes).toFixed(3).padStart(7)} ms   (marquee caught ${caught})`
	);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
