import { computeLayers, type GraphIndex } from '$lib/graph/indexing';
import { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';

/**
 * Phase 1 placeholder layout: pure column stacking by longest-path layer.
 *
 * This is deliberately naive. It does no crossing reduction and no ordering
 * within a column — nodes land in whatever order they appear in `graph.nodes`.
 * Edges will cross a lot, and that is the point: it gives phase 2 (ELK in a
 * worker) something to visibly beat, and it keeps phase 1 about the data model
 * rather than about layout quality.
 *
 * It is also synchronous and O(n), which makes it a useful fallback for the
 * first frame before the worker reports back.
 */

export const COLUMN_GAP = 120;
export const ROW_GAP = 22;

export interface StaticLayout {
	readonly positions: PositionStore;
	/** Node indices grouped by layer, in draw order. */
	readonly layers: readonly (readonly number[])[];
	readonly durationMs: number;
}

export function layoutLayered(graph: PipelineGraph, index: GraphIndex): StaticLayout {
	const startedAt = performance.now();
	const positions = new PositionStore(graph.nodes.length);

	const layerOf = computeLayers(graph, index);
	if (layerOf === null) {
		// Not a DAG. Validation will have said so loudly; fall back to a grid so
		// the screen still shows something inspectable.
		return { positions: gridFallback(graph, positions), layers: [], durationMs: performance.now() - startedAt };
	}

	const layers: number[][] = [];
	for (let i = 0; i < graph.nodes.length; i++) {
		const l = layerOf[i];
		while (layers.length <= l) layers.push([]);
		layers[l].push(i);
	}

	// Every node is NODE_WIDTH wide, so column x is a simple multiple. When ELK
	// takes over in phase 2 this becomes a per-column measurement instead.
	const columnWidth = graph.nodes.length > 0 ? graph.nodes[0].width : 0;

	for (let l = 0; l < layers.length; l++) {
		const column = layers[l];
		let columnHeight = 0;
		for (const i of column) columnHeight += graph.nodes[i].height + ROW_GAP;
		columnHeight -= ROW_GAP;

		const x = l * (columnWidth + COLUMN_GAP);
		let y = -columnHeight / 2;
		for (const i of column) {
			positions.set(i, x, y);
			y += graph.nodes[i].height + ROW_GAP;
		}
	}

	return { positions, layers, durationMs: performance.now() - startedAt };
}

function gridFallback(graph: PipelineGraph, positions: PositionStore): PositionStore {
	const perRow = Math.ceil(Math.sqrt(graph.nodes.length));
	for (let i = 0; i < graph.nodes.length; i++) {
		positions.set(i, (i % perRow) * 260, Math.floor(i / perRow) * 120);
	}
	return positions;
}
