<script lang="ts">
	import NodeRow from './NodeRow.svelte';
	import type { DynamicsStore } from '$lib/graph/dynamics.svelte';
	import type { PipelineGraph } from '$lib/graph/types';
	import type { SelectionStore } from '$lib/interact/selection.svelte';
	import { FrameScheduler } from '$lib/render/frame';
	import { ROW_HEIGHT, scrollToIndex, windowFor } from '$lib/render/virtual';

	/**
	 * A resizable pane listing every node, virtualized.
	 *
	 * Only the rows inside the scroll viewport exist as elements — about forty
	 * of them, whether the graph has fifty nodes or a hundred thousand. The
	 * scrollbar's range comes from a single empty spacer sized to the full list,
	 * so the browser's own scrolling does the work and we only answer "which
	 * rows are those".
	 *
	 * Selection is bidirectional. A click here selects and pans the canvas to
	 * the node; a selection made on the canvas scrolls this list to it. The
	 * cycle does not loop, because `scrollToIndex` returns null when the row is
	 * already visible — so clicking a row, which changes the selection, never
	 * makes the list jump under the click.
	 */
	interface Props {
		graph: PipelineGraph;
		dynamics: DynamicsStore;
		selection: SelectionStore;
		/**
		 * The node the keyboard is on. Shared with the graph: there is one focus,
		 * seen from two places, so arrowing here moves the canvas and arrowing
		 * there scrolls this list.
		 */
		focusedNode: number;
		onselect: (index: number, additive: boolean) => void;
		onfocus: (index: number) => void;
	}

	let { graph, dynamics, selection, focusedNode, onselect, onfocus }: Props = $props();

	const MIN_HEIGHT = 80;
	const MAX_HEIGHT_FRACTION = 0.8;
	const DEFAULT_HEIGHT = 240;

	let paneHeight = $state(DEFAULT_HEIGHT);
	let scrollTop = $state(0);
	let viewportHeight = $state(0);
	let scroller: HTMLElement | null = $state(null);
	let pane: HTMLElement | null = $state(null);

	const rowCount = $derived(graph.nodes.length);
	const view = $derived(windowFor(scrollTop, viewportHeight, rowCount));

	/**
	 * The rows to render.
	 *
	 * Status and throughput are deliberately absent — each `NodeRow` reads its
	 * own, so a streaming update repaints one row instead of rebuilding this
	 * list. Selection *is* here, because it changes rarely and is cheap to
	 * derive for forty rows; `selection.version` is what makes that reactive,
	 * since the flags themselves are a plain typed array.
	 */
	const rows = $derived.by(() => {
		void selection.version;
		const out = [];
		for (let i = 0; i < view.count; i++) {
			const index = view.first + i;
			out.push({
				index,
				node: graph.nodes[index],
				top: (view.first + i) * ROW_HEIGHT,
				selected: selection.nodeFlags[index] === 1,
				primary: selection.primaryNode === index
			});
		}
		return out;
	});

	// Scroll events fire faster than frames, exactly like pointer events, so they
	// get the same treatment: read once per frame, render once per frame.
	const scrollScheduler = new FrameScheduler(() => {
		if (scroller) scrollTop = scroller.scrollTop;
	});

	function attachScroller(element: HTMLElement): () => void {
		scroller = element;
		viewportHeight = element.clientHeight;

		const observer = new ResizeObserver(() => {
			viewportHeight = element.clientHeight;
		});
		observer.observe(element);

		const onScroll = (): void => scrollScheduler.request();
		element.addEventListener('scroll', onScroll, { passive: true });

		return () => {
			observer.disconnect();
			element.removeEventListener('scroll', onScroll);
			scrollScheduler.cancel();
			scroller = null;
		};
	}

	/**
	 * Focus moving anywhere scrolls the list to it.
	 *
	 * Covers both halves of the bidirectional link, because a pointer pick on the
	 * canvas moves focus too: clicking a node scrolls the table to its row, and
	 * arrowing through the graph drags the list along.
	 *
	 * Reads position from the element rather than from `scrollTop`/`viewportHeight`
	 * on purpose: those are reactive, and depending on them here would re-run
	 * this effect on every scroll and fight the user.
	 */
	$effect(() => {
		const target = focusedNode;
		if (target < 0 || !scroller) return;

		const next = scrollToIndex(target, scroller.scrollTop, scroller.clientHeight, rowCount);
		if (next !== null) scroller.scrollTop = next;
	});

	/**
	 * Moves real DOM focus onto the focused row, but only when focus is already
	 * inside this pane — otherwise arrowing through the *graph* would yank focus
	 * out of the canvas and into the table on every step.
	 */
	$effect(() => {
		const target = focusedNode;
		if (target < 0 || !pane) return;
		if (!pane.contains(document.activeElement)) return;

		const row = pane.querySelector<HTMLElement>(`[data-row="${target}"]`);
		if (row && row !== document.activeElement) row.focus({ preventScroll: true });
	});

	/**
	 * Row navigation. Linear here, unlike the graph, because a list *is* linear —
	 * the useful thing about the table is precisely that it imposes a total order
	 * on a graph that has none, and it is how every stage is reachable from the
	 * keyboard whatever the arrow keys can reach on the canvas.
	 */
	function onGridKeyDown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;

		const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
		const current = focusedNode >= 0 ? focusedNode : view.first;
		let next = current;

		switch (event.key) {
			case 'ArrowDown':
				next = current + 1;
				break;
			case 'ArrowUp':
				next = current - 1;
				break;
			case 'PageDown':
				next = current + page;
				break;
			case 'PageUp':
				next = current - page;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = rowCount - 1;
				break;
			default:
				return;
		}

		event.preventDefault();
		// Clamped rather than wrapped: running off the end of a 10,000-row list
		// and reappearing at the top is disorienting in exactly the way the graph
		// navigation avoids.
		next = Math.max(0, Math.min(rowCount - 1, next));
		if (next !== current) onfocus(next);
	}

	/**
	 * Roving tabindex. When focus is nowhere in particular the first rendered row
	 * is tabbable, so Tab always has somewhere to land in the list.
	 */
	const tabbableRow = $derived(
		focusedNode >= view.first && focusedNode < view.first + view.count
			? focusedNode
			: (rows[0]?.index ?? -1)
	);

	// --- Resize --------------------------------------------------------------
	//
	// Same rule as the canvas: nothing is measured inside the move handler. The
	// starting height is captured on pointerdown and the rest is arithmetic.

	let dragStartY = 0;
	let dragStartHeight = 0;
	let resizing = $state(false);

	function onHandleDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		dragStartY = event.clientY;
		dragStartHeight = paneHeight;
		resizing = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onHandleMove(event: PointerEvent): void {
		if (!resizing) return;
		const maxHeight = window.innerHeight * MAX_HEIGHT_FRACTION;
		paneHeight = Math.max(
			MIN_HEIGHT,
			Math.min(maxHeight, dragStartHeight - (event.clientY - dragStartY))
		);
	}

	function onHandleUp(event: PointerEvent): void {
		if (!resizing) return;
		resizing = false;
		const element = event.currentTarget as HTMLElement;
		if (element.hasPointerCapture(event.pointerId)) {
			element.releasePointerCapture(event.pointerId);
		}
	}
