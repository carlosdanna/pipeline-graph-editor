<script lang="ts">
	import type { PerfMonitor } from '$lib/render/perf.svelte';
	import type { UpdateBatcher } from '$lib/stream/batcher.svelte';

	interface Props {
		perf: PerfMonitor;
		stream: UpdateBatcher;
	}

	let { perf, stream }: Props = $props();

	// Neither the frame loop nor the update feed runs when idle, so idleness
	// cannot be detected from inside either — it needs an outside heartbeat.
	$effect(() => {
		const timer = setInterval(() => {
			perf.poll();
			stream.poll();
		}, 250);
		return () => clearInterval(timer);
	});

	const culledNodes = $derived(perf.totalNodes - perf.visibleNodes);
	const culledEdges = $derived(perf.edgeCount - perf.visibleEdges);
	const feed = $derived(stream.monitor);

	/**
	 * Updates that arrived for a node nothing is showing. The point of the
	 * phase, in one number: these cost two typed-array writes and no frame.
	 */
	const offscreen = $derived(Math.max(0, feed.notified - feed.visibleChanges));
</script>

<aside class="hud" aria-live="off">
	<div class="row" data-hud="fps">
		<span class="key">fps</span>
		<span class="value" class:bad={perf.active && perf.fps < 55}>
			{perf.active ? perf.fps : '—'}
		</span>
	</div>
	<div class="row" data-hud="frame">
		<span class="key">frame</span>
		<span class="value" class:bad={perf.frameMs > 16.7}>{perf.frameMs.toFixed(1)} ms</span>
	</div>
	<div class="row" data-hud="worst">
		<span class="key">worst</span>
		<span class="value" class:bad={perf.frameMaxMs > 16.7}>{perf.frameMaxMs.toFixed(1)} ms</span>
	</div>
	<div class="row" data-hud="nodes">
		<span class="key">nodes</span>
		<span class="value">
			{perf.visibleNodes.toLocaleString()} / {perf.totalNodes.toLocaleString()}
		</span>
	</div>
	<div class="row" data-hud="edges">
		<span class="key">edges</span>
		<span class="value">
			{perf.visibleEdges.toLocaleString()} / {perf.edgeCount.toLocaleString()}
		</span>
	</div>
	<div class="row" data-hud="culled">
		<span class="key">culled</span>
		<!-- What phase 5 is buying, in one number. -->
		<span class="value" class:good={culledNodes + culledEdges > 0}>
			{(culledNodes + culledEdges).toLocaleString()}
		</span>
	</div>
	<div class="row" data-hud="zoom">
		<span class="key">zoom</span>
		<span class="value">{perf.zoom.toFixed(3)}x</span>
	</div>
	<div class="row" data-hud="detail">
		<span class="key">detail</span>
		<span class="value" class:stale={perf.detail !== 'full'}>{perf.detail}</span>
	</div>
	<div class="row" data-hud="nodes-via">
		<span class="key">nodes via</span>
		<span class="value">{perf.nodesOnCanvas ? 'canvas' : 'dom'}</span>
	</div>
	{#if feed.active}
		<div class="rule"></div>
		<div class="row" data-hud="updates">
			<span class="key">updates</span>
			<span class="value">{feed.updates.toLocaleString()}/s</span>
		</div>
		<div class="row" data-hud="coalesced">
			<span class="key">coalesced</span>
			<!-- Updates that hit a node already dirty this frame, and cost nothing. -->
			<span class="value" class:good={feed.coalesced > 0}>
				{feed.coalesced.toLocaleString()}/s
			</span>
		</div>
		<div class="row" data-hud="notified">
			<span class="key">notified</span>
			<span class="value">{feed.notified.toLocaleString()}/s</span>
		</div>
		<div class="row" data-hud="flushes">
			<span class="key">flushes</span>
			<span class="value">{feed.flushes.toLocaleString()}/s</span>
		</div>
		<div class="row" data-hud="on-screen">
			<span class="key">on screen</span>
			<!-- Flushes where a *visible* node changed. Everything else drew nothing. -->
			<span class="value">{feed.visibleChanges.toLocaleString()}/s</span>
		</div>
		<div class="row" data-hud="repaints">
			<span class="key">repaints</span>
			<!-- Canvas frames the feed caused. Zero while nodes are DOM elements. -->
			<span class="value" class:good={feed.repaints === 0}>
				{feed.repaints.toLocaleString()}/s
			</span>
		</div>
		<div class="row" data-hud="unseen">
			<span class="key">unseen</span>
			<span class="value" class:good={offscreen > 0}>{offscreen.toLocaleString()}/s</span>
		</div>
	{/if}

	<div class="row" data-hud="layout">
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

	.rule {
		height: 1px;
		margin: 3px 0;
		background: var(--border);
	}
</style>
