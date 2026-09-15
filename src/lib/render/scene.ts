import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
import { portOffsetY } from '$lib/graph/generate';
import type { PositionStore } from '$lib/graph/positions';
import { DATA_TYPES, type PipelineGraph, type Rect } from '$lib/graph/types';
import type { SelectionStore } from '$lib/interact/selection.svelte';
import { edgeVisible, type ViewRect } from './cull';
import type { EdgeAnchors } from './edge-anchors';
import type { EdgeBuckets } from './edge-buckets';
import { createEdgeGeometry, writeEdgeGeometry } from './edge-geometry';
import type { DetailLevel } from './limits';
import { drawNodes } from './nodes';
import { DATA_TYPE_COLOR, PALETTE, SELECTION } from './theme';

/**
 * Everything drawn on the canvas: the background grid, edges, ports, selection,
 * the marquee, and — from phase 5 — nodes, whenever they are not DOM elements.
 *
 * Two rules govern this file.
 *
 * **Nothing off screen is drawn.** Every loop here is either over the culled
 * node list the renderer hands in, or over all edges with a cull test that is
 * an order of magnitude cheaper than drawing one. The `visibleNodes` count the
 * HUD has been reporting since phase 3 finally means something.
 *
 * **Detail is a function of zoom.** Below half scale there are no labels and no
 * ports; below quarter scale nodes are dots and edges are straight lines. This
 * is a legibility decision that happens to be a performance decision: a 5.5px
 * label is noise, and not drawing noise is free.
 *
 * Ports are on the canvas rather than on the node elements because an edge
 * endpoint and the dot it lands on are the same geometry, and drawing both from
 * the same numbers is the only way to guarantee they never disagree.
 *
 * Selection is on the canvas rather than a CSS class so a marquee over 2,000
 * nodes costs no DOM work — and so that it keeps working unchanged when nodes
 * stop being elements.
 */

export interface SceneInput {
	readonly graph: PipelineGraph;
	/**
	 * Read straight from the typed arrays — the canvas never subscribes to
	 * anything. It is redrawn by the frame loop when the batcher says a visible
	 * node changed, not by Svelte noticing a value.
	 */
	readonly dynamics: DynamicsStore;
	readonly positions: PositionStore;
	readonly buckets: EdgeBuckets;
	readonly anchors: EdgeAnchors;
	readonly selection: SelectionStore;
	/** Live marquee box in graph units, or null. */
	readonly marquee: Rect | null;
	/** On-screen node indices, and how much of the buffer is in use. */
	readonly visible: Int32Array;
	readonly visibleCount: number;
	/** The cull region. Infinite when culling is switched off. */
	readonly view: ViewRect;
	readonly detail: DetailLevel;
	/** True when this canvas owns the node bodies, not the DOM layer. */
	readonly nodesOnCanvas: boolean;
	readonly viewport: { x: number; y: number; k: number };
	readonly cssWidth: number;
	readonly cssHeight: number;
	readonly devicePixelRatio: number;
}

export interface SceneStats {
	readonly drawMs: number;
	readonly visibleNodes: number;
	readonly totalNodes: number;
	readonly visibleEdges: number;
	readonly edgeCount: number;
	readonly detail: DetailLevel;
	readonly nodesOnCanvas: boolean;
}

/** Base grid spacing in graph units, before zoom-dependent subdivision. */
const GRID_BASE_STEP = 100;
const GRID_MIN_SCREEN_STEP = 24;
const GRID_MAX_SCREEN_STEP = 96;

/**
 * Grid spacing in graph units for a given zoom, subdividing by 4 so that the
 * on-screen spacing always lands between 24 and 96 CSS pixels.
 *
 * Exported because it is the one bit of the renderer that is pure arithmetic
 * and can be checked without a canvas — and because an unbounded loop here
 * would hang the frame rather than merely look wrong.
 */
export function gridStep(k: number): number {
	let step = GRID_BASE_STEP;
	while (step * k < GRID_MIN_SCREEN_STEP) step *= 4;
	while (step * k > GRID_MAX_SCREEN_STEP && step > 1) step /= 4;
	return step;
}

const EDGE_WIDTH_SCREEN_PX = 1.4;
const SELECTED_EDGE_WIDTH_SCREEN_PX = 2.6;
const PORT_SIZE_SCREEN_PX = 5;
/** How far outside a node's bounds its selection ring sits, in screen pixels. */
const SELECTION_RING_GAP_PX = 3;
const SELECTION_RING_WIDTH_PX = 1.6;

// Reused across every edge of every frame. See edge-geometry.ts.
const geometry = createEdgeGeometry();