</script>

<!--
	`aria-rowcount` is the *full* list, not the rendered window: that is the whole
	contract of a virtualized grid, and it is what tells a screen reader that row
	4,000 of 10,000 is row 4,000. Phase 8 extends this with focus management and
	the parallel tree for the canvas.
-->
<section class="pane" style:height="{paneHeight}px" bind:this={pane}>
	<!--
		The handle is a separator, not a button. Keyboard resizing lands in
		phase 8 along with the rest of the keyboard story.
	-->
	<div
		class="handle"
		class:active={resizing}
		role="separator"
		aria-orientation="horizontal"
		aria-label="Resize table"
		onpointerdown={onHandleDown}
		onpointermove={onHandleMove}
		onpointerup={onHandleUp}
		onpointercancel={onHandleUp}
	></div>

	<!--
		`tabindex="-1"` on the grid itself, not 0: the tab order should land on the
		focused *row*, via the roving tabindex below, rather than on the container.
		The grid still needs to be focusable so that a click inside it has
		somewhere for focus to settle.
	-->
	<div
		class="grid"
		role="grid"
		tabindex="-1"
		aria-label="Pipeline stages"
		aria-rowcount={rowCount + 1}
		onkeydown={onGridKeyDown}
	>
		<header role="row" aria-rowindex={1}>
			<span class="cell index" role="columnheader">#</span>
			<span class="cell" role="columnheader">stage</span>
			<span class="cell" role="columnheader">kind</span>
			<span class="cell" role="columnheader">status</span>
			<span class="cell rate" role="columnheader">throughput</span>
		</header>

		<div class="scroller" role="presentation" {@attach attachScroller}>
			<div class="spacer" style:height="{view.totalHeight}px" role="rowgroup">
				{#each rows as row (row.index)}
					<NodeRow
						index={row.index}
						node={row.node}
						top={row.top}
						selected={row.selected}
						primary={row.primary}
						tabbable={row.index === tabbableRow}
						{dynamics}
						{onselect}
					/>
				{/each}
			</div>
		</div>
	</div>

	<footer>
		<span>{rowCount.toLocaleString()} stages</span>
		<span class="muted">
			{view.count} rows rendered · {selection.nodeCount.toLocaleString()} selected
		</span>
	</footer>
</section>

<style>
	.pane {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--surface);
		border-top: 1px solid var(--border);
	}

	.handle {
		position: absolute;
		top: -3px;
		left: 0;
		right: 0;
		height: 7px;
		z-index: 3;
		cursor: ns-resize;
		touch-action: none;
	}

	.handle:hover,
	.handle.active {
		background: rgb(79 179 255 / 0.35);
	}

	/*
	 * The grid role goes on an inner element rather than on the pane: the pane
	 * also holds the resize handle and the footer, which are not part of the
	 * table, and a grid whose children include a separator is a lie.
	 */
	.grid {
		outline: none;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	header,
	footer {
		flex: none;
	}

	header {
		display: grid;
		grid-template-columns: 56px 1fr 88px 96px 92px;
		gap: 12px;
		padding: 6px 16px;
		font-size: 10.5px;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
	}

	.cell {
		overflow: hidden;
		white-space: nowrap;
	}

	.index,
	.rate {
		text-align: right;
	}

	.scroller {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.spacer {
		position: relative;
		width: 100%;
	}

	footer {
		display: flex;
		gap: 16px;
		padding: 5px 16px;
		font-size: 10.5px;
		color: var(--text);
		border-top: 1px solid var(--border);
	}

	.muted {
		margin-left: auto;
		color: var(--text-muted);
	}
</style>
