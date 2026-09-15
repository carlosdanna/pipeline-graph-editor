<script lang="ts">
	import { portOffsetY } from '$lib/graph/generate';
	import type { GraphIndex } from '$lib/graph/indexing';
	import { graphBounds, type PositionStore } from '$lib/graph/positions';
	import type { NodeDynamics, PipelineGraph } from '$lib/graph/types';
	import { bezierPathData, edgeGeometry } from '$lib/render/edge-geometry';
	import {
		DATA_TYPE_COLOR,
		KIND_COLOR,
		PALETTE,
		STATUS_COLOR,
		formatThroughput,
		truncate
	} from '$lib/render/theme';

	/**
	 * Phase 1 renderer: one big SVG, every node and edge as a DOM element.
	 *
	 * This exists to make the data model visible, not to be fast. It is the
	 * baseline that phase 3's hybrid canvas/DOM renderer replaces, and it is
	 * capped at a few hundred nodes for good reason — see PAGE `SVG_NODE_CAP`.
	 */
	interface Props {
		graph: PipelineGraph;
		index: GraphIndex;
		positions: PositionStore;
		dynamics: readonly NodeDynamics[];
	}

	let { graph, index, positions, dynamics }: Props = $props();

	const PADDING = 80;

	const viewBox = $derived.by(() => {
		const b = graphBounds(graph, positions);
		return [
			b.x - PADDING,
			b.y - PADDING,
			Math.max(1, b.width + PADDING * 2),
			Math.max(1, b.height + PADDING * 2)
		].join(' ');
	});

	const edgePaths = $derived.by(() =>
		graph.edges.map((edge, i) => {
			const geometry = edgeGeometry(graph, index, positions, i);
			return {
				id: edge.id,
				d: geometry ? bezierPathData(geometry) : '',
				color: DATA_TYPE_COLOR[edge.dataType]
			};
		})
	);
</script>

<svg {viewBox} role="img" aria-label="Pipeline graph, static phase 1 render">
	<!-- Edges first so nodes paint over their endpoints. -->
	<g class="edges">
		{#each edgePaths as edge (edge.id)}
			<path d={edge.d} stroke={edge.color} />
		{/each}
	</g>

	<g class="nodes">
		{#each graph.nodes as node, i (node.id)}
			{@const status = dynamics[i].status}
			<g transform="translate({positions.x[i]},{positions.y[i]})">
				<rect
					width={node.width}
					height={node.height}
					rx="6"
					fill={PALETTE.surfaceRaised}
					stroke={STATUS_COLOR[status]}
					stroke-width={status === 'failed' || status === 'degraded' ? 1.6 : 1}
				/>
				<!-- Kind stripe down the left edge. -->
				<rect width="4" height={node.height} rx="2" fill={KIND_COLOR[node.kind]} />

				<text class="label" x="12" y="19">{truncate(node.label, 17)}</text>
				<text class="rate" x={node.width - 16} y="19">
					{formatThroughput(dynamics[i].throughput)}
				</text>
				<circle cx={node.width - 8} cy="15" r="3" fill={STATUS_COLOR[status]} />

				{#each node.inputs as port, slot (port.id)}
					{@const y = portOffsetY(slot, node.inputs.length, node.height)}
					<circle cx="0" cy={y} r="3.5" fill={DATA_TYPE_COLOR[port.dataType]} />
					<text class="port" x="9" y={y + 3}>{port.name}</text>
				{/each}

				{#each node.outputs as port, slot (port.id)}
					{@const y = portOffsetY(slot, node.outputs.length, node.height)}
					<circle cx={node.width} cy={y} r="3.5" fill={DATA_TYPE_COLOR[port.dataType]} />
					<text class="port end" x={node.width - 9} y={y + 3}>{port.name}</text>
				{/each}
			</g>
		{/each}
	</g>
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: 100%;
	}

	.edges path {
		fill: none;
		stroke-width: 1.4;
		stroke-opacity: 0.55;
	}

	text {
		font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace;
		pointer-events: none;
	}

	.label {
		font-size: 11px;
		fill: #c9d4e2;
	}

	.rate {
		font-size: 9.5px;
		fill: #7d8a9c;
		text-anchor: end;
	}

	.port {
		font-size: 8.5px;
		fill: #7d8a9c;
	}

	.port.end {
		text-anchor: end;
	}
</style>
