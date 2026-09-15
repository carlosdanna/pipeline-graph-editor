import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex, computeLayers } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { VisibleNodes } from '$lib/render/visible.svelte';
import { A11Y_NODE_LIMIT } from '$lib/a11y/tree';
import { moveFocus, type NavigationContext } from '$lib/a11y/navigate';
import AccessibleGraph from './AccessibleGraph.svelte';

/**
 * The parallel tree, as a document.
 *
 * A canvas is a blank rectangle to assistive technology, so this is the entire
 * accessible surface of the graph. These tests are about what is announced and
 * what can be focused, which is the only thing that matters here.
 */

const fixture = generateFixture(2000);
const index = buildGraphIndex(fixture.graph);
const positions = layoutLayered(fixture.graph, index).positions;
const layers = computeLayers(fixture.graph, index) ?? new Int32Array(fixture.graph.nodes.length);
const anchors = buildEdgeAnchors(fixture.graph, index);
const navigation: NavigationContext = { graph: fixture.graph, index, positions, layers };

function mountTree(visibleCount: number, focusedNode: number) {
	const dynamics = DynamicsStore.from(fixture.initialDynamics);
	const selection = new SelectionStore(fixture.graph.nodes.length, fixture.graph.edges.length);

	const visible = new VisibleNodes();
	const buffer = new Int32Array(fixture.graph.nodes.length);
	for (let i = 0; i < visibleCount; i++) buffer[i] = i;
	visible.publish(buffer, visibleCount, false, A11Y_NODE_LIMIT);

	const result = render(AccessibleGraph, {
		props: { graph: fixture.graph, navigation, anchors, dynamics, selection, visible, focusedNode }
	});

	return { ...result, dynamics, selection, visible };
}

describe('structure', () => {
	it('presents the stages as a multi-selectable listbox', () => {
		const { container } = mountTree(40, -1);
		const listbox = container.querySelector('[role="listbox"]')!;

		expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
		expect(listbox.getAttribute('aria-roledescription')).toBe('pipeline graph');
		expect(container.querySelectorAll('[role="option"]').length).toBe(40);
	});

	it('never announces live values, however fast they change', () => {
		// The feed runs at up to 20,000 updates a second. Announcing any of it
		// would make the page unusable; announcing some would be worse.
		const { container } = mountTree(40, -1);
		expect(container.querySelector('[role="listbox"]')!.getAttribute('aria-live')).toBe('off');
	});

	it('explains the arrow keys, because they are not a listbox linear walk', () => {
		const { container } = mountTree(40, -1);
		const listbox = container.querySelector('[role="listbox"]')!;
		const help = container.querySelector(`#${listbox.getAttribute('aria-describedby')}`);

		expect(help?.textContent).toMatch(/arrow keys/i);
		expect(help?.textContent).toMatch(/escape/i);
	});

	it('describes the connections as well as the stages', () => {
		const { container } = mountTree(20, -1);
		const list = container.querySelector('ul')!;

		expect(list.getAttribute('aria-label')).toMatch(/connections/i);
		expect(list.querySelectorAll('li').length).toBeGreaterThan(0);
		expect(list.textContent).toMatch(/from .+ to .+/);
	});
});

describe('labels', () => {
	it('names each stage with its label, kind, status and rate', () => {
		const { container, dynamics } = mountTree(10, -1);
		const option = container.querySelector('[data-node="3"]')!;

		expect(option.textContent).toContain(fixture.graph.nodes[3].label);
		expect(option.textContent).toContain(fixture.graph.nodes[3].kind);
		expect(option.textContent).toContain(dynamics.view(3).status);
	});

	it('states how much of the graph it is describing', () => {
		// So a screen reader is told "40 of 900 on screen described" rather than
		// quietly handed a truncated list.
		const { container } = mountTree(900, -1);
		const label = container.querySelector('[role="listbox"]')!.getAttribute('aria-label')!;

		expect(label).toContain('900');
		expect(label).toContain(fixture.graph.nodes.length.toLocaleString());
	});

	it('says when on-screen stages were left out', () => {
		const { container } = mountTree(900, -1);
		expect(container.textContent).toMatch(/further stages are on screen/i);
	});

	it('updates one option when one node is notified', async () => {
		const { container, dynamics } = mountTree(10, -1);
		dynamics.write(0, statusIndex('failed'), 0);
		dynamics.notify(0);
		await tick();

		expect(container.querySelector('[data-node="0"]')!.textContent).toContain('failed');
	});
});

describe('selection and focus', () => {
	it('reflects selection through aria-selected', async () => {
		const { container, selection } = mountTree(10, -1);
		selection.selectNode(4);
		await tick();

		expect(container.querySelector('[data-node="4"]')!.getAttribute('aria-selected')).toBe('true');
		expect(container.querySelector('[data-node="5"]')!.getAttribute('aria-selected')).toBe('false');
	});

	it('keeps exactly one option in the tab order', () => {
		const { container } = mountTree(20, 7);
		const tabbable = container.querySelectorAll('[data-node][tabindex="0"]');

		expect(tabbable.length).toBe(1);
		expect(tabbable[0].getAttribute('data-node')).toBe('7');
	});

	it('still offers a tab target when nothing is focused', () => {
		const { container } = mountTree(20, -1);
		expect(container.querySelectorAll('[data-node][tabindex="0"]').length).toBe(1);
	});

	it('describes everywhere the arrow keys can go from the focused stage', () => {
		/*
		 * The load-bearing invariant. An arrow key must have an element to move
		 * focus to, and it has to exist before the viewport pans to reveal it.
		 * Here the focused node is far outside the visible window, so every
		 * target present is there because the tree put it there deliberately.
		 */
		const { container } = mountTree(40, 1500);
		expect(container.querySelector('[data-node="1500"]')).not.toBeNull();

		for (const direction of ['up', 'down', 'left', 'right'] as const) {
			const target = moveFocus(navigation, 1500, direction);
			if (target < 0) continue;
			expect(container.querySelector(`[data-node="${target}"]`)).not.toBeNull();
		}
	});

	it('stays bounded when the whole graph is on screen', () => {
		const { container } = mountTree(fixture.graph.nodes.length, 900);
		const options = container.querySelectorAll('[role="option"]');

		expect(options.length).toBeGreaterThan(0);
		expect(options.length).toBeLessThan(A11Y_NODE_LIMIT + 40);
	});
});
