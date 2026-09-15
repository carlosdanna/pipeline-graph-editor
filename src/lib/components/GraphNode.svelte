<script lang="ts">
	import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
	import type { PipelineNode } from '$lib/graph/types';
	import { KIND_COLOR, STATUS_COLOR, formatThroughput, truncate } from '$lib/render/theme';

	/**
	 * One node, as a DOM element.
	 *
	 * This exists as its own component for exactly one reason: it is the unit of
	 * repaint. `dynamics.view(index)` subscribes this component — and only this
	 * component — to this node's cell, so a status change from the streaming
	 * feed re-renders one element and touches nothing else on the page.
	 *
	 * Doing the same work inline in the parent's `{#each}` would put every
	 * node's status read inside one reactive scope, and a single update would
	 * invalidate the whole list. The component boundary *is* the granularity.
	 *
	 * Position comes in as props rather than being read here, because position
	 * genuinely does change for every node at once during a layout tween — there
	 * is nothing to gain from making it per-node, and a prop keeps the parent's
	 * single geometry version as the one trigger for that.
	 */
	interface Props {
		index: number;
		node: PipelineNode;
		x: number;
		y: number;
		dynamics: DynamicsStore;
	}

	let { index, node, x, y, dynamics }: Props = $props();

	const live = $derived(dynamics.view(index));
</script>

<div
	class="node"
	style:translate="{x}px {y}px"
	style:width="{node.width}px"
	style:height="{node.height}px"
	style:--kind={KIND_COLOR[node.kind]}
	style:--status={STATUS_COLOR[live.status]}
>
	<span class="label">{truncate(node.label, 17)}</span>
	<span class="rate">{formatThroughput(live.throughput)}</span>
</div>

<style>
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
		font-variant-numeric: tabular-nums;
	}
</style>
