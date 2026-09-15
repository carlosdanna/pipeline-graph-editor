import { buildGraphIndex, computeLayers, type GraphIndex } from './indexing';
import type { PipelineGraph, Port } from './types';

/**
 * Structural validation.
 *
 * Phase 1 exists to prove the data model before any rendering cleverness, and
 * this is the proof: if the generator produces something the rest of the system
 * could not honestly render, it shows up here rather than as a mysterious blank
 * area at 0.3 zoom in phase 5. The phase 9 unit tests reuse it directly.
 */
export interface ValidationResult {
	readonly ok: boolean;
	readonly errors: readonly string[];
	readonly stats: ValidationStats;
}

export interface ValidationStats {
	readonly nodeCount: number;
	readonly edgeCount: number;
	readonly layerCount: number;
	readonly sourceCount: number;
	readonly sinkCount: number;
	readonly maxInDegree: number;
	readonly maxOutDegree: number;
	readonly longestPath: number;
	readonly validationMs: number;
}

const MAX_REPORTED_ERRORS = 20;

export function validateGraph(graph: PipelineGraph, index?: GraphIndex): ValidationResult {
	const startedAt = performance.now();
	const idx = index ?? buildGraphIndex(graph);
	const errors: string[] = [];
	const report = (message: string): void => {
		if (errors.length < MAX_REPORTED_ERRORS) errors.push(message);
	};

	// --- Identity
	const seenNodeIds = new Set<string>();
	const portsById = new Map<string, Port>();
	for (const node of graph.nodes) {
		if (seenNodeIds.has(node.id)) report(`duplicate node id "${node.id}"`);
		seenNodeIds.add(node.id);

		for (const port of [...node.inputs, ...node.outputs]) {
			if (portsById.has(port.id)) report(`duplicate port id "${port.id}"`);
			portsById.set(port.id, port);
		}
		if (node.kind === 'source' && node.inputs.length > 0) {
			report(`source "${node.id}" has input ports`);
		}
		if (node.kind === 'sink' && node.outputs.length > 0) {
			report(`sink "${node.id}" has output ports`);
		}
		if (node.width <= 0 || node.height <= 0) report(`node "${node.id}" has a degenerate size`);
	}

	const seenEdgeIds = new Set<string>();
	for (const edge of graph.edges) {
		if (seenEdgeIds.has(edge.id)) report(`duplicate edge id "${edge.id}"`);
		seenEdgeIds.add(edge.id);

		// --- Endpoints exist
		const from = idx.nodeIndexById.get(edge.source);
		const to = idx.nodeIndexById.get(edge.target);
		if (from === undefined) {
			report(`edge "${edge.id}" has unknown source node "${edge.source}"`);
			continue;
		}
		if (to === undefined) {
			report(`edge "${edge.id}" has unknown target node "${edge.target}"`);
			continue;
		}
		if (from === to) report(`edge "${edge.id}" is a self-loop`);

		// --- Ports exist, belong to the right node, and point the right way
		const sourcePort = portsById.get(edge.sourcePort);
		const targetPort = portsById.get(edge.targetPort);
		if (!sourcePort || idx.nodeIndexByPortId.get(edge.sourcePort) !== from) {
			report(`edge "${edge.id}" source port "${edge.sourcePort}" is not on node "${edge.source}"`);
			continue;
		}
		if (!targetPort || idx.nodeIndexByPortId.get(edge.targetPort) !== to) {
			report(`edge "${edge.id}" target port "${edge.targetPort}" is not on node "${edge.target}"`);
			continue;
		}
		if (sourcePort.direction !== 'out') report(`edge "${edge.id}" leaves an input port`);
		if (targetPort.direction !== 'in') report(`edge "${edge.id}" enters an output port`);

		// --- Typed data flow really is typed
		if (sourcePort.dataType !== edge.dataType || targetPort.dataType !== edge.dataType) {
			report(
				`edge "${edge.id}" is ${edge.dataType} but connects ` +
					`${sourcePort.dataType} -> ${targetPort.dataType}`
			);
		}
	}

	// --- Connectivity and acyclicity
	let sourceCount = 0;
	let sinkCount = 0;
	let maxInDegree = 0;
	let maxOutDegree = 0;
	for (let i = 0; i < graph.nodes.length; i++) {
		const inDeg = idx.incoming[i].length;
		const outDeg = idx.outgoing[i].length;
		if (inDeg > maxInDegree) maxInDegree = inDeg;
		if (outDeg > maxOutDegree) maxOutDegree = outDeg;
		if (inDeg === 0 && outDeg === 0) report(`node "${graph.nodes[i].id}" is isolated`);
		if (graph.nodes[i].kind === 'source') sourceCount++;
		if (graph.nodes[i].kind === 'sink') sinkCount++;
	}

	const layers = computeLayers(graph, idx);
	if (layers === null) report('graph contains a cycle — it is not a DAG');

	let longestPath = 0;
	if (layers) {
		for (const l of layers) if (l > longestPath) longestPath = l;
	}

	return {
		ok: errors.length === 0,
		errors,
		stats: {
			nodeCount: graph.nodes.length,
			edgeCount: graph.edges.length,
			layerCount: layers ? longestPath + 1 : 0,
			sourceCount,
			sinkCount,
			maxInDegree,
			maxOutDegree,
			longestPath,
			validationMs: performance.now() - startedAt
		}
	};
}
