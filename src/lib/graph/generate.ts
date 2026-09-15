import { mulberry32, pick, weightedIndex, type Rng } from './rng';
import {
	DATA_TYPES,
	NODE_STATUSES,
	type DataType,
	type NodeDynamics,
	type NodeKind,
	type PipelineEdge,
	type PipelineGraph,
	type PipelineNode,
	type Port
} from './types';

// ---------------------------------------------------------------------------
// Node geometry. Size is structural: it depends only on how many port rows the
// node has, so it is computed once here and never recomputed during rendering.
// ---------------------------------------------------------------------------

export const NODE_WIDTH = 176;
export const NODE_HEADER_HEIGHT = 30;
export const PORT_ROW_HEIGHT = 18;
export const NODE_PADDING_BOTTOM = 10;

export function nodeHeightFor(inputCount: number, outputCount: number): number {
	const rows = Math.max(1, inputCount, outputCount);
	return NODE_HEADER_HEIGHT + rows * PORT_ROW_HEIGHT + NODE_PADDING_BOTTOM;
}

/**
 * Vertical centre of port slot `index` of `count`, relative to the node's top
 * edge. Ports are spread evenly through the body rather than stacked from the
 * top, so a node with one inlet and two outlets still looks balanced.
 */
export function portOffsetY(index: number, count: number, nodeHeight: number): number {
	const bodyHeight = nodeHeight - NODE_HEADER_HEIGHT - NODE_PADDING_BOTTOM;
	return NODE_HEADER_HEIGHT + bodyHeight * ((index + 0.5) / Math.max(1, count));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_SIZES = [50, 500, 2000, 10000] as const;
export type FixtureSize = (typeof FIXTURE_SIZES)[number];

export const DEFAULT_SEED = 0x5eed;

export interface GeneratedFixture {
	readonly graph: PipelineGraph;
	/**
	 * Initial telemetry, parallel to `graph.nodes`. Returned *alongside* the
	 * graph rather than embedded in it — see the structure/dynamics note in
	 * types.ts. Phase 6 will own the ongoing updates.
	 */
	readonly initialDynamics: readonly NodeDynamics[];
	readonly layerSizes: readonly number[];
	readonly generationMs: number;
}

// ---------------------------------------------------------------------------
// Label vocabulary — enough realism that the table pane in phase 7 is readable.
// ---------------------------------------------------------------------------

const SOURCE_SYSTEMS = ['kafka', 'kinesis', 'pubsub', 'mqtt', 'sftp', 'cdr', 'syslog'];
const SUBJECTS = [
	'orders', 'sessions', 'clicks', 'billing', 'roaming', 'imsi', 'usage',
	'payments', 'devices', 'alarms', 'topology', 'audit'
];
const TRANSFORM_VERBS = ['normalize', 'enrich', 'decode', 'map', 'reshape', 'join'];
const AGGREGATE_VERBS = ['rollup', 'count', 'sum', 'dedupe', 'window'];
const WINDOWS = ['1m', '5m', '15m', '1h'];
const SINK_SYSTEMS = ['s3', 'bigquery', 'clickhouse', 'elastic', 'postgres', 'billing-api'];

function labelFor(rng: Rng, kind: NodeKind, ordinal: number): string {
	switch (kind) {
		case 'source':
			return `${pick(rng, SOURCE_SYSTEMS)}-${pick(rng, SUBJECTS)}-src-${ordinal}`;
		case 'transform':
			return `${pick(rng, TRANSFORM_VERBS)}-${pick(rng, SUBJECTS)}-${ordinal}`;
		case 'filter':
			return `filter-${pick(rng, SUBJECTS)}-${ordinal}`;
		case 'aggregate':
			return `${pick(rng, AGGREGATE_VERBS)}-${pick(rng, WINDOWS)}-${ordinal}`;
		case 'sink':
			return `${pick(rng, SINK_SYSTEMS)}-${pick(rng, SUBJECTS)}-sink-${ordinal}`;
	}
}

// ---------------------------------------------------------------------------
// Layer profile
// ---------------------------------------------------------------------------

/**
 * How many layers a graph of `n` nodes gets. Sub-linear so that big fixtures get
 * genuinely deep pipelines (long chains) rather than a few enormous columns,
 * but capped so the 10k fixture does not become a 40,000px-wide ribbon.
 */
function depthFor(n: number): number {
	return Math.min(40, Math.max(5, Math.round(2.6 * Math.pow(n, 0.3))));
}

/**
 * Layer widths follow a sine bulge: few sources, widening through the middle,
 * narrowing back to few sinks. That is what produces fan-out near the head and
 * fan-in near the tail without special-casing either.
 *
 * Uses largest-remainder rounding so the sizes sum to exactly `n`.
 */
function layerSizesFor(n: number, depth: number): number[] {
	const weights: number[] = [];
	let total = 0;
	for (let l = 0; l < depth; l++) {
		const w = Math.pow(Math.sin((Math.PI * (l + 0.5)) / depth), 0.85);
		weights.push(w);
		total += w;
	}

	const exact = weights.map((w) => (w / total) * n);
	const sizes = exact.map((v) => Math.max(1, Math.floor(v)));

	let assigned = sizes.reduce((a, b) => a + b, 0);
	// Hand out the remainder to the layers with the largest fractional parts.
	const order = exact
		.map((v, l) => ({ l, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac);

	let cursor = 0;
	while (assigned < n) {
		sizes[order[cursor % order.length].l]++;
		assigned++;
		cursor++;
	}
	// Over-assigned because of the min-1 floor: trim the widest layers.
	while (assigned > n) {
		const widest = sizes.indexOf(Math.max(...sizes));
		if (sizes[widest] <= 1) break;
		sizes[widest]--;
		assigned--;
	}

	return sizes;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateFixture(nodeCount: number, seed: number = DEFAULT_SEED): GeneratedFixture {
	const startedAt = performance.now();
	const rng = mulberry32(seed);

	const depth = depthFor(nodeCount);
	const sizes = layerSizesFor(nodeCount, depth);

	// Nodes are created in layer order, so a node's index already sorts by layer.
	// Everything downstream leans on that: it makes "process in topological
	// order" a plain forward loop.
	const layerOf = new Int32Array(nodeCount);
	const layerStart: number[] = [];
	{
		let cursor = 0;
		for (let l = 0; l < depth; l++) {
			layerStart.push(cursor);
			for (let k = 0; k < sizes[l]; k++) layerOf[cursor + k] = l;
			cursor += sizes[l];
		}
	}

	// --- Pass 1: edge skeleton (which node feeds which), no ports or types yet.
	const parentsOf: number[][] = Array.from({ length: nodeCount }, () => []);
	const childrenOf: number[][] = Array.from({ length: nodeCount }, () => []);

	const connect = (parent: number, child: number): void => {
		if (parentsOf[child].includes(parent)) return;
		parentsOf[child].push(parent);
		childrenOf[parent].push(child);
	};

	for (let l = 1; l < depth; l++) {
		const prevStart = layerStart[l - 1];
		const prevSize = sizes[l - 1];
		const narrowing = prevSize / sizes[l];

		for (let k = 0; k < sizes[l]; k++) {
			const v = layerStart[l] + k;

			// A narrowing layer fans in; an equal-or-widening layer mostly keeps a
			// single parent, which is what produces long 1-in/1-out chains.
			let parentCount = 1;
			if (narrowing > 1) {
				parentCount = Math.max(1, Math.round(narrowing * (0.6 + rng() * 0.8)));
			} else if (rng() < 0.25) {
				parentCount = 2;
			}
			parentCount = Math.min(parentCount, 6, prevSize);

			for (let p = 0; p < parentCount; p++) {
				// Occasional skip connection to layer l-2. Still strictly forward,
				// so the graph stays acyclic by construction.
				const useSkip = l >= 2 && rng() < 0.12;
				const start = useSkip ? layerStart[l - 2] : prevStart;
				const size = useSkip ? sizes[l - 2] : prevSize;
				connect(start + Math.floor(rng() * size), v);
			}
		}
	}

	// Coverage: nothing before the last layer may be a dead end, and nothing
	// after the first layer may be an orphan. Both are possible after random
	// parent selection, and both would break the "source -> sink" reading.
	for (let v = 0; v < nodeCount; v++) {
		const l = layerOf[v];
		if (l < depth - 1 && childrenOf[v].length === 0) {
			connect(v, layerStart[l + 1] + Math.floor(rng() * sizes[l + 1]));
		}
		if (l > 0 && parentsOf[v].length === 0) {
			connect(layerStart[l - 1] + Math.floor(rng() * sizes[l - 1]), v);
		}
	}

	// --- Pass 2: kinds, ports, data types, edges.
	// Walks forward, which is topological order, so a node's parents always
	// already have their output ports when we get here.
	const nodes: PipelineNode[] = new Array(nodeCount);
	const edges: PipelineEdge[] = [];
	const outputPortsOf: Port[][] = new Array(nodeCount);
	const nextOutputPort = new Int32Array(nodeCount); // round-robin cursor per node

	for (let v = 0; v < nodeCount; v++) {
		const id = `n${v}`;
		const l = layerOf[v];
		const parents = parentsOf[v];

		const kind = kindFor(rng, l, depth, parents.length, childrenOf[v].length);

		// Resolve each incoming edge to a concrete source port, which fixes its
		// data type.
		const incoming = parents.map((parent) => {
			const ports = outputPortsOf[parent];
			const port = ports[nextOutputPort[parent]++ % ports.length];
			return { parent, port };
		});

		// One input port per distinct incoming data type. This is why the type
		// system is worth having: a node that receives records and errors really
		// does have two differently-typed inlets.
		const inputs: Port[] = [];
		const inputPortByType = new Map<DataType, Port>();
		if (kind !== 'source') {
			const presentTypes = DATA_TYPES.filter((t) => incoming.some((i) => i.port.dataType === t));
			const single = presentTypes.length === 1;
			for (const dataType of presentTypes) {
				const name = single ? 'in' : dataType;
				const port: Port = { id: `${id}:in:${name}`, name, direction: 'in', dataType };
				inputs.push(port);
				inputPortByType.set(dataType, port);
			}
			if (inputs.length === 0) {
				// Only reachable for a sink that lost all its parents; keep the shape valid.
				inputs.push({ id: `${id}:in:in`, name: 'in', direction: 'in', dataType: 'records' });
			}
		}

		const primaryInType = inputs[0]?.dataType ?? 'records';
		const outputs = outputPortsFor(rng, id, kind, primaryInType);
		outputPortsOf[v] = outputs;

		nodes[v] = {
			id,
			kind,
			label: labelFor(rng, kind, v),
			width: NODE_WIDTH,
			height: nodeHeightFor(inputs.length, outputs.length),
			inputs,
			outputs
		};

		for (const { parent, port } of incoming) {
			const targetPort = inputPortByType.get(port.dataType) ?? inputs[0];
			edges.push({
				id: `e${edges.length}`,
				source: nodes[parent].id,
				sourcePort: port.id,
				target: id,
				targetPort: targetPort.id,
				dataType: port.dataType
			});
		}
	}

	const initialDynamics = nodes.map((node) => initialDynamicsFor(rng, node.kind));

	return {
		graph: { nodes, edges },
		initialDynamics,
		layerSizes: sizes,
		generationMs: performance.now() - startedAt
	};
}

function kindFor(
	rng: Rng,
	layer: number,
	depth: number,
	inDegree: number,
	outDegree: number
): NodeKind {
	if (layer === 0) return 'source';
	if (layer === depth - 1 || outDegree === 0) return 'sink';
	// Fan-in suggests an aggregate, but most multi-input stages in a real
	// mediation pipeline are still joins/merges that pass records through.
	if (inDegree >= 2) return weightedIndex(rng, [0.35, 0.65]) === 0 ? 'aggregate' : 'transform';
	return weightedIndex(rng, [0.62, 0.38]) === 0 ? 'transform' : 'filter';
}

function outputPortsFor(rng: Rng, nodeId: string, kind: NodeKind, inType: DataType): Port[] {
	const out = (name: string, dataType: DataType): Port => ({
		id: `${nodeId}:out:${name}`,
		name,
		direction: 'out',
		dataType
	});

	switch (kind) {
		case 'source':
			return [out('out', pick(rng, ['records', 'events'] as const))];
		case 'sink':
			return [];
		case 'transform':
			return [out('out', inType)];
		// A filter is the one kind with two outlets, and the reject path is what
		// puts `errors`-typed edges into the graph.
		case 'filter':
			return [out('pass', inType), out('reject', 'errors')];
		// A rollup/count/sum emits metrics; a dedupe/window still emits whatever it
		// consumed. Without this split, `metrics` is absorbing — one aggregate
		// anywhere upstream turns every edge below it into metrics forever.
		case 'aggregate':
			return [out('out', rng() < 0.55 ? 'metrics' : inType)];
	}
}

function initialDynamicsFor(rng: Rng, kind: NodeKind): NodeDynamics {
	const status = NODE_STATUSES[weightedIndex(rng, [0.15, 0.7, 0.1, 0.05])];

	if (status === 'idle' || status === 'failed') return { status, throughput: 0 };

	// Log-uniform: throughput spans orders of magnitude, like real stage rates.
	const base = 40 * Math.exp(rng() * 4.2);
	const scale = kind === 'source' ? 1.6 : kind === 'aggregate' ? 0.35 : 1;
	const degraded = status === 'degraded' ? 0.25 : 1;
	return { status, throughput: Math.round(base * scale * degraded) };
}
