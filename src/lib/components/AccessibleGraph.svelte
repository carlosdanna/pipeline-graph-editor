<script lang="ts">
	import { describeEdge, describeNode } from '$lib/a11y/describe';
	import type { NavigationContext } from '$lib/a11y/navigate';
	import { buildAccessibleTree } from '$lib/a11y/tree';
	import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
	import type { PipelineGraph } from '$lib/graph/types';
	import type { SelectionStore } from '$lib/interact/selection.svelte';
	import type { EdgeAnchors } from '$lib/render/edge-anchors';
	import type { VisibleNodes } from '$lib/render/visible.svelte';

	/**
	 * The parallel accessible tree: what the canvas would say if it could talk.
	 *
	 * A canvas is a blank rectangle to assistive technology, so everything drawn
	 * on it has to exist somewhere as real, focusable, labelled DOM. That is what
	 * this is — visually hidden, one element per described node and per described
	 * edge, kept in step with what the renderer culled to.
	 *
	 * **`aria-live` is deliberately off.** The streaming feed changes status and
	 * throughput up to 20,000 times a second; announcing any of it would render
	 * the page unusable, and announcing "some of it" would be worse, because the
	 * user could not tell what they had missed. Live values are read when a node
	 * is focused, on demand, which is the only rate a human can absorb.
	 *
	 * Roles: a multi-selectable listbox, because `aria-selected` is exactly the
	 * selection state we already keep and multi-select listboxes are a real,
	 * well-supported pattern. A graph has no native ARIA role;
	 * `aria-roledescription` says what it actually is, and the help text says how
	 * to move through it, since the arrow-key behaviour here is graph traversal
	 * rather than the linear walk a listbox would normally imply.
	 */
	interface Props {
		graph: PipelineGraph;
		/**
		 * Everything navigation reads. The tree asks it where the arrow keys can
		 * go, so that those elements exist to be focused.
		 */
		navigation: NavigationContext;
		anchors: EdgeAnchors;
		dynamics: DynamicsStore;
		selection: SelectionStore;
		visible: VisibleNodes;
		focusedNode: number;
	}

	let { graph, navigation, anchors, dynamics, selection, visible, focusedNode }: Props = $props();

	let root: HTMLElement | null = $state(null);

	const tree = $derived(
		buildAccessibleTree(navigation, anchors, visible.indices, visible.visibleCount, focusedNode)
	);

	const described = $derived(tree.nodes.length);

	/**
	 * The options to render, with their selection state.
	 *
	 * Selection has to come through here rather than being read inline, because
	 * `selection.nodeFlags` is a plain `Uint8Array` — deliberately, so the canvas
	 * can read it every frame without a proxy — and a plain array cannot be
	 * observed. `selection.version` is the signal that it changed.
	 *
	 * The *labels* are deliberately not in here. `describeNode` is called inline
	 * in the `{#each}` body so that each option's text is its own effect,
	 * depending on that node's cell alone; folding it into this list would mean
	 * one node's status change re-describing all 150.
	 */
	const options = $derived.by(() => {
		void selection.version;
		return tree.nodes.map((index) => ({
			index,
			selected: selection.nodeFlags[index] === 1
		}));
	});

	/**
	 * Roving tabindex: exactly one element in the list is in the tab order.
	 *
	 * When nothing is focused that is the first described node, so Tab always
	 * has somewhere to land and the graph is reachable from the keyboard without
	 * having clicked it first.
	 */
	const tabbableNode = $derived(
		focusedNode >= 0 && tree.nodes.includes(focusedNode) ? focusedNode : (tree.nodes[0] ?? -1)
	);

	/**
	 * Moves real DOM focus to follow `focusedNode`.
	 *
	 * Guarded on focus already being inside the graph, so that selecting a node
	 * from the table — which also sets the focused node — does not yank focus out
	 * of the table and out from under the user. `root.parentElement` is the
	 * interaction surface; checking it rather than `root` means focus counts as
	 * "in the graph" when the surface itself holds it, which is what happens
	 * immediately after a click on the canvas.
	 */
	$effect(() => {
		const target = focusedNode;
		if (target < 0 || !root) return;

		const surface = root.parentElement;
		if (!surface || !surface.contains(document.activeElement)) return;

		const element = root.querySelector<HTMLElement>(`[data-node="${target}"]`);
		if (element && element !== document.activeElement) element.focus();
	});
</script>

<div class="sr-only" bind:this={root}>
	<p id="graph-keyboard-help">
		Arrow keys move between connected stages: left and right follow the flow
		upstream and downstream, up and down move between stages that share a
		source. Enter selects the focused stage, shift and Enter adds it to the
		selection, Escape clears. Plus and minus zoom, zero fits the whole pipeline
		to the screen.
	</p>

	<div
		role="listbox"
		aria-multiselectable="true"
		aria-roledescription="pipeline graph"
		aria-describedby="graph-keyboard-help"
		aria-label="Pipeline stages, {described.toLocaleString()} of {visible.visibleCount.toLocaleString()} on screen described, {graph.nodes.length.toLocaleString()} in total"
		aria-live="off"
	>
		{#each options as option (option.index)}
			<div
				role="option"
				data-node={option.index}
				tabindex={option.index === tabbableNode ? 0 : -1}
				aria-selected={option.selected}
			>
				{describeNode(graph, dynamics, option.index)}
			</div>
		{/each}
	</div>

	{#if tree.truncated}
		<p>
			{(visible.visibleCount - described).toLocaleString()} further stages are on screen
			but not listed. Move through the pipeline with the arrow keys to reach them.
		</p>
	{/if}

	<ul aria-label="Connections, {tree.edges.length.toLocaleString()} described">
		{#each tree.edges as edgeIndex (edgeIndex)}
			<li>{describeEdge(graph, anchors, edgeIndex)}</li>
		{/each}
	</ul>
</div>

<style>
	/*
	 * Hidden from sight, present for everything else. `display: none` and
	 * `visibility: hidden` would both remove these from the accessibility tree,
	 * which is the one thing they exist for; a 1px clipped box keeps them
	 * readable and, crucially, focusable.
	 */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
</style>
