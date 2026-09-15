import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { LayoutRequestMessage } from './protocol';

/**
 * Translation between our flat typed-array protocol and ELK's object graph.
 *
 * Kept out of the worker so it can be exercised directly — the worker itself is
 * then only messaging, which is the part that does not need testing.
 *
 * Node index -> ELK id is just the index stringified. All of that string
 * allocation happens here, inside the worker, never on the main thread.
 */

export interface ElkLayoutGraph {
	readonly id: string;
	readonly layoutOptions: Record<string, string>;
	readonly children: ElkNode[];
	readonly edges: ElkExtendedEdge[];
}

export function toElkGraph(request: LayoutRequestMessage): ElkLayoutGraph {
	const count = request.nodeId.length;
	const seeded = request.seedX.length === count;

	const children: ElkNode[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const node: ElkNode = {
			id: String(request.nodeId[i]),
			width: request.width[i],
			height: request.height[i]
		};
		if (seeded) {
			node.x = request.seedX[i];
			node.y = request.seedY[i];
		}
		children[i] = node;
	}

	const edges: ElkExtendedEdge[] = new Array(request.edgeSource.length);
	for (let e = 0; e < request.edgeSource.length; e++) {
		edges[e] = {
			id: `e${e}`,
			sources: [String(request.edgeSource[e])],
			targets: [String(request.edgeTarget[e])]
		};
	}

	return { id: 'root', layoutOptions: { ...request.options }, children, edges };
}

export interface ElkPositions {
	readonly nodeId: Int32Array;
	readonly x: Float64Array;
	readonly y: Float64Array;
}

/** ELK may reorder children, so results are read back with their ids attached. */
export function fromElkGraph(laidOut: ElkNode): ElkPositions {
	const children = laidOut.children ?? [];
	const nodeId = new Int32Array(children.length);
	const x = new Float64Array(children.length);
	const y = new Float64Array(children.length);

	for (let i = 0; i < children.length; i++) {
		nodeId[i] = Number(children[i].id);
		x[i] = children[i].x ?? 0;
		y[i] = children[i].y ?? 0;
	}

	return { nodeId, x, y };
}
