<script lang="ts">
	import type { GraphIndex } from '$lib/graph/indexing';
	import type { PositionStore } from '$lib/graph/positions';
	import type { NodeDynamics, PipelineGraph } from '$lib/graph/types';
	import { buildEdgeBuckets } from '$lib/render/edge-buckets';
	import type { HybridRenderer } from '$lib/render/hybrid-renderer';
	import { DOM_NODE_LIMIT } from '$lib/render/limits';
	import { KIND_COLOR, STATUS_COLOR, formatThroughput, truncate } from '$lib/render/theme';

	/**
	 * The hybrid renderer's markup: a canvas for grid and edges, and a
	 * CSS-transformed layer of DOM nodes above it.
	 *
	 * Both are moved by one transform, applied once per frame by HybridRenderer.
	 * Nothing in this component repositions anything individually — the node
	 * elements carry their graph-space offset and never learn about zoom.
	 */
	interface Props {
		graph: PipelineGraph;
		index: GraphIndex;
		positions: PositionStore;
		dynamics: readonly NodeDynamics[];
		/** Bumped when positions are written in place; see session.svelte.ts. */
		geometryVersion: number;
		renderer: HybridRenderer;
	}

	let { graph, index, positions, dynamics, geometryVersion, renderer }: Props = $props();

	const buckets = $derived(buildEdgeBuckets(graph));
	const nodesAreDom = $derived(graph.nodes.length <= DOM_NODE_LIMIT);

	// Pushing reactive state into an imperative renderer is what $effect is for.
	// The renderer decides when to draw; this only tells it what to draw.
	$effect(() => {
		void geometryVersion;
		renderer.setScene({ graph, index, positions, buckets });
	});

	// Rebuilt whenever positions move, which during a layout tween is every
	// frame. At 2,000 nodes that is 2,000 strings per frame — the honest cost of
	// keeping nodes in the DOM, and the reason for DOM_NODE_LIMIT.
	const nodeOffsets = $derived.by(() => {
		void geometryVersion;
		if (!nodesAreDom) return [];
		return graph.nodes.map((_, i) => `${positions.x[i]}px ${positions.y[i]}px`);
	});
</script>

<div class="surface" {@attach renderer.attachSurface}>
	<canvas {@attach renderer.attachCanvas}></canvas>

	{#if nodesAreDom}
		<div class="node-layer" {@attach renderer.attachLayer}>
			{#each graph.nodes as node, i (node.id)}
				<div
					class="node"
					style:translate={nodeOffsets[i]}
					style:width="{node.width}px"
					style:height="{node.height}px"
					style:--kind={KIND_COLOR[node.kind]}
					style:--status={STATUS_COLOR[dynamics[i].status]}
				>
					<span class="label">{truncate(node.label, 17)}</span>
					<span class="rate">{formatThroughput(dynamics[i].throughput)}</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="overflow">
			{graph.nodes.length.toLocaleString()} nodes exceeds the {DOM_NODE_LIMIT.toLocaleString()} DOM
			limit — edges and the grid are still drawn, and pan and zoom still work. Phase 5 draws nodes
			on the canvas above this threshold.
		</p>
	{/if}
</div>

<style>
	.surface {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		/* Pointer events must not be stolen by scroll/pinch gestures. */
		touch-action: none;
		cursor: grab;
	}

	.surface:active {
		cursor: grabbing;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	.node-layer {
		position: absolute;
		top: 0;
		left: 0;
		transform-origin: 0 0;
		/*
		 * All interaction goes through the surface and, from phase 4, the
		 * quadtree — never through a node's own event target. That keeps the
		 * interaction model identical whether nodes are DOM elements or pixels.
		 */
		pointer-events: none;
		will-change: transform;
	}

	.node {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 8px 0 10px;
		overflow: hidden;
		background: var(--surface-raised);
		border: 1px solid var(--status);
		border-left: 3px solid var(--kind);
		border-radius: 6px;
		box-sizing: border-box;
	}

	.label {
		flex: 1;
		font-size: 11px;
		color: var(--text);
		white-space: nowrap;
	}

	.rate {
		font-size: 9.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.overflow {
		position: absolute;
		top: 50%;
		left: 50%;
		max-width: 46ch;
		margin: 0;
		transform: translate(-50%, -50%);
		padding: 12px 16px;
		font-size: 11.5px;
		line-height: 1.6;
		color: var(--text-muted);
		background: rgb(14 18 24 / 0.85);
		border: 1px solid var(--border);
		border-radius: 6px;
		pointer-events: none;
	}
</style>
