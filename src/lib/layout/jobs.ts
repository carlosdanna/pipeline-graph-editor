import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';
import type { LayoutJob } from './client';
import type { DirtyRegion } from './incremental';
import type { LayoutOptions } from './protocol';

/**
 * Packing a graph (or a slice of one) into the flat arrays the worker wants.
 *
 * Note what is *not* sent: ports, labels, kinds, statuses, ids. ELK is asked
 * only "here are boxes of these sizes and these connections between them".
 * Because we route edges ourselves from our own port anchors, ELK never needs
 * to know a port exists — which removes ~30,000 objects from the 10k job and
 * gives ELK a meaningfully smaller problem to solve.
 */

export function fullLayoutJob(
	graph: PipelineGraph,
	index: GraphIndex,
	options: LayoutOptions
): LayoutJob {
	const count = graph.nodes.length;
	const nodeId = new Int32Array(count);
	const width = new Float64Array(count);
	const height = new Float64Array(count);

	for (let i = 0; i < count; i++) {
		nodeId[i] = i;
		width[i] = graph.nodes[i].width;
		height[i] = graph.nodes[i].height;
	}

	const edgeSource = new Int32Array(graph.edges.length);
	const edgeTarget = new Int32Array(graph.edges.length);
	let kept = 0;
	for (let e = 0; e < graph.edges.length; e++) {
		const from = index.nodeIndexById.get(graph.edges[e].source);
		const to = index.nodeIndexById.get(graph.edges[e].target);
		if (from === undefined || to === undefined) continue;
		edgeSource[kept] = from;
		edgeTarget[kept] = to;
		kept++;
	}

	return {
		nodeId,
		width,
		height,
		// No seeds: a full layout starts from nothing.
		seedX: new Float64Array(0),
		seedY: new Float64Array(0),
		edgeSource: edgeSource.slice(0, kept),
		edgeTarget: edgeTarget.slice(0, kept),
		options
	};
}

export function regionLayoutJob(
	graph: PipelineGraph,
	index: GraphIndex,
	positions: PositionStore,
	region: DirtyRegion,
	options: LayoutOptions
): LayoutJob {
	const participants = region.participants;
	const count = participants.length;

	const nodeId = new Int32Array(count);
	const width = new Float64Array(count);
	const height = new Float64Array(count);
	const seedX = new Float64Array(count);
	const seedY = new Float64Array(count);

	for (let i = 0; i < count; i++) {
		const v = participants[i];
		nodeId[i] = v;
		width[i] = graph.nodes[v].width;
		height[i] = graph.nodes[v].height;
		// Seeds are the real current coordinates, which the INTERACTIVE
		// strategies use to work out layering and in-layer order.
		seedX[i] = positions.x[v];
		seedY[i] = positions.y[v];
	}

	const edgeSource = new Int32Array(region.edges.length);
	const edgeTarget = new Int32Array(region.edges.length);
	for (let i = 0; i < region.edges.length; i++) {
		const edge = graph.edges[region.edges[i]];
		edgeSource[i] = index.nodeIndexById.get(edge.source) ?? 0;
		edgeTarget[i] = index.nodeIndexById.get(edge.target) ?? 0;
	}

	return { nodeId, width, height, seedX, seedY, edgeSource, edgeTarget, options };
}
