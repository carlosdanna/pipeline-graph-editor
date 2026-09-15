import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
import type { PipelineGraph } from '$lib/graph/types';
import type { EdgeAnchors } from '$lib/render/edge-anchors';
import { formatThroughput } from '$lib/render/theme';

/**
 * What a node or an edge is called, out loud.
 *
 * Kept away from the components because these strings are the *entire*
 * interface for someone using a screen reader — the canvas is a blank rectangle
 * to them — so they deserve to be written deliberately and tested, not
 * assembled inline in a template.
 *
 * Two rules, both learned by reading them back:
 *
 *  - **Say the throughput as a rate, not as a number.** "12.4k" is what the
 *    node shows; "12.4 thousand records per second" is what it means. The
 *    visual abbreviation exists because a node is 176 pixels wide, which is not
 *    a constraint speech has.
 *  - **Lead with the label.** Screen reader users interrupt constantly; the
 *    identifying word has to come first, before the kind and the status.
 */

/** Spoken form of a rate. The visual `formatThroughput` is too terse for speech. */
export function spokenThroughput(recordsPerSecond: number): string {
	if (recordsPerSecond <= 0) return 'idle';
	if (recordsPerSecond < 1000) return `${recordsPerSecond} records per second`;
	if (recordsPerSecond < 1_000_000) {
		return `${(recordsPerSecond / 1000).toFixed(1)} thousand records per second`;
	}
	return `${(recordsPerSecond / 1_000_000).toFixed(1)} million records per second`;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * A node, as one sentence.
 *
 * e.g. "normalize-orders-12, transform, running, 12.4 thousand records per
 * second, 2 inputs, 3 outputs"
 */
export function describeNode(
	graph: PipelineGraph,
	dynamics: DynamicsStore,
	nodeIndex: number
): string {
	const node = graph.nodes[nodeIndex];
	if (!node) return '';

	const live = dynamics.view(nodeIndex);
	return [
		node.label,
		node.kind,
		live.status,
		spokenThroughput(live.throughput),
		plural(node.inputs.length, 'input'),
		plural(node.outputs.length, 'output')
	].join(', ');
}

/**
 * An edge, as one sentence.
 *
 * e.g. "records, from normalize-orders-12 to rollup-billing-4"
 *
 * Named by its endpoints rather than by an id, because `e4821` is not
 * information. The data type comes first because it is what distinguishes two
 * edges between the same pair of stages.
 */
export function describeEdge(
	graph: PipelineGraph,
	anchors: EdgeAnchors,
	edgeIndex: number
): string {
	const edge = graph.edges[edgeIndex];
	if (!edge) return '';

	// Endpoints from the flat arrays, not by searching the node list. The
	// obvious `graph.nodes.find(n => n.id === edge.source)` is O(nodes) per
	// edge, which at 150 described nodes and their edges is a five-figure scan
	// every time the tree is rebuilt.
	const source = graph.nodes[anchors.source[edgeIndex]];
	const target = graph.nodes[anchors.target[edgeIndex]];
	return `${edge.dataType}, from ${source?.label ?? edge.source} to ${target?.label ?? edge.target}`;
}

/** Short visual form, for the row and the node body. Re-exported so callers have one import. */
export { formatThroughput };
