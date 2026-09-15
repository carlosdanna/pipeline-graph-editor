import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
import type { PositionStore } from '$lib/graph/positions';
import { NODE_KINDS, NODE_STATUSES, type PipelineGraph } from '$lib/graph/types';
import type { DetailLevel } from './limits';
import { KIND_COLOR, PALETTE, STATUS_COLORS, formatThroughput, truncate } from './theme';

/**
 * Nodes, drawn on the canvas.
 *
 * Used in two situations, which is why it handles all three detail levels
 * rather than only the coarse ones:
 *
 *  - Above `DOM_NODE_LIMIT`, where there are too many nodes to be DOM elements.
 *  - Below `ZOOM_SIMPLE`, at any graph size, because a node drawn at half scale
 *    has nothing in it worth keeping an element for.
 *
 * The second case is the interesting one. It means the DOM layer is not just a
 * small-graph path — it is the *zoomed-in* path, and zooming out is a second,
 * independent way to fall back to the canvas. Both roads lead here, which is
 * the point of having kept every interaction off the node elements.
 *
 * Batching follows the same rule as edges: colour is a canvas state change, so
 * accumulate one path per colour and fill once. Node colours come from two
 * small closed sets — five kinds and four statuses — so the number of draw
 * calls is bounded by the palette, not by the node count.
 */

export interface NodeDrawInput {
	readonly graph: PipelineGraph;
	readonly dynamics: DynamicsStore;
	readonly positions: PositionStore;
	/** Indices of on-screen nodes, and how many of the buffer is in use. */
	readonly visible: Int32Array;
	readonly visibleCount: number;
	readonly detail: DetailLevel;
	readonly zoom: number;
}

/** Size of a node at the coarsest tier, in screen pixels. */
const DOT_SIZE_PX = 4;
const KIND_STRIPE_PX = 3;
const BORDER_PX = 1;
const LABEL_SIZE_PX = 11;
const RATE_SIZE_PX = 9.5;
const LABEL_PAD_PX = 9;
const CORNER_RADIUS_PX = 6;
/** Below this on-screen width there is no room for two pieces of text. */
const RATE_MIN_NODE_WIDTH_PX = 120;

export function drawNodes(ctx: CanvasRenderingContext2D, input: NodeDrawInput): void {
	if (input.visibleCount === 0) return;

	switch (input.detail) {
		case 'dot':
			drawDots(ctx, input);
			return;
		case 'simple':
			drawBoxes(ctx, input);
			return;
		case 'full':
			drawFull(ctx, input);
			return;
	}
}

/**
 * One square per node, coloured by status, at a constant screen size.
 *
 * Status is the only thing worth keeping this far out: at 0.25 zoom a node is
 * 44 screen pixels and you are looking at the shape of the pipeline and where
 * the red is, not at any individual stage.
 */
function drawDots(ctx: CanvasRenderingContext2D, input: NodeDrawInput): void {
	const { graph, dynamics, positions, visible, visibleCount, zoom } = input;

	const size = DOT_SIZE_PX / zoom;
	const half = size / 2;

	const paths = statusPaths();
	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		paths[dynamics.status[i]].rect(
			positions.x[i] + node.width / 2 - half,
			positions.y[i] + node.height / 2 - half,
			size,
			size
		);
	}

	fillByStatus(ctx, paths);
}

/**
 * A plain filled box per node: kind as the fill, status as the border.
 *
 * No labels, no ports, no stripe. Nine fills and strokes total however many
 * nodes are on screen.
 */
function drawBoxes(ctx: CanvasRenderingContext2D, input: NodeDrawInput): void {
	const { graph, dynamics, positions, visible, visibleCount, zoom } = input;

	const kindPaths = kindPathSet();
	const statusPathSet = statusPaths();

	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		const x = positions.x[i];
		const y = positions.y[i];
		kindPaths[node.kind].rect(x, y, node.width, node.height);
		statusPathSet[dynamics.status[i]].rect(x, y, node.width, node.height);
	}

	ctx.globalAlpha = 0.55;
	for (const kind of NODE_KINDS) {
		ctx.fillStyle = KIND_COLOR[kind];
		ctx.fill(kindPaths[kind]);
	}
	ctx.globalAlpha = 1;

	ctx.lineWidth = BORDER_PX / zoom;
	for (let i = 0; i < statusPathSet.length; i++) {
		ctx.strokeStyle = STATUS_COLORS[i];
		ctx.stroke(statusPathSet[i]);
	}
}

