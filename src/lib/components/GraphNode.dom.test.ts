import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { generateFixture } from '$lib/graph/generate';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import GraphNode from './GraphNode.svelte';

/**
 * The phase 6 claim, in a real DOM: **a status change repaints one node**.
 *
 * Every other test of this is about routing — which index got notified. This is
 * the one that checks Svelte actually does what the routing assumes, with real
 * signals, real components and a real (if simulated) document.
 */

const fixture = generateFixture(50);

function mountNode(index: number, dynamics: DynamicsStore) {
	return render(GraphNode, {
		props: { index, node: fixture.graph.nodes[index], x: 0, y: 0, dynamics }
	});
}

describe('per-node repaint', () => {
	it('re-renders only the node that was notified', async () => {
		const dynamics = new DynamicsStore(fixture.graph.nodes.length);
		dynamics.write(0, statusIndex('running'), 1000);
		dynamics.write(1, statusIndex('running'), 1000);

		const first = mountNode(0, dynamics);
		const second = mountNode(1, dynamics);

		expect(first.container.textContent).toContain('1.0k/s');
		expect(second.container.textContent).toContain('1.0k/s');

		// Change the data for BOTH, but notify only one. If the components shared
		// a reactive scope — an `{#each}` reading status inline, say — the
		// unnotified one would update too, and the granularity would be a fiction.
		dynamics.write(0, statusIndex('degraded'), 5000);
		dynamics.write(1, statusIndex('degraded'), 5000);
		dynamics.notify(0);
		await tick();

		expect(first.container.textContent).toContain('5.0k/s');
		expect(second.container.textContent).toContain('1.0k/s');
	});

	it('shows the status as a border colour driven by the live value', async () => {
		const dynamics = new DynamicsStore(fixture.graph.nodes.length);
		dynamics.write(0, statusIndex('running'), 100);

		const { container } = mountNode(0, dynamics);
		const node = container.querySelector<HTMLElement>('.node')!;
		const running = node.style.getPropertyValue('--status');

		dynamics.write(0, statusIndex('failed'), 0);
		dynamics.notify(0);
		await tick();

		expect(node.style.getPropertyValue('--status')).not.toBe(running);
	});

	it('shows a stopped stage as a dash rather than as zero', async () => {
		const dynamics = new DynamicsStore(fixture.graph.nodes.length);
		dynamics.write(0, statusIndex('idle'), 0);

		const { container } = mountNode(0, dynamics);
		expect(container.textContent).toContain('—');
	});

	it('notifying a node nothing has rendered propagates nowhere', async () => {
		// The other half of the granularity claim: an off-screen update is a
		// single signal write with no subscribers, not work deferred to later.
		const dynamics = new DynamicsStore(fixture.graph.nodes.length);
		dynamics.write(0, statusIndex('running'), 1000);
		const { container } = mountNode(0, dynamics);

		for (let n = 1; n < fixture.graph.nodes.length; n++) {
			dynamics.write(n, statusIndex('failed'), 0);
			dynamics.notify(n);
		}
		await tick();

		expect(container.textContent).toContain('1.0k/s');
	});

	it('keeps rendering correctly after the store grows', async () => {
		const dynamics = new DynamicsStore(fixture.graph.nodes.length);
		dynamics.write(0, statusIndex('running'), 1000);
		const { container } = mountNode(0, dynamics);

		dynamics.resize(fixture.graph.nodes.length + 10);
		dynamics.write(0, statusIndex('running'), 7000);
		dynamics.notify(0);
		await tick();

		expect(container.textContent).toContain('7.0k/s');
	});
});
