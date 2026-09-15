import { portOffsetY } from '$lib/graph/generate';
import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import { DATA_TYPES, type PipelineGraph, type Rect } from '$lib/graph/types';
import type { SelectionStore } from '$lib/interact/selection.svelte';
import type { EdgeBuckets } from './edge-buckets';
import { createEdgeGeometry, writeEdgeGeometry } from './edge-geometry';
import { DATA_TYPE_COLOR, PALETTE, SELECTION } from './theme';

/**
 * Everything drawn on the canvas: the background grid, every edge, the port
 * dots that edges terminate on, and — from phase 4 — selection and the marquee.
 *
 * Nodes are NOT here — they are DOM elements in a CSS-transformed layer above
 * this canvas, sharing the same transform. Phase 5 adds a canvas fallback for
 * nodes above a threshold.
 *
 * Why ports are on the canvas and not on the node elements: an edge endpoint and
 * the dot it lands on are the same piece of geometry, and drawing them from the
 * same numbers is the only way to guarantee they never disagree. It also strips
 * ~4 elements off every node, which is 8,000 fewer DOM nodes at the 2,000-node
 * fixture.
 *
 * Selection is drawn here too, rather than as a CSS class on the node elements.
 * That is what lets a marquee change the selection at 60fps without touching
 * Svelte's reactivity at all — and it means selection rendering does not change
 * when phase 5 stops putting nodes in the DOM.
 */

export interface SceneInput {
	readonly graph: PipelineGraph;
	readonly index: GraphIndex;
	readonly positions: PositionStore;
	readonly buckets: EdgeBuckets;
	readonly selection: SelectionStore;
	/** Live marquee box in graph units, or null. */
	readonly marquee: Rect | null;
	readonly viewport: { x: number; y: number; k: number };
	readonly cssWidth: number;
	readonly cssHeight: number;
	readonly devicePixelRatio: number;
}

export interface SceneStats {
	readonly drawMs: number;
	readonly visibleNodes: number;
	readonly totalNodes: number;
	readonly edgeCount: number;
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

	drawEdges(ctx, input);
	drawSelectedEdges(ctx, input);
	const visibleNodes = drawPortsAndCountVisible(ctx, input);
	drawNodeSelection(ctx, input);
	drawMarquee(ctx, input);

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	return {
		drawMs: performance.now() - startedAt,
		visibleNodes,
		totalNodes: input.graph.nodes.length,
		edgeCount: input.graph.edges.length
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

function drawEdges(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { graph, index, positions, buckets, viewport } = input;

	// Line width is in graph units now, so undo the zoom to keep edges a
	// constant thickness on screen.
	ctx.lineWidth = EDGE_WIDTH_SCREEN_PX / viewport.k;
	ctx.globalAlpha = 0.55;

	for (const type of DATA_TYPES) {
		const bucket = buckets[type];
		if (bucket.length === 0) continue;

		ctx.strokeStyle = DATA_TYPE_COLOR[type];
		ctx.beginPath();
		for (let i = 0; i < bucket.length; i++) {
			if (!writeEdgeGeometry(geometry, graph, index, positions, bucket[i])) continue;
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
}

/**
 * Selected edges, redrawn over the bucketed pass at full opacity.
 *
 * Drawing them a second time rather than skipping them in the first pass keeps
 * the colour buckets untouched — they are built once per graph and would
 * otherwise have to be rebuilt on every selection change. The overdraw is one
 * extra stroke of however many edges are selected, which is bounded by what
 * someone can actually pick.
 *
 * The scan over `edgeFlags` is skipped entirely when nothing is selected, which
 * is the common case and the one that must stay free.
 */
function drawSelectedEdges(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { graph, index, positions, selection, viewport } = input;
	if (selection.edgeCount === 0) return;

	const flags = selection.edgeFlags;
	ctx.strokeStyle = SELECTION.edge;
	ctx.lineWidth = SELECTED_EDGE_WIDTH_SCREEN_PX / viewport.k;
	ctx.beginPath();

	for (let e = 0; e < flags.length; e++) {
		if (flags[e] !== 1) continue;
		if (!writeEdgeGeometry(geometry, graph, index, positions, e)) continue;
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
 * Draws port dots and, in the same pass, counts how many nodes are on screen.
 *
 * The count is for the HUD only — phase 4 still draws everything. Watching
 * "visible 40 / 2,000" while the frame time says otherwise is the whole
 * argument for phase 5.
 */
function drawPortsAndCountVisible(ctx: CanvasRenderingContext2D, input: SceneInput): number {
	const { graph, positions, viewport: vp, cssWidth, cssHeight } = input;

	const left = (0 - vp.x) / vp.k;
	const top = (0 - vp.y) / vp.k;
	const right = (cssWidth - vp.x) / vp.k;
	const bottom = (cssHeight - vp.y) / vp.k;

	const size = PORT_SIZE_SCREEN_PX / vp.k;
	const half = size / 2;

	// One accumulated path per data type, filled once — same reasoning as edges.
	const paths: Record<string, Path2D> = {};
	for (const type of DATA_TYPES) paths[type] = new Path2D();

	let visible = 0;
	for (let i = 0; i < graph.nodes.length; i++) {
		const node = graph.nodes[i];
		const x = positions.x[i];
		const y = positions.y[i];

		const onScreen = x < right && x + node.width > left && y < bottom && y + node.height > top;
		if (onScreen) visible++;

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

	return visible;
}

/**
 * A ring around every selected node.
 *
 * Drawn *outside* the node bounds, which is what makes one mechanism work for
 * both render modes: it stays visible under an opaque DOM node element, and it
 * will stay visible around a canvas-drawn node in phase 5. The gap and the
 * stroke are specified in screen pixels and divided by the zoom, so the ring
 * stays legible whether you are at 3x or at 0.02x.
 */
function drawNodeSelection(ctx: CanvasRenderingContext2D, input: SceneInput): void {
	const { graph, positions, selection, viewport } = input;
	if (selection.nodeCount === 0) return;

	const flags = selection.nodeFlags;
	const gap = SELECTION_RING_GAP_PX / viewport.k;

	ctx.strokeStyle = SELECTION.node;
	ctx.lineWidth = SELECTION_RING_WIDTH_PX / viewport.k;
	ctx.beginPath();

	for (let i = 0; i < flags.length; i++) {
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
