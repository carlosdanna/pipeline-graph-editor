<script lang="ts">
	import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
	import type { PipelineNode } from '$lib/graph/types';
	import { KIND_COLOR, STATUS_COLOR, formatThroughput } from '$lib/render/theme';
	import { ROW_HEIGHT } from '$lib/render/virtual';

	/**
	 * One table row.
	 *
	 * A component per row for the same reason as `GraphNode`: `dynamics.view()`
	 * subscribes this row and only this row, so a streaming update repaints one
	 * row out of the forty on screen. The table is a second consumer of the
	 * phase 6 cells and needed no new machinery at all — a node that is on
	 * screen in the table gets a cell exactly the way one on the canvas does.
	 *
	 * Absolutely positioned inside the spacer. The row never learns that it is
	 * virtualized; it is told where to sit.
	 */
	interface Props {
		index: number;
		node: PipelineNode;
		/** Offset inside the full-height spacer, in pixels. */
		top: number;
		selected: boolean;
		primary: boolean;
		dynamics: DynamicsStore;
		onselect: (index: number, additive: boolean) => void;
	}

	let { index, node, top, selected, primary, dynamics, onselect }: Props = $props();

	const live = $derived(dynamics.view(index));
</script>

<div
	class="row"
	class:selected
	class:primary
	style:top="{top}px"
	style:height="{ROW_HEIGHT}px"
	role="row"
	aria-rowindex={index + 2}
	aria-selected={selected}
	tabindex="-1"
	onclick={(e) => onselect(index, e.shiftKey)}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onselect(index, e.shiftKey);
		}
	}}
>
	<span class="cell index" role="gridcell">{index}</span>
	<span class="cell label" role="gridcell" title={node.label}>{node.label}</span>
	<span class="cell kind" role="gridcell" style:color={KIND_COLOR[node.kind]}>{node.kind}</span>
	<span class="cell status" role="gridcell">
		<i class="dot" style:background={STATUS_COLOR[live.status]}></i>{live.status}
	</span>
	<span class="cell rate" role="gridcell">{formatThroughput(live.throughput)}</span>
</div>

<style>
	.row {
		position: absolute;
		left: 0;
		right: 0;
		display: grid;
		grid-template-columns: 56px 1fr 88px 96px 92px;
		align-items: center;
		gap: 12px;
		/*
		 * Height comes from ROW_HEIGHT as an inline style, not from here. The
		 * windowing arithmetic and the rendered row must agree exactly — a
		 * one-pixel disagreement accumulates into rows overlapping by a whole row
		 * a few thousand down the list — so there is one definition and the CSS
		 * is not allowed a second opinion.
		 */
		padding: 0 16px;
		box-sizing: border-box;
		font-size: 11px;
		color: var(--text);
		border-bottom: 1px solid rgb(42 52 66 / 0.4);
		cursor: default;
		user-select: none;
	}

	.row:hover {
		background: rgb(79 179 255 / 0.06);
	}

	.row.selected {
		background: rgb(79 179 255 / 0.13);
	}

	.row.primary {
		box-shadow: inset 2px 0 0 #4fb3ff;
	}

	.cell {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.index,
	.rate {
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--text-muted);
	}

	.rate {
		color: var(--text);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-muted);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex: none;
	}
</style>