export function drawScene(ctx: CanvasRenderingContext2D, input: SceneInput): SceneStats {
	const startedAt = performance.now();
	const { cssWidth, cssHeight, devicePixelRatio: dpr, viewport } = input;

	// Screen space: one unit = one CSS pixel, regardless of display density.
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	// Fill rather than clear: the context is created with `alpha: false`, so the
	// canvas composites faster but clearRect would leave black rather than the
	// page background.
	ctx.fillStyle = PALETTE.background;
	ctx.fillRect(0, 0, cssWidth, cssHeight);
	drawGrid(ctx, input);

	// Graph space: from here on, coordinates are graph units and the GPU does
	// the mapping. This is the "one transform, applied" rule — no per-object
	// coordinate arithmetic anywhere below.
	ctx.setTransform(
		dpr * viewport.k,
		0,
		0,
		dpr * viewport.k,
		dpr * viewport.x,
		dpr * viewport.y
	);

	const visibleEdges = drawEdges(ctx, input);
	drawSelectedEdges(ctx, input);

	if (input.nodesOnCanvas) {
		drawNodes(ctx, {
			graph: input.graph,
			dynamics: input.dynamics,
			positions: input.positions,
			visible: input.visible,
			visibleCount: input.visibleCount,
			detail: input.detail,
			zoom: viewport.k
		});
	}

	// Ports carry no information once they are a pixel across.
	if (input.detail === 'full') drawPorts(ctx, input);

	drawNodeSelection(ctx, input);
	drawMarquee(ctx, input);

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	return {
		drawMs: performance.now() - startedAt,
		visibleNodes: input.visibleCount,
		totalNodes: input.graph.nodes.length,
		visibleEdges,
		edgeCount: input.graph.edges.length,
		detail: input.detail,
		nodesOnCanvas: input.nodesOnCanvas
	};
}

/**
 * Grid lines, drawn in screen space so they stay exactly one device pixel wide
 * at any zoom. The spacing subdivides by 4 as you zoom so the on-screen density
 * stays roughly constant — which also bounds the loop at ~(width / 24) lines
 * however far out you zoom.
 */
function drawGrid(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { viewport: vp, cssWidth, cssHeight } = input;

	const step = gridStep(vp.k);

	ctx.strokeStyle = PALETTE.grid;
	ctx.lineWidth = 1;
	ctx.beginPath();

	const firstX = Math.floor((0 - vp.x) / vp.k / step) * step;
	for (let gx = firstX; ; gx += step) {
		const sx = Math.round(gx * vp.k + vp.x) + 0.5;
		if (sx > cssWidth) break;
		ctx.moveTo(sx, 0);
		ctx.lineTo(sx, cssHeight);
	}

	const firstY = Math.floor((0 - vp.y) / vp.k / step) * step;
	for (let gy = firstY; ; gy += step) {
		const sy = Math.round(gy * vp.k + vp.y) + 0.5;
		if (sy > cssHeight) break;
		ctx.moveTo(0, sy);
		ctx.lineTo(cssWidth, sy);
	}

	ctx.stroke();
}

/**
 * Every visible edge, one accumulated path per data type.
 *
 * The cull test runs inside the bucket loop rather than producing a separate
 * visible-edge list first. Keeping it here preserves the colour batching
 * exactly as phase 3 built it — still one stroke per data type — and means the
 * rejected edges cost four comparisons instead of a `bezierCurveTo`.
 *
 * At the coarsest tier the curve is replaced by a straight line between node
 * *centres* — not between the ports. Nodes are dots at their centre by then, so
 * an edge drawn to a port would stop half a node width short and hang in space,
 * about twenty screen pixels of line ending in nothing. Running centre to
 * centre also skips `writeEdgeGeometry` entirely: four array reads and a
 * `lineTo`, which is the cheapest this loop ever gets, at exactly the zoom
 * where it has the most edges to draw.
 */
function drawEdges(ctx: CanvasRenderingContext2D, input: SceneInput): number {
	const { anchors, positions, buckets, viewport, view, detail } = input;

	// Line width is in graph units now, so undo the zoom to keep edges a
	// constant thickness on screen.
	ctx.lineWidth = EDGE_WIDTH_SCREEN_PX / viewport.k;
	ctx.globalAlpha = 0.55;

	const straight = detail === 'dot';
	let visible = 0;

	for (const type of DATA_TYPES) {
		const bucket = buckets[type];
		if (bucket.length === 0) continue;

		ctx.strokeStyle = DATA_TYPE_COLOR[type];
		ctx.beginPath();
		for (let i = 0; i < bucket.length; i++) {
			const e = bucket[i];
			if (!edgeVisible(anchors, positions, e, view, straight)) continue;

			if (straight) {
				const from = anchors.source[e];
				const to = anchors.target[e];
				visible++;
				ctx.moveTo(
					positions.x[from] + anchors.sourceCentreX[e],
					positions.y[from] + anchors.sourceCentreY[e]
				);
				ctx.lineTo(
					positions.x[to] + anchors.targetCentreX[e],
					positions.y[to] + anchors.targetCentreY[e]
				);
				continue;
			}

			if (!writeEdgeGeometry(geometry, anchors, positions, e)) continue;
			visible++;
			ctx.moveTo(geometry.fromX, geometry.fromY);
			ctx.bezierCurveTo(
				geometry.c1x,
				geometry.c1y,
				geometry.c2x,
				geometry.c2y,
				geometry.toX,
				geometry.toY
			);
		}
		ctx.stroke();
	}

	ctx.globalAlpha = 1;
	return visible;
}