/**
 * The full node: body, kind stripe, status border, label and throughput.
 *
 * Only reached when nodes are on the canvas rather than in the DOM — that is,
 * above `DOM_NODE_LIMIT`. The text is the one thing here that cannot be
 * batched, but it does not need to be: at this zoom the viewport holds a few
 * dozen nodes, and culling means that is all we are asked to draw. The cost of
 * this path is bounded by the screen, not by the fixture.
 */
function drawFull(ctx: CanvasRenderingContext2D, input: NodeDrawInput): void {
	const { graph, dynamics, positions, visible, visibleCount, zoom } = input;

	const radius = CORNER_RADIUS_PX / zoom;
	const stripe = KIND_STRIPE_PX / zoom;

	// Bodies: one colour, so one path and one fill.
	const bodies = new Path2D();
	const kindPaths = kindPathSet();
	const statusPathSet = statusPaths();

	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		const x = positions.x[i];
		const y = positions.y[i];

		bodies.roundRect(x, y, node.width, node.height, radius);
		kindPaths[node.kind].rect(x, y, stripe, node.height);
		statusPathSet[dynamics.status[i]].roundRect(x, y, node.width, node.height, radius);
	}

	ctx.fillStyle = PALETTE.surfaceRaised;
	ctx.fill(bodies);

	for (const kind of NODE_KINDS) {
		ctx.fillStyle = KIND_COLOR[kind];
		ctx.fill(kindPaths[kind]);
	}

	ctx.lineWidth = BORDER_PX / zoom;
	for (let i = 0; i < statusPathSet.length; i++) {
		ctx.strokeStyle = STATUS_COLORS[i];
		ctx.stroke(statusPathSet[i]);
	}

	drawLabels(ctx, input);
}

function drawLabels(ctx: CanvasRenderingContext2D, input: NodeDrawInput): void {
	const { graph, dynamics, positions, visible, visibleCount, zoom } = input;

	const pad = LABEL_PAD_PX / zoom;
	// Font sizes are in graph units, and the transform scales them back to the
	// screen size we actually want. Setting the font is a state change, so it
	// happens twice per frame rather than twice per node.
	const labelFont = `${LABEL_SIZE_PX / zoom}px system-ui, sans-serif`;
	const rateFont = `${RATE_SIZE_PX / zoom}px system-ui, sans-serif`;

	ctx.textBaseline = 'middle';

	ctx.font = labelFont;
	ctx.fillStyle = PALETTE.text;
	ctx.textAlign = 'left';
	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		// Truncated by character count rather than by measuring. `measureText`
		// per node would be a real cost, and the node width is fixed by the
		// generator, so a constant is as good as a measurement here.
		ctx.fillText(
			truncate(node.label, 17),
			positions.x[i] + pad,
			positions.y[i] + node.height / 2
		);
	}

	ctx.font = rateFont;
	ctx.fillStyle = PALETTE.textMuted;
	ctx.textAlign = 'right';
	for (let v = 0; v < visibleCount; v++) {
		const i = visible[v];
		const node = graph.nodes[i];
		if (node.width * zoom < RATE_MIN_NODE_WIDTH_PX) continue;
		ctx.fillText(
			formatThroughput(dynamics.throughput[i]),
			positions.x[i] + node.width - pad,
			positions.y[i] + node.height / 2
		);
	}

	ctx.textAlign = 'left';
}

// --- Path sets -------------------------------------------------------------
//
// One Path2D per colour, allocated per frame. Nine small objects a frame is not
// worth pooling — unlike the per-edge geometry, which was 74,000.

/**
 * One path per status, indexed by the same byte `DynamicsStore` stores.
 *
 * Keyed by number rather than by name so the draw loop never turns a status
 * byte back into a string just to index a record — at 200 updates a second
 * over a redrawn viewport that is pure waste.
 */
function statusPaths(): Path2D[] {
	const paths = new Array<Path2D>(NODE_STATUSES.length);
	for (let i = 0; i < paths.length; i++) paths[i] = new Path2D();
	return paths;
}

function kindPathSet(): Record<string, Path2D> {
	const paths: Record<string, Path2D> = {};
	for (const kind of NODE_KINDS) paths[kind] = new Path2D();
	return paths;
}

function fillByStatus(ctx: CanvasRenderingContext2D, paths: Path2D[]): void {
	for (let i = 0; i < paths.length; i++) {
		ctx.fillStyle = STATUS_COLORS[i];
		ctx.fill(paths[i]);
	}
}
