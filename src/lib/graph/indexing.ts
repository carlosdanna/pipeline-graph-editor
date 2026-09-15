import type { EdgeId, NodeId, PipelineGraph, PortId } from './types';

/**
 * Derived lookup tables for a PipelineGraph.
 *
 * Rebuilt whenever structure changes (which is rare — that is the point of the
 * structure/dynamics split). Everything downstream — layout, hit testing,
 * keyboard navigation, the table pane — reads nodes by *index*, so these maps
 * are the only place ids are resolved.
 *
 * Adjacency stores EDGE indices rather than neighbour node indices, because
 * every consumer that wants the neighbour also wants the edge (to draw it, to
 * label the keyboard move, to know the data type).
 */
export interface GraphIndex {
	readonly nodeIndexById: ReadonlyMap<NodeId, number>;
	readonly edgeIndexById: ReadonlyMap<EdgeId, number>;
	/** node index -> indices of edges leaving that node */
	readonly outgoing: readonly (readonly number[])[];
	/** node index -> indices of edges entering that node */
	readonly incoming: readonly (readonly number[])[];
	/** port id -> index of the node that owns it */
	readonly nodeIndexByPortId: ReadonlyMap<PortId, number>;
	/**
	 * port id -> the port's slot number within its node's inputs (or outputs).
	 * Precomputed because edge rendering needs it for every edge, every frame;
	 * a `findIndex` per endpoint would be 26k array scans per frame at the 10k
	 * fixture.
	 */
	readonly portSlotById: ReadonlyMap<PortId, number>;
}

export function buildGraphIndex(graph: PipelineGraph): GraphIndex {
	const nodeIndexById = new Map<NodeId, number>();
	const nodeIndexByPortId = new Map<PortId, number>();
	const portSlotById = new Map<PortId, number>();
	const outgoing: number[][] = new Array(graph.nodes.length);
	const incoming: number[][] = new Array(graph.nodes.length);

	for (let i = 0; i < graph.nodes.length; i++) {
		const node = graph.nodes[i];
		nodeIndexById.set(node.id, i);
		for (let s = 0; s < node.inputs.length; s++) {
			nodeIndexByPortId.set(node.inputs[s].id, i);
			portSlotById.set(node.inputs[s].id, s);
		}
		for (let s = 0; s < node.outputs.length; s++) {
			nodeIndexByPortId.set(node.outputs[s].id, i);
			portSlotById.set(node.outputs[s].id, s);
		}
		outgoing[i] = [];
		incoming[i] = [];
	}

	const edgeIndexById = new Map<EdgeId, number>();
	for (let e = 0; e < graph.edges.length; e++) {
		const edge = graph.edges[e];
		edgeIndexById.set(edge.id, e);
		const from = nodeIndexById.get(edge.source);
		const to = nodeIndexById.get(edge.target);
		// Dangling endpoints are a validation error, not an indexing error;
		// skip them here so a broken graph still renders what it can.
		if (from !== undefined) outgoing[from].push(e);
		if (to !== undefined) incoming[to].push(e);
	}

	return { nodeIndexById, edgeIndexById, outgoing, incoming, nodeIndexByPortId, portSlotById };
}

/**
 * Longest-path layering: every node sits one level below its deepest parent.
 *
 * Computed from the edges rather than remembered from the generator — if the
 * generator ever produced a cycle or a broken parent link, this is where it
 * shows up. Returns null if the graph is not a DAG.
 */
export function computeLayers(graph: PipelineGraph, index: GraphIndex): Int32Array | null {
	const n = graph.nodes.length;
	const layer = new Int32Array(n);
	const remainingParents = new Int32Array(n);
	const queue: number[] = [];

	for (let i = 0; i < n; i++) {
		remainingParents[i] = index.incoming[i].length;
		if (remainingParents[i] === 0) queue.push(i);
	}

	let visited = 0;
	// Kahn's algorithm. `queue` is used as a FIFO via a moving head index so we
	// never pay for Array.shift() on a 10k-node graph.
	for (let head = 0; head < queue.length; head++) {
		const v = queue[head];
		visited++;
		for (const e of index.outgoing[v]) {
			const edge = graph.edges[e];
			const child = index.nodeIndexById.get(edge.target);
			if (child === undefined) continue;
			if (layer[v] + 1 > layer[child]) layer[child] = layer[v] + 1;
			remainingParents[child] -= 1;
			if (remainingParents[child] === 0) queue.push(child);
		}
	}

	return visited === n ? layer : null;
}