/**
 * Selected edges, redrawn over the bucketed pass at full opacity.
 *
 * Drawing them a second time rather than skipping them in the first pass keeps
 * the colour buckets untouched — they are built once per graph and would
 * otherwise have to be rebuilt on every selection change.
 *
 * The scan over `edgeFlags` is skipped entirely when nothing is selected, which
 * is the common case and the one that must stay free. Phase 4 measured this
 * pass at +2.2 ms with everything selected at 10k; culling is what brings that
 * back down, since it now only re-strokes the selected edges *on screen*.
 */
function drawSelectedEdges(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { anchors, positions, selection, viewport, view, detail } = input;
	if (selection.edgeCount === 0) return;

	const flags = selection.edgeFlags;
	const straight = detail === 'dot';

	ctx.strokeStyle = SELECTION.edge;
	ctx.lineWidth = SELECTED_EDGE_WIDTH_SCREEN_PX / viewport.k;
	ctx.beginPath();

	for (let e = 0; e < flags.length; e++) {
		if (flags[e] !== 1) continue;
		if (!edgeVisible(anchors, positions, e, view, straight)) continue;

		if (straight) {
			const from = anchors.source[e];
			const to = anchors.target[e];
			if (from < 0 || to < 0) continue;
			ctx.moveTo(
				positions.x[from] + anchors.sourceCentreX[e],
				positions.y[from] + anchors.sourceCentreY[e]
			);
			ctx.lineTo(
				positions.x[to] + anchors.targetCentreX[e],
				positions.y[to] + anchors.targetCentreY[e]
			);
			continue;
		}

		if (!writeEdgeGeometry(geometry, anchors, positions, e)) continue;
		ctx.moveTo(geometry.fromX, geometry.fromY);
		ctx.bezierCurveTo(
			geometry.c1x,
			geometry.c1y,
			geometry.c2x,
			geometry.c2y,
			geometry.toX,
			geometry.toY
		);
	}

	ctx.stroke();
}

/**
 * Port dots, for on-screen nodes only, at the full detail tier only.
 *
 * This loop used to run over every node in the graph and was the single largest
 * item in the phase 3 frame — 24,800 rects at the 10k fixture. It is now
 * bounded by the viewport.
 */
function drawPorts(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { graph, positions, visible, visibleCount, viewport } = input;

	const size = PORT_SIZE_SCREEN_PX / viewport.k;
	const half = size / 2;

	// One accumulated path per data type, filled once — same reasoning as edges.
	const paths: Record<string, Path2D> = {};
	for (const type of DATA_TYPES) paths[type] = new Path2D();

	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		const x = positions.x[i];
		const y = positions.y[i];

		for (let s = 0; s < node.inputs.length; s++) {
			const py = y + portOffsetY(s, node.inputs.length, node.height);
			paths[node.inputs[s].dataType].rect(x - half, py - half, size, size);
		}
		for (let s = 0; s < node.outputs.length; s++) {
			const py = y + portOffsetY(s, node.outputs.length, node.height);
			paths[node.outputs[s].dataType].rect(x + node.width - half, py - half, size, size);
		}
	}

	for (const type of DATA_TYPES) {
		ctx.fillStyle = DATA_TYPE_COLOR[type];
		ctx.fill(paths[type]);
	}
}

/**
 * A ring around every selected node that is on screen.
 *
 * Drawn *outside* the node bounds, which is what makes one mechanism work for
 * both render modes: it stays visible under an opaque DOM node element, and it
 * stays visible around a canvas-drawn node. The gap and the stroke are
 * specified in screen pixels and divided by the zoom, so the ring stays legible
 * whether you are at 3x or at 0.02x.
 *
 * Since phase 5 this walks the culled list rather than the whole flag array, so
 * its cost is bounded by the screen rather than by how much is selected.
 */
function drawNodeSelection(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { graph, positions, selection, visible, visibleCount, viewport } = input;
	if (selection.nodeCount === 0) return;

	const flags = selection.nodeFlags;
	const gap = SELECTION_RING_GAP_PX / viewport.k;

	ctx.strokeStyle = SELECTION.node;
	ctx.lineWidth = SELECTION_RING_WIDTH_PX / viewport.k;
	ctx.beginPath();

	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		if (flags[i] !== 1) continue;
		const node = graph.nodes[i];
		ctx.rect(
			positions.x[i] - gap,
			positions.y[i] - gap,
			node.width + gap * 2,
			node.height + gap * 2
		);
	}

	ctx.stroke();
}

/** The live marquee box. In graph units, so a mid-drag zoom keeps it over the same nodes. */
function drawMarquee(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { marquee, viewport } = input;
	if (!marquee) return;

	ctx.fillStyle = SELECTION.marqueeFill;
	ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);

	ctx.strokeStyle = SELECTION.marqueeStroke;
	ctx.lineWidth = 1 / viewport.k;
	ctx.setLineDash([4 / viewport.k, 3 / viewport.k]);
	ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
	ctx.setLineDash([]);
}
