/**
 * Main thread <-> layout worker message protocol.
 *
 * Everything that scales with graph size travels as a typed array, not as
 * objects. At the 10k fixture the alternative is structured-cloning ~25,000
 * little `{id, width, height}` and `{id, sources, targets}` objects across the
 * boundary twice per layout; here it is eight ArrayBuffers, and they are
 * *transferred* rather than copied, so the cost is a pointer handoff.
 *
 * Nodes are identified by their index in `PipelineGraph.nodes`, never by id.
 * ELK wants string ids, so the worker stringifies the index on the way in and
 * parses it back on the way out — which keeps every string allocation inside
 * the worker, off the main thread.
 */

export type LayoutOptions = Readonly<Record<string, string>>;

export interface LayoutRequestMessage {
	readonly type: 'layout';
	readonly requestId: number;
	/** Node indices taking part in this layout. */
	readonly nodeId: Int32Array;
	readonly width: Float64Array;
	readonly height: Float64Array;
	/**
	 * Seed coordinates, parallel to `nodeId`. Empty for a full layout; for an
	 * incremental one these are the current positions, which ELK's INTERACTIVE
	 * strategies use as ordering hints.
	 */
	readonly seedX: Float64Array;
	readonly seedY: Float64Array;
	/** Edge endpoints, as node indices (not offsets into `nodeId`). */
	readonly edgeSource: Int32Array;
	readonly edgeTarget: Int32Array;
	readonly options: LayoutOptions;
}

export interface LayoutResultMessage {
	readonly type: 'layout-result';
	readonly requestId: number;
	readonly nodeId: Int32Array;
	readonly x: Float64Array;
	readonly y: Float64Array;
	/** Time inside `elk.layout()`, excluding message overhead. */
	readonly elkMs: number;
}

export interface LayoutErrorMessage {
	readonly type: 'layout-error';
	readonly requestId: number;
	readonly message: string;
	/**
	 * elkjs recurses deeply enough to exhaust the stack on large graphs, and it
	 * does so *intermittently* once the instance is warm. The client retries
	 * these on a fresh worker; other errors are reported as-is.
	 */
	readonly stackOverflow: boolean;
}

export type WorkerOutbound = LayoutResultMessage | LayoutErrorMessage;

/** Buffers to hand over when posting a request. */
export function requestTransfers(message: LayoutRequestMessage): Transferable[] {
	return [
		message.nodeId.buffer,
		message.width.buffer,
		message.height.buffer,
		message.seedX.buffer,
		message.seedY.buffer,
		message.edgeSource.buffer,
		message.edgeTarget.buffer
	] as Transferable[];
}

/** Buffers to hand back when posting a result. */
export function resultTransfers(message: LayoutResultMessage): Transferable[] {
	return [message.nodeId.buffer, message.x.buffer, message.y.buffer] as Transferable[];
}
