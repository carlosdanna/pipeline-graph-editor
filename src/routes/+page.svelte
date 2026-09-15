<script lang="ts">
	import GraphSvg from '$lib/components/GraphSvg.svelte';
	import {
		FIXTURE_SIZES,
		generateFixture,
		type FixtureSize,
		type GeneratedFixture
	} from '$lib/graph/generate';
	import { buildGraphIndex, type GraphIndex } from '$lib/graph/indexing';
	import { validateGraph, type ValidationResult } from '$lib/graph/validate';
	import { layoutLayered, type StaticLayout } from '$lib/layout/layered';

	/**
	 * Above this many nodes we refuse to render SVG at all.
	 *
	 * This is not a safety valve, it is the exhibit: one DOM element per node and
	 * per edge stops being viable somewhere in the low hundreds, which is the
	 * entire reason phases 3 and 5 exist. Raising it is an instructive way to
	 * waste thirty seconds of your life.
	 */
	const SVG_NODE_CAP = 600;

	const INITIAL_FIXTURE_SIZE: FixtureSize = 50;

	interface Snapshot {
		readonly fixture: GeneratedFixture;
		readonly index: GraphIndex;
		readonly layout: StaticLayout;
		readonly validation: ValidationResult;
	}

	function buildSnapshot(nodeCount: FixtureSize): Snapshot {
		const fixture = generateFixture(nodeCount);
		const index = buildGraphIndex(fixture.graph);
		return {
			fixture,
			index,
			layout: layoutLayered(fixture.graph, index),
			validation: validateGraph(fixture.graph, index)
		};
	}

	let fixtureSize = $state<FixtureSize>(INITIAL_FIXTURE_SIZE);

	/**
	 * `$state.raw`, not `$state`.
	 *
	 * The snapshot holds ~10k nodes, ~13k edges and two Float32Arrays. Plain
	 * `$state` would wrap every one of those objects in a Proxy on first read,
	 * which costs both memory and a property-access penalty on every single
	 * render loop iteration from phase 3 onward. Structure is replaced wholesale,
	 * never mutated in place, so reference equality is all the reactivity we need.
	 */
	let snapshot = $state.raw<Snapshot>(buildSnapshot(INITIAL_FIXTURE_SIZE));

	function selectFixture(nodeCount: FixtureSize): void {
		fixtureSize = nodeCount;
		snapshot = buildSnapshot(nodeCount);
	}

	const stats = $derived(snapshot.validation.stats);
	const renderable = $derived(stats.nodeCount <= SVG_NODE_CAP);

	function ms(value: number): string {
		return `${value.toFixed(1)} ms`;
	}
</script>

<div class="app">
	<header>
		<h1>Pipeline graph editor <span class="phase">phase 1 — data model</span></h1>

		<nav aria-label="Fixture size">
			{#each FIXTURE_SIZES as size (size)}
				<button
					type="button"
					class:active={fixtureSize === size}
					aria-pressed={fixtureSize === size}
					onclick={() => selectFixture(size)}
				>
					{size.toLocaleString()}
				</button>
			{/each}
		</nav>

		<span class="badge" class:ok={snapshot.validation.ok} class:bad={!snapshot.validation.ok}>
			{snapshot.validation.ok ? 'valid DAG' : `${snapshot.validation.errors.length} errors`}
		</span>
	</header>

	<dl class="stats">
		<div><dt>nodes</dt><dd>{stats.nodeCount.toLocaleString()}</dd></div>
		<div><dt>edges</dt><dd>{stats.edgeCount.toLocaleString()}</dd></div>
		<div><dt>layers</dt><dd>{stats.layerCount}</dd></div>
		<div><dt>sources</dt><dd>{stats.sourceCount}</dd></div>
		<div><dt>sinks</dt><dd>{stats.sinkCount}</dd></div>
		<div><dt>max in</dt><dd>{stats.maxInDegree}</dd></div>
		<div><dt>max out</dt><dd>{stats.maxOutDegree}</dd></div>
		<div><dt>longest path</dt><dd>{stats.longestPath}</dd></div>
		<div><dt>generate</dt><dd>{ms(snapshot.fixture.generationMs)}</dd></div>
		<div><dt>index + layout</dt><dd>{ms(snapshot.layout.durationMs)}</dd></div>
		<div><dt>validate</dt><dd>{ms(stats.validationMs)}</dd></div>
	</dl>

	{#if !snapshot.validation.ok}
		<ul class="errors">
			{#each snapshot.validation.errors as error (error)}
				<li>{error}</li>
			{/each}
		</ul>
	{/if}

	<main>
		{#if renderable}
			<GraphSvg
				graph={snapshot.fixture.graph}
				index={snapshot.index}
				positions={snapshot.layout.positions}
				dynamics={snapshot.fixture.initialDynamics}
			/>
		{:else}
			<div class="capped">
				<p>
					<strong>{stats.nodeCount.toLocaleString()} nodes generated and validated</strong> — but not
					drawn.
				</p>
				<p>
					The phase 1 renderer is one SVG element per node, port and edge. That is
					{(stats.nodeCount + stats.edgeCount).toLocaleString()} DOM nodes before labels, and the browser
					would spend seconds in style and layout for a picture nobody can read.
				</p>
				<p>
					Everything above this box is real: the graph exists, it is a DAG, and the
					numbers came from it. Phase 3 replaces this renderer.
				</p>
			</div>
		{/if}
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
		gap: 16px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	h1 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	.phase {
		margin-left: 8px;
		font-weight: 400;
		color: var(--text-muted);
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

	button:hover {
		color: var(--text);
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

	dt {
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.errors {
		margin: 0;
		padding: 8px 16px 8px 34px;
		font-size: 11px;
		color: #f87171;
		background: rgb(248 113 113 / 0.08);
		border-bottom: 1px solid var(--border);
	}

	main {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.capped {
		max-width: 52ch;
		margin: 12vh auto 0;
		font-size: 12px;
		line-height: 1.6;
		color: var(--text-muted);
	}

	.capped strong {
		color: var(--text);
	}
</style>
