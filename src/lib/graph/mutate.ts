import { nodeHeightFor, NODE_WIDTH } from './generate';
import type { GraphIndex } from './indexing';
import type { PipelineEdge, PipelineGraph, PipelineNode, Port } from './types';

/**
 * Structural edits.
 *
 * One rule governs everything here: **node indices are append-only**. A new
 * node goes on the end of `nodes` and every existing index keeps its meaning.
 * That is what lets `PositionStore.resized()` be a prefix copy, lets the
 * quadtree in phase 4 be patched rather than rebuilt, and lets an incremental
 * layout name its dirty set by index. Splicing a node into the middle would
 * invalidate every index held anywhere in the app.
 *
 * Every edit returns a new `PipelineGraph` rather than mutating one, because
 * the graph lives in `$state.raw` and reference equality is the change signal.
 */

export interface GraphMutation {
	readonly graph: PipelineGraph;
	/** Indices of the nodes that were added — the dirty set for layout. */
	readonly addedIndices: readonly number[];
}

/**
 * Appends a transform stage fed by an existing node's first output port.
 *
 * Deliberately the simplest structural change that still exercises everything:
 * it adds a node and an edge, it changes one existing node's out-degree, and it
 * gives the incremental layout a genuine dirty set of exactly one node.
 */
export function addDownstreamStage(
	graph: PipelineGraph,
	upstreamIndex: number
): GraphMutation {
	const upstream = graph.nodes[upstreamIndex];
	const sourcePort = upstream.outputs[0];
	if (!sourcePort) return { graph, addedIndices: [] };

	const newIndex = graph.nodes.length;
	const id = `n${newIndex}`;

	const input: Port = {
		id: `${id}:in:in`,
		name: 'in',
		direction: 'in',
		dataType: sourcePort.dataType
	};
	// A transform passes its input type through, same rule the generator uses.
	const output: Port = {
		id: `${id}:out:out`,
		name: 'out',
		direction: 'out',
		dataType: sourcePort.dataType
	};

	const node: PipelineNode = {
		id,
		kind: 'transform',
		label: `added-stage-${newIndex}`,
		width: NODE_WIDTH,
		height: nodeHeightFor(1, 1),
		inputs: [input],
		outputs: [output]
	};

	const edge: PipelineEdge = {
		id: `e${graph.edges.length}`,
		source: upstream.id,
		sourcePort: sourcePort.id,
		target: id,
		targetPort: input.id,
		dataType: sourcePort.dataType
	};

	// Dynamics are deliberately not threaded through here. Structure and
	// dynamics are separate stores, and a structural edit should not have to
	// know that telemetry exists — the session grows the dynamics store itself.
	return {
		graph: { nodes: [...graph.nodes, node], edges: [...graph.edges, edge] },
		addedIndices: [newIndex]
	};
}

/** A node that can take a downstream stage, i.e. anything that emits. */
export function pickUpstreamCandidate(
	graph: PipelineGraph,
	index: GraphIndex,
	random: number
): number {
	const candidates: number[] = [];
	for (let i = 0; i < graph.nodes.length; i++) {
		if (graph.nodes[i].outputs.length > 0 && index.outgoing[i].length > 0) candidates.push(i);
	}
	if (candidates.length === 0) return 0;
	return candidates[Math.min(candidates.length - 1, Math.floor(random * candidates.length))];
}
