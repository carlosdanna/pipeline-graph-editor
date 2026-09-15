<script lang="ts">
	import { onMount } from 'svelte';
	import GraphCanvas from '$lib/components/GraphCanvas.svelte';
	import PerfHud from '$lib/components/PerfHud.svelte';
	import { FIXTURE_SIZES, type FixtureSize } from '$lib/graph/generate';
	import { GraphSession } from '$lib/state/session.svelte';

	const session = new GraphSession();

	onMount(() => {
		// The constructor leaves the naive placeholder layout on screen; the real
		// ELK run starts here so the first paint is not blocked on a worker.
		void session.runFullLayout();
		return () => session.dispose();
	});

	const state = $derived(session.fixture);
	const stats = $derived(state.validation.stats);

	function ms(value: number): string {
		return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
	}
</script>

<div class="app">
	<header>
		<h1>Pipeline graph editor <span class="phase">phase 5 — culling and semantic zoom</span></h1>

		<span class="status" data-phase={session.layoutPhase}>
			{#if session.layoutPhase === 'running'}
				laying out…
			{:else if session.layoutPhase === 'placeholder'}
				placeholder layout
			{:else if session.layoutPhase === 'error'}
				layout failed
			{:else}
				elk layout applied
			{/if}
		</span>

		<nav aria-label="Fixture size">
			{#each FIXTURE_SIZES as size (size)}
				<button
					type="button"
					class:active={state.size === size}
					aria-pressed={state.size === size}
					disabled={session.benchmarkRunning}
					onclick={() => session.loadFixture(size as FixtureSize)}
				>
					{size.toLocaleString()}
				</button>
			{/each}
		</nav>

		<button type="button" disabled={session.busy} onclick={() => session.addStage()}>
			+ add stage
		</button>
		<button type="button" disabled={session.busy} onclick={() => session.runBenchmark()}>
			benchmark all
		</button>
		<button
			type="button"
			disabled={session.selection.nodeCount === 0}
			onclick={() => session.fitSelection()}
		>
			fit selection
		</button>

		<span class="badge" class:ok={state.validation.ok} class:bad={!state.validation.ok}>
			{state.validation.ok ? 'valid DAG' : `${state.validation.errors.length} errors`}
		</span>
	</header>

	<dl class="stats">
		<div><dt>nodes</dt><dd>{stats.nodeCount.toLocaleString()}</dd></div>
		<div><dt>edges</dt><dd>{stats.edgeCount.toLocaleString()}</dd></div>
		<div><dt>layers</dt><dd>{stats.layerCount}</dd></div>
		<div><dt>generate</dt><dd>{ms(state.generationMs)}</dd></div>
		<div><dt>placeholder</dt><dd>{ms(state.placeholderMs)}</dd></div>
		<div><dt>quadtree</dt><dd>{session.treeBuildMs === null ? '—' : ms(session.treeBuildMs)}</dd></div>
		<div class="sep">
			<dt>selected</dt>
			<dd>
				{session.selection.nodeCount.toLocaleString()} nodes,
				{session.selection.edgeCount.toLocaleString()} edges
			</dd>
		</div>
		{#if session.lastRun}
			{@const run = session.lastRun}
			<div class="sep"><dt>last layout</dt><dd>{run.mode}</dd></div>
			<div><dt>laid out</dt><dd>{run.nodesLaidOut.toLocaleString()} nodes</dd></div>
			<div><dt>elk</dt><dd>{ms(run.elkMs)}</dd></div>
			<div><dt>round trip</dt><dd>{ms(run.totalMs)}</dd></div>
			{#if run.retried}
				<div><dt>retried</dt><dd class="warn">stack overflow</dd></div>
			{/if}
		{/if}
	</dl>

	{#if session.layoutError}
		<p class="errors">layout error: {session.layoutError}</p>
	{/if}

	{#if session.benchmark.length > 0 || session.benchmarkRunning}
		<table class="bench">
			<caption>full ELK layout, worker round trip</caption>
			<thead>
				<tr><th>fixture</th><th>nodes</th><th>edges</th><th>elk</th><th>round trip</th></tr>
			</thead>
			<tbody>
				{#each session.benchmark as row (row.size)}
					<tr>
						<td>{row.size.toLocaleString()}</td>
						<td>{row.nodes.toLocaleString()}</td>
						<td>{row.edges.toLocaleString()}</td>
						<td>{row.elkMs === null ? '—' : ms(row.elkMs)}</td>
						<td>
							{row.totalMs === null ? row.error : ms(row.totalMs)}
							{#if row.retried}<span class="warn"> (retried)</span>{/if}
						</td>
					</tr>
				{/each}
				{#if session.benchmarkRunning}
					<tr><td colspan="5" class="muted">running…</td></tr>
				{/if}
			</tbody>
		</table>
	{/if}

	<p class="hint">
		drag to pan · wheel to zoom · click a node or edge to select · shift-click to toggle ·
		shift-drag empty space to marquee · drag a node to move it

		<span class="toggles">
			<!--
				These two exist so the phase 5 before/after can be read straight off
				the HUD. Turning culling off restores the phase 4 draw loop exactly.
			-->
			<label>
				<input
					type="checkbox"
					checked={session.cullingEnabled}
					onchange={(e) => session.setCulling(e.currentTarget.checked)}
				/>
				cull
			</label>
			<label>
				<input
					type="checkbox"
					checked={session.semanticZoomEnabled}
					onchange={(e) => session.setSemanticZoom(e.currentTarget.checked)}
				/>
				semantic zoom
			</label>
		</span>
	</p>

	<main>
		<GraphCanvas
			graph={state.graph}
			positions={state.positions}
			dynamics={state.dynamics}
			anchors={state.anchors}
			buckets={state.buckets}
			selection={session.selection}
			visible={session.visibleNodes}
			geometryVersion={session.positionsVersion}
			renderer={session.renderer}
		/>
		<PerfHud perf={session.perf} />
	</main>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		min-height: 0;
	}

	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	h1 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
	}

	.phase {
		margin-left: 8px;
		font-weight: 400;
		color: var(--text-muted);
	}

	.status {
		padding: 3px 8px;
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.status[data-phase='running'] {
		color: #4fb3ff;
		border-color: #4fb3ff;
	}

	.status[data-phase='error'] {
		color: #f87171;
		border-color: #f87171;
	}

	nav {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}

	button {
		padding: 4px 10px;
		font: inherit;
		font-size: 11px;
		color: var(--text-muted);
		background: var(--surface-raised);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		color: var(--text);
	}

	button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	button.active {
		color: #0e1218;
		background: #4fb3ff;
		border-color: #4fb3ff;
	}

	.badge {
		padding: 3px 8px;
		font-size: 11px;
		border-radius: 4px;
	}

	.badge.ok {
		color: #34d399;
		background: rgb(52 211 153 / 0.12);
	}

	.badge.bad {
		color: #f87171;
		background: rgb(248 113 113 / 0.14);
	}

	.stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0 24px;
		margin: 0;
		padding: 8px 16px;
		font-size: 11px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.stats div {
		display: flex;
		gap: 6px;
	}

	.stats .sep {
		padding-left: 24px;
		border-left: 1px solid var(--border);
	}

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.warn {
		color: #fbbf24;
	}

	.hint {
		display: flex;
		align-items: center;
		gap: 16px;
		margin: 0;
		padding: 6px 16px;
		font-size: 10.5px;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.toggles {
		display: flex;
		gap: 12px;
		margin-left: auto;
	}

	.toggles label {
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}

	.toggles input {
		margin: 0;
		accent-color: #4fb3ff;
	}

	.errors {
		margin: 0;
		padding: 8px 16px;
		font-size: 11px;
		color: #f87171;
		background: rgb(248 113 113 / 0.08);
		border-bottom: 1px solid var(--border);
	}

	.bench {
		font-size: 11px;
		border-collapse: collapse;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		width: 100%;
	}

	.bench caption {
		padding: 6px 16px 2px;
		font-size: 10.5px;
		color: var(--text-muted);
		text-align: left;
	}

	.bench th,
	.bench td {
		padding: 3px 16px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.bench th:first-child,
	.bench td:first-child {
		text-align: left;
	}

	.bench th {
		font-weight: 400;
		color: var(--text-muted);
	}

	.muted {
		color: var(--text-muted);
	}

	main {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
</style>
