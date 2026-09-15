/**
 * Domain types for the pipeline graph.
 *
 * The single most important thing in this file is the split between
 * STRUCTURE and DYNAMICS:
 *
 *   - Structure  (PipelineNode, PipelineEdge, PipelineGraph, positions)
 *     Changes rarely — when the user adds/removes/moves a stage. It is large,
 *     and it is what layout, culling and hit-testing read. It will live in
 *     `$state.raw` so Svelte never deep-proxies a 10k-node object graph.
 *
 *   - Dynamics  (NodeDynamics: status + throughput)
 *     Changes ~200x/second from the streaming source. It is tiny per node and
 *     must never be reachable from a PipelineNode, because touching it would
 *     otherwise invalidate the structure snapshot and re-trigger layout and a
 *     full canvas redraw.
 *
 * That is why `status` and `throughput` are NOT fields on PipelineNode, even
 * though "a node has a status" is the obvious domain reading. Keeping them in a
 * parallel store is the whole exercise.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

// Plain aliases rather than branded types. Branding would catch "passed an
// EdgeId where a NodeId was wanted", but it leaks casts into every construction
// site and this code is meant to be read aloud. The index maps below are the
// real guard rail.
export type NodeId = string;
export type EdgeId = string;
export type PortId = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const NODE_KINDS = ['source', 'transform', 'filter', 'aggregate', 'sink'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATUSES = ['idle', 'running', 'degraded', 'failed'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Typed data flows. An edge carries exactly one of these. */
export const DATA_TYPES = ['records', 'events', 'metrics', 'errors'] as const;
export type DataType = (typeof DATA_TYPES)[number];

export type PortDirection = 'in' | 'out';

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export interface Port {
	readonly id: PortId;
	readonly name: string;
	readonly direction: PortDirection;
	readonly dataType: DataType;
}

export interface PipelineNode {
	readonly id: NodeId;
	readonly kind: NodeKind;
	readonly label: string;
	/** Logical size in graph units. Fixed per node: it depends only on port count. */
	readonly width: number;
	readonly height: number;
	readonly inputs: readonly Port[];
	readonly outputs: readonly Port[];
}

export interface PipelineEdge {
	readonly id: EdgeId;
	readonly source: NodeId;
	readonly sourcePort: PortId;
	readonly target: NodeId;
	readonly targetPort: PortId;
	/** Always equal to the dataType of both endpoint ports; validate.ts enforces it. */
	readonly dataType: DataType;
}

/**
 * An immutable structural snapshot. Every mutation produces a new PipelineGraph
 * object so it can be stored in `$state.raw` and compared by reference.
 */
export interface PipelineGraph {
	readonly nodes: readonly PipelineNode[];
	readonly edges: readonly PipelineEdge[];
}

// ---------------------------------------------------------------------------
// Dynamics
// ---------------------------------------------------------------------------

/** Per-node live telemetry. Owned by the streaming layer (phase 6), never by PipelineGraph. */
export interface NodeDynamics {
	status: NodeStatus;
	/** Records per second. */
	throughput: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers shared by layout and rendering
// ---------------------------------------------------------------------------

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
