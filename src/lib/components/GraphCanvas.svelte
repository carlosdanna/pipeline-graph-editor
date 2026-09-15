<script lang="ts">
	import GraphNode from './GraphNode.svelte';
	import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
	import type { PositionStore } from '$lib/graph/positions';
	import type { PipelineGraph } from '$lib/graph/types';
	import type { SelectionStore } from '$lib/interact/selection.svelte';
	import type { EdgeAnchors } from '$lib/render/edge-anchors';
	import type { EdgeBuckets } from '$lib/render/edge-buckets';
	import type { HybridRenderer } from '$lib/render/hybrid-renderer';
	import type { VisibleNodes } from '$lib/render/visible.svelte';

	/**
	 * The hybrid renderer's markup: a canvas for grid, edges, ports and
	 * selection, and a CSS-transformed layer of DOM nodes above it.
	 *
	 * Both are moved by one transform, applied once per frame by HybridRenderer.
	 * Nothing in this component repositions anything individually — the node
	 * elements carry their graph-space offset and never learn about zoom.
	 *
	 * Since phase 5 the DOM layer renders only the nodes the renderer culled to,
	 * and only while the renderer says the DOM owns nodes at all. Above the node
	 * limit, or below the full detail tier, this layer renders nothing and the
	 * canvas draws the bodies instead. Every gesture keeps working either way,
	 * because nothing has ever gone through a node element.
	 */
	interface Props {
		graph: PipelineGraph;
		positions: PositionStore;
		/**
		 * Status and throughput. Deliberately *not* read in this component —
		 * each `GraphNode` subscribes to its own node, so a streaming update
		 * repaints one element rather than invalidating this list.
		 */
		dynamics: DynamicsStore;
		/**
		 * Structural render caches, built by the session when the graph changes.
		 * Passed in rather than derived here so the renderer and the hit-tester
		 * read the same arrays.
		 */
		anchors: EdgeAnchors;
		buckets: EdgeBuckets;
		/**
		 * Selection is passed through to the canvas, not used in this template.
		 * Nothing here binds a `.selected` class: selection is drawn on the
		 * canvas precisely so a marquee over 2,000 nodes costs no DOM work.
		 */
		selection: SelectionStore;
		/** Which nodes are on screen, published by the frame loop. */
		visible: VisibleNodes;
		/** Bumped when positions are written in place; see session.svelte.ts. */
		geometryVersion: number;
		renderer: HybridRenderer;
	}

	let {
		graph,
		positions,
		dynamics,
		anchors,
		buckets,
		selection,
		visible,
		geometryVersion,
		renderer
	}: Props = $props();

	// Pushing reactive state into an imperative renderer is what $effect is for.
	// The renderer decides when to draw; this only tells it what to draw.
	$effect(() => {
		void geometryVersion;
		renderer.setScene({ graph, dynamics, positions, buckets, anchors, selection });
	});

	/**
	 * The DOM nodes to render, rebuilt whenever positions move or the visible
	 * set changes.
	 *
	 * In phase 3 this built a string for every node in the graph on every
	 * animation frame — 2,000 template literals per frame at the DOM limit, and
	 * the honest reason the limit existed. Culling reduces it to what is on
	 * screen, which is a few dozen, so the same code is now roughly free.
	 *
	 * Note what is *not* in here: status and throughput. Those change 200 times
	 * a second, and including them would mean this whole list rebuilt 200 times
	 * a second. Each `GraphNode` reads its own.
	 */
	const domNodes = $derived.by(() => {
		void geometryVersion;
		if (!visible.domNodes) return [];
		return visible.indices.map((i) => ({
			index: i,
			node: graph.nodes[i],
			x: positions.x[i],
			y: positions.y[i]
		}));
	});
</script>

<div class="surface" {@attach renderer.attachSurface}>
	<canvas {@attach renderer.attachCanvas}></canvas>

	<div class="node-layer" {@attach renderer.attachLayer}>
		{#each domNodes as entry (entry.node.id)}
			<GraphNode
				index={entry.index}
				node={entry.node}
				x={entry.x}
				y={entry.y}
				{dynamics}
			/>
		{/each}
	</div>
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
		 * All interaction goes through the surface and the quadtree — never
		 * through a node's own event target. That keeps the interaction model
		 * identical whether nodes are DOM elements or pixels, which is what lets
		 * the renderer switch between them at runtime with no change to picking.
		 */
		pointer-events: none;
		will-change: transform;
	}

</style>
