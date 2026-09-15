import { portOffsetY } from '$lib/graph/generate';
import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import { DATA_TYPES, type PipelineGraph } from '$lib/graph/types';
import type { EdgeBuckets } from './edge-buckets';
import { createEdgeGeometry, writeEdgeGeometry } from './edge-geometry';
import { DATA_TYPE_COLOR, PALETTE } from './theme';

/**
 * Everything drawn on the canvas: the background grid, every edge, and the port
 * dots that edges terminate on.
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
 */

export interface SceneInput {
	readonly graph: PipelineGraph;
	readonly index: GraphIndex;
	readonly positions: PositionStore;
	readonly buckets: EdgeBuckets;
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
const PORT_SIZE_SCREEN_PX = 5;

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
	const visibleNodes = drawPortsAndCountVisible(ctx, input);

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
 * Draws port dots and, in the same pass, counts how many nodes are on screen.
 *
 * The count is for the HUD only — phase 3 still draws everything. Watching
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
