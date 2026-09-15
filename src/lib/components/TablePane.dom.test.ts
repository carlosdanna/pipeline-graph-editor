import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { generateFixture } from '$lib/graph/generate';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { ROW_HEIGHT } from '$lib/render/virtual';
import TablePane from './TablePane.svelte';

/**
 * Virtualization, in a document.
 *
 * The windowing arithmetic is unit-tested to a million rows; this checks the
 * thing the arithmetic is *for* — that the DOM actually stays small, and that
 * the rows wired up to it behave.
 *
 * jsdom has no layout, so every element measures zero. The viewport height is
 * stubbed rather than faked per element, because the component reads it through
 * `clientHeight` exactly as it would in a browser.
 */

const VIEWPORT = 240;
const fixture = generateFixture(10000);

let originalClientHeight: PropertyDescriptor | undefined;

beforeEach(() => {
	originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get: () => VIEWPORT
	});
});

afterEach(() => {
	if (originalClientHeight) {
		Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
	}
});

function mountPane(overrides: Partial<Record<string, unknown>> = {}) {
	const dynamics = DynamicsStore.from(fixture.initialDynamics);
	const selection = new SelectionStore(fixture.graph.nodes.length, fixture.graph.edges.length);
	const selected: Array<[number, boolean]> = [];
	const focused: number[] = [];

	const result = render(TablePane, {
		props: {
			graph: fixture.graph,
			dynamics,
			selection,
			focusedNode: -1,
			onselect: (index: number, additive: boolean) => selected.push([index, additive]),
			onfocus: (index: number) => focused.push(index),
			...overrides
		}
	});

	return { ...result, dynamics, selection, selected, focused };
}

describe('virtualization', () => {
	it('renders a couple of dozen rows for ten thousand stages', () => {
		const { container } = mountPane();
		const rows = container.querySelectorAll('[role="row"][data-row]');

		expect(rows.length).toBeGreaterThan(0);
		// A screenful plus overscan, not ten thousand.
		expect(rows.length).toBeLessThan(40);
	});

	it('gives the scrollbar the full range of the list', () => {
		const { container } = mountPane();
		const spacer = container.querySelector<HTMLElement>('[role="rowgroup"]')!;
		expect(spacer.style.height).toBe(`${fixture.graph.nodes.length * ROW_HEIGHT}px`);
	});

	it('reports the true row count to assistive technology, not the rendered one', () => {
		// The entire contract of a virtualized grid: row 4,000 of 10,000, not
		// row 12 of 22.
		const { container } = mountPane();
		const grid = container.querySelector('[role="grid"]')!;
		expect(grid.getAttribute('aria-rowcount')).toBe(String(fixture.graph.nodes.length + 1));
	});
});

describe('rows', () => {
	it('labels each row with its stage', () => {
		const { container } = mountPane();
		const first = container.querySelector('[data-row="0"]')!;
		expect(first.textContent).toContain(fixture.graph.nodes[0].label);
	});

	it('reports selection through aria-selected', async () => {
		const { container, selection } = mountPane();
		selection.selectNode(2);
		await tick();

		expect(container.querySelector('[data-row="2"]')!.getAttribute('aria-selected')).toBe('true');
		expect(container.querySelector('[data-row="3"]')!.getAttribute('aria-selected')).toBe('false');
	});

	it('repaints one row when one node is notified', async () => {
		const { container, dynamics } = mountPane();
		dynamics.write(0, statusIndex('running'), 1000);
		dynamics.write(1, statusIndex('running'), 1000);
		dynamics.notify(0);
		dynamics.notify(1);
		await tick();

		const before = container.querySelector('[data-row="1"]')!.textContent;

		dynamics.write(0, statusIndex('failed'), 0);
		dynamics.write(1, statusIndex('failed'), 0);
		dynamics.notify(0);
		await tick();

		expect(container.querySelector('[data-row="0"]')!.textContent).toContain('failed');
		expect(container.querySelector('[data-row="1"]')!.textContent).toBe(before);
	});

	it('reports a click, with the shift state', async () => {
		const { container, selected } = mountPane();
		const row = container.querySelector<HTMLElement>('[data-row="3"]')!;

		row.click();
		expect(selected).toEqual([[3, false]]);

		row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		expect(selected[1]).toEqual([3, true]);
	});
});

describe('keyboard', () => {
	function press(container: HTMLElement, key: string): void {
		container
			.querySelector('[role="grid"]')!
			.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
	}

	it('moves down and up a row at a time', () => {
		const { container, focused } = mountPane({ focusedNode: 5 });
		press(container, 'ArrowDown');
		press(container, 'ArrowUp');
		expect(focused).toEqual([6, 4]);
	});

	it('jumps to the ends', () => {
		const { container, focused } = mountPane({ focusedNode: 5 });
		press(container, 'End');
		press(container, 'Home');
		expect(focused).toEqual([fixture.graph.nodes.length - 1, 0]);
	});

	it('pages by a screenful', () => {
		const { container, focused } = mountPane({ focusedNode: 100 });
		press(container, 'PageDown');
		expect(focused[0]).toBeGreaterThan(100);
		expect(focused[0]).toBeLessThan(100 + Math.ceil(VIEWPORT / ROW_HEIGHT) + 2);
	});

	it('clamps at the ends rather than wrapping', () => {
		// Running off a 10,000-row list and reappearing at the top is disorienting
		// in exactly the way the graph navigation avoids.
		const top = mountPane({ focusedNode: 0 });
		press(top.container, 'ArrowUp');
		expect(top.focused).toEqual([]);

		const bottom = mountPane({ focusedNode: fixture.graph.nodes.length - 1 });
		press(bottom.container, 'ArrowDown');
		expect(bottom.focused).toEqual([]);
	});

	it('leaves modified keys to the browser', () => {
		const { container, focused } = mountPane({ focusedNode: 5 });
		container
			.querySelector('[role="grid"]')!
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }));
		expect(focused).toEqual([]);
	});

	it('keeps exactly one row in the tab order', () => {
		const { container } = mountPane({ focusedNode: 4 });
		const tabbable = container.querySelectorAll('[data-row][tabindex="0"]');
		expect(tabbable.length).toBe(1);
		expect(tabbable[0].getAttribute('data-row')).toBe('4');
	});
});
