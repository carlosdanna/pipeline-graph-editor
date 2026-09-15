<script lang="ts">
	import type { PerfMonitor } from '$lib/render/perf.svelte';

	interface Props {
		perf: PerfMonitor;
	}

	let { perf }: Props = $props();

	// Nothing draws when nothing moves, so idleness cannot be detected from
	// inside the frame loop — it needs an outside heartbeat.
	$effect(() => {
		const timer = setInterval(() => perf.poll(), 250);
		return () => clearInterval(timer);
	});

	const culledNodes = $derived(perf.totalNodes - perf.visibleNodes);
	const culledEdges = $derived(perf.edgeCount - perf.visibleEdges);
</script>

<aside class="hud" aria-live="off">
	<div class="row">
		<span class="key">fps</span>
		<span class="value" class:bad={perf.active && perf.fps < 55}>
			{perf.active ? perf.fps : '—'}
		</span>
	</div>
	<div class="row">
		<span class="key">frame</span>
		<span class="value" class:bad={perf.frameMs > 16.7}>{perf.frameMs.toFixed(1)} ms</span>
	</div>
	<div class="row">
		<span class="key">worst</span>
		<span class="value" class:bad={perf.frameMaxMs > 16.7}>{perf.frameMaxMs.toFixed(1)} ms</span>
	</div>
	<div class="row">
		<span class="key">nodes</span>
		<span class="value">
			{perf.visibleNodes.toLocaleString()} / {perf.totalNodes.toLocaleString()}
		</span>
	</div>
	<div class="row">
		<span class="key">edges</span>
		<span class="value">
			{perf.visibleEdges.toLocaleString()} / {perf.edgeCount.toLocaleString()}
		</span>
	</div>
	<div class="row">
		<span class="key">culled</span>
		<!-- What phase 5 is buying, in one number. -->
		<span class="value" class:good={culledNodes + culledEdges > 0}>
			{(culledNodes + culledEdges).toLocaleString()}
		</span>
	</div>
	<div class="row">
		<span class="key">zoom</span>
		<span class="value">{perf.zoom.toFixed(3)}x</span>
	</div>
	<div class="row">
		<span class="key">detail</span>
		<span class="value" class:stale={perf.detail !== 'full'}>{perf.detail}</span>
	</div>
	<div class="row">
		<span class="key">nodes via</span>
		<span class="value">{perf.nodesOnCanvas ? 'canvas' : 'dom'}</span>
	</div>
	<div class="row">
		<span class="key">layout</span>
		<span class="value">
			{perf.layoutMs === null
				? '—'
				: perf.layoutMs >= 1000
					? `${(perf.layoutMs / 1000).toFixed(2)} s`
					: `${perf.layoutMs.toFixed(0)} ms`}
		</span>
	</div>
</aside>

<style>
	.hud {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 2;
		display: grid;
		gap: 1px;
		padding: 8px 10px;
		font-size: 10.5px;
		line-height: 1.5;
		color: var(--text-muted);
		background: rgb(14 18 24 / 0.82);
		border: 1px solid var(--border);
		border-radius: 5px;
		backdrop-filter: blur(4px);
		pointer-events: none;
		user-select: none;
	}

	.row {
		display: grid;
		grid-template-columns: 62px auto;
		gap: 10px;
	}

	.value {
		color: var(--text);
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.value.bad {
		color: #fbbf24;
	}

	.value.stale {
		color: #7d8a9c;
	}

	.value.good {
		color: #34d399;
	}
</style>
