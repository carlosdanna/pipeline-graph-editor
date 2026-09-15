/**
 * What culling and semantic zoom buy, at 2,000 and 10,000 nodes.
 *
 * Drives the real `drawScene` against a stub 2D context that counts calls, and
 * mirrors exactly what `HybridRenderer` does each frame — same cull, same
 * detail tier, same DOM-or-canvas decision — so the rows correspond to what the
 * HUD shows with the two checkboxes on and off.
 *
 * This measures OUR JavaScript only. Rasterisation is the browser's and is far
 * larger, so treat these as a floor and a ratio, not as frame times. The ratio
 * is the point: it is the same work the GPU is also being asked to do.
 */
import { generateFixture, FIXTURE_SIZES } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { graphBounds } from '$lib/graph/positions';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { buildEdgeBuckets } from '$lib/render/edge-buckets';
import { cullNodes, viewRectFor, type ViewRect } from '$lib/render/cull';
import { detailFor, DOM_NODE_LIMIT } from '$lib/render/limits';
import { drawScene } from '$lib/render/scene';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { DynamicsStore } from '$lib/graph/dynamics.svelte';
import { Viewport } from '$lib/render/viewport';

class StubPath2D {
	rect(): void {}
	roundRect(): void {}
}
(globalThis as any).Path2D = StubPath2D;

const calls = { bezier: 0, line: 0, stroke: 0, fill: 0, text: 0 };

const ctx = new Proxy(
	{},
	{
		get(_t, prop: string) {
			switch (prop) {
				case 'bezierCurveTo':
					return () => calls.bezier++;
				case 'lineTo':
					return () => calls.line++;
				case 'stroke':
					return () => calls.stroke++;
				case 'fill':
					return () => calls.fill++;
				case 'fillText':
					return () => calls.text++;
				case 'measureText':
					return () => ({ width: 40 });
				default:
					return () => {};
			}
		},
		set: () => true
	}
) as unknown as CanvasRenderingContext2D;

const UNBOUNDED: ViewRect = {
	left: -Infinity,
	top: -Infinity,
	right: Infinity,
	bottom: Infinity
};

const WIDTH = 1440;
const HEIGHT = 820;
const SAMPLES = 40;

function median(values: number[]): number {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

for (const size of FIXTURE_SIZES) {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	const positions = layoutLayered(fixture.graph, index).positions;
	const anchors = buildEdgeAnchors(fixture.graph, index);
	const buckets = buildEdgeBuckets(fixture.graph);
	const selection = new SelectionStore(fixture.graph.nodes.length, fixture.graph.edges.length);
	const dynamics = DynamicsStore.from(fixture.initialDynamics);
	const buffer = new Int32Array(fixture.graph.nodes.length);

	const viewport = new Viewport();
	const bounds = graphBounds(fixture.graph, positions);
	viewport.fit(bounds, WIDTH, HEIGHT);
	const fitZoom = viewport.k;

	console.log(
		`\n${size.toLocaleString()} nodes, ${fixture.graph.edges.length.toLocaleString()} edges` +
			`   (fit = ${fitZoom.toFixed(3)}x)`
	);
	console.log(
		'   zoom | culling | semantic | draw ms |  nodes drawn  |  edges drawn  | detail | via'
	);
	console.log(
		'  ------|---------|----------|---------|---------------|---------------|--------|-------'
	);

	/** Centres the viewport on the graph at a given zoom, like a user would be. */
	const place = (k: number): void => {
		viewport.k = k;
		viewport.x = WIDTH / 2 - (bounds.x + bounds.width / 2) * k;
		viewport.y = HEIGHT / 2 - (bounds.y + bounds.height / 2) * k;
	};

	const measure = (zoomLabel: string, culling: boolean, semantic: boolean): void => {
		// Exactly what HybridRenderer#draw does.
		const detail = semantic ? detailFor(viewport.k) : 'full';
		const nodesOnCanvas = fixture.graph.nodes.length > DOM_NODE_LIMIT || detail !== 'full';
		const view = culling ? viewRectFor(viewport, WIDTH, HEIGHT) : UNBOUNDED;
		const visibleCount = cullNodes(fixture.graph, positions, view, buffer);

		const input = {
			graph: fixture.graph,
			dynamics,
			positions,
			buckets,
			anchors,
			selection,
			marquee: null,
			visible: buffer,
			visibleCount,
			view,
			detail,
			nodesOnCanvas,
			viewport,
			cssWidth: WIDTH,
			cssHeight: HEIGHT,
			devicePixelRatio: 2
		};

		for (let i = 0; i < 10; i++) drawScene(ctx, input);
		const times: number[] = [];
		let stats = drawScene(ctx, input);
		for (let i = 0; i < SAMPLES; i++) {
			stats = drawScene(ctx, input);
			times.push(stats.drawMs);
		}

		const nodes = `${stats.visibleNodes.toLocaleString()}/${stats.totalNodes.toLocaleString()}`;
		const edges = `${stats.visibleEdges.toLocaleString()}/${stats.edgeCount.toLocaleString()}`;
		console.log(
			`  ${zoomLabel.padStart(5)} | ${(culling ? 'on' : 'OFF').padStart(7)} | ` +
				`${(semantic ? 'on' : 'OFF').padStart(8)} | ` +
				`${median(times).toFixed(2).padStart(6)}  | ${nodes.padStart(13)} | ` +
				`${edges.padStart(13)} | ${stats.detail.padStart(6)} | ` +
				`${stats.nodesOnCanvas ? 'canvas' : 'dom'}`
		);
	};

	for (const [label, k] of [
		['fit', fitZoom],
		['0.25', 0.25],
		['0.5', 0.5],
		['1.0', 1.0]
	] as const) {
		place(k as number);
		measure(label, false, false);
		measure(label, true, false);
		measure(label, true, true);
		console.log(
			'  ------|---------|----------|---------|---------------|---------------|--------|-------'
		);
	}

	// Phase 4 measured "everything selected" at +2.15 ms at 10k, because the
	// selected-edge pass re-strokes every edge. Culling should bound it.
	const allNodes: number[] = [];
	for (let i = 0; i < fixture.graph.nodes.length; i++) allNodes.push(i);
	const allEdges: number[] = [];
	for (let e = 0; e < fixture.graph.edges.length; e++) allEdges.push(e);
	selection.replaceNodes(allNodes, null);
	selection.setEdges(allEdges);

	place(1.0);
	console.log('  everything selected:');
	measure('1.0', false, false);
	measure('1.0', true, true);
	selection.clear();
}

console.log('');
