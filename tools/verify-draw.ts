/**
 * What selection costs the draw loop.
 *
 * Drives the real `drawScene` against a stub 2D context that counts calls. This
 * measures OUR JavaScript only — no rasterisation, which is the browser's and is
 * far larger. The numbers are a floor, and the useful thing is the *delta*
 * between drawing with nothing selected and drawing with everything selected.
 */
import { generateFixture, FIXTURE_SIZES } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { graphBounds } from '$lib/graph/positions';
import { buildEdgeBuckets } from '$lib/render/edge-buckets';
import { drawScene } from '$lib/render/scene';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { Viewport } from '$lib/render/viewport';

class StubPath2D {
	rect(): void {}
}
(globalThis as any).Path2D = StubPath2D;

const counts = { bezier: 0, stroke: 0, fill: 0, rect: 0, fillRect: 0, strokeRect: 0 };

const ctx = new Proxy(
	{},
	{
		get(_t, prop: string) {
			if (prop === 'bezierCurveTo') return () => counts.bezier++;
			if (prop === 'stroke') return () => counts.stroke++;
			if (prop === 'fill') return () => counts.fill++;
			if (prop === 'rect') return () => counts.rect++;
			if (prop === 'fillRect') return () => counts.fillRect++;
			if (prop === 'strokeRect') return () => counts.strokeRect++;
			return () => {};
		},
		set: () => true
	}
) as unknown as CanvasRenderingContext2D;

const WIDTH = 1440;
const HEIGHT = 820;

function median(values: number[]): number {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

console.log('\n  fixture |     selection | draw ms (median / p90) |  strokes | overhead');
console.log('  --------|---------------|------------------------|----------|---------');

for (const size of FIXTURE_SIZES) {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	const positions = layoutLayered(fixture.graph, index).positions;
	const buckets = buildEdgeBuckets(fixture.graph);

	const viewport = new Viewport();
	viewport.fit(graphBounds(fixture.graph, positions), WIDTH, HEIGHT);

	const selection = new SelectionStore(fixture.graph.nodes.length, fixture.graph.edges.length);

	const run = (label: string, baseline: number | null): number => {
		const input = {
			graph: fixture.graph,
			index,
			positions,
			buckets,
			selection,
			marquee: null,
			viewport,
			cssWidth: WIDTH,
			cssHeight: HEIGHT,
			devicePixelRatio: 2
		};
		// Warm up, then measure.
		for (let i = 0; i < 20; i++) drawScene(ctx, input);
		for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0;

		const times: number[] = [];
		for (let i = 0; i < 60; i++) times.push(drawScene(ctx, input).drawMs);
		const strokes = counts.stroke / 60;

		const med = median(times);
		const p90 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)];
		const overhead = baseline === null ? '—' : `+${(med - baseline).toFixed(2)} ms`;
		console.log(
			`  ${String(size).padStart(6)}  | ${label.padStart(13)} | ` +
				`${med.toFixed(2).padStart(8)} / ${p90.toFixed(2).padStart(6)} ms    | ` +
				`${strokes.toFixed(0).padStart(7)}  | ${overhead}`
		);
		return med;
	};

	const baseline = run('none', null);

	// One node — the common case after a click.
	selection.selectNode(Math.floor(fixture.graph.nodes.length / 2), false);
	run('1 node', baseline);

	// Everything: the pathological case, and what a full-graph marquee produces.
	const allNodes: number[] = [];
	for (let i = 0; i < fixture.graph.nodes.length; i++) allNodes.push(i);
	const allEdges: number[] = [];
	for (let e = 0; e < fixture.graph.edges.length; e++) allEdges.push(e);
	selection.replaceNodes(allNodes, null);
	selection.setEdges(allEdges);
	run('everything', baseline);

	// A live marquee over the whole viewport, with everything selected.
	const input = {
		graph: fixture.graph,
		index,
		positions,
		buckets,
		selection,
		marquee: { x: 0, y: 0, width: 5000, height: 5000 },
		viewport,
		cssWidth: WIDTH,
		cssHeight: HEIGHT,
		devicePixelRatio: 2
	};
	for (let i = 0; i < 20; i++) drawScene(ctx, input);
	const times: number[] = [];
	for (let i = 0; i < 60; i++) times.push(drawScene(ctx, input).drawMs);
	console.log(
		`  ${String(size).padStart(6)}  | ${'+ marquee'.padStart(13)} | ` +
			`${median(times).toFixed(2).padStart(8)} / ` +
			`${[...times].sort((a, b) => a - b)[54].toFixed(2).padStart(6)} ms    | ` +
			`${'—'.padStart(7)}  | +${(median(times) - baseline).toFixed(2)} ms`
	);
	console.log('  --------|---------------|------------------------|----------|---------');
}
