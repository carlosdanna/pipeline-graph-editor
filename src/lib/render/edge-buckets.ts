import { DATA_TYPES, type DataType, type PipelineGraph } from '$lib/graph/types';

/**
 * Edge indices grouped by data type.
 *
 * Canvas state changes are expensive, and `strokeStyle` is a state change. Drawn
 * naively — begin path, set colour, stroke, per edge — the 10k fixture costs
 * ~14,700 stroke calls per frame. Grouped by colour it costs four: one path per
 * data type, accumulated with `moveTo`/`bezierCurveTo`, then a single `stroke()`.
 *
 * The grouping only changes when the graph structure changes, so it is computed
 * once per graph and cached, never per frame.
 */
export type EdgeBuckets = Readonly<Record<DataType, Int32Array>>;

export function buildEdgeBuckets(graph: PipelineGraph): EdgeBuckets {
	const counts: Record<string, number> = {};
	for (const type of DATA_TYPES) counts[type] = 0;
	for (const edge of graph.edges) counts[edge.dataType]++;

	const buckets = {} as Record<DataType, Int32Array>;
	const cursors: Record<string, number> = {};
	for (const type of DATA_TYPES) {
		buckets[type] = new Int32Array(counts[type]);
		cursors[type] = 0;
	}

	for (let e = 0; e < graph.edges.length; e++) {
		const type = graph.edges[e].dataType;
		buckets[type][cursors[type]++] = e;
	}

	return buckets;
}
