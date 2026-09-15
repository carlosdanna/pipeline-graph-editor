import { describe, expect, it } from 'vitest';
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { DynamicsStore } from '$lib/graph/dynamics.svelte';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import { describeEdge, describeNode, spokenThroughput } from './describe';

/**
 * The strings are the entire interface for someone using a screen reader — the
 * canvas is a blank rectangle to them — so they get tested like an interface.
 */

const fixture = generateFixture(500);
const index = buildGraphIndex(fixture.graph);
const anchors = buildEdgeAnchors(fixture.graph, index);
const dynamics = DynamicsStore.from(fixture.initialDynamics);

describe('spokenThroughput', () => {
	it('says a rate rather than reading out an abbreviation', () => {
		// "12.4k" exists because a node is 176 pixels wide. Speech has no such
		// constraint, so it gets the full form.
		expect(spokenThroughput(842)).toBe('842 records per second');
		expect(spokenThroughput(12_400)).toBe('12.4 thousand records per second');
		expect(spokenThroughput(2_500_000)).toBe('2.5 million records per second');
	});

	it('calls a stopped stage idle, not zero', () => {
		expect(spokenThroughput(0)).toBe('idle');
		expect(spokenThroughput(-5)).toBe('idle');
	});
});

describe('describeNode', () => {
	it('leads with the label, because listeners interrupt', () => {
		for (let n = 0; n < fixture.graph.nodes.length; n++) {
			const text = describeNode(fixture.graph, dynamics, n);
			expect(text.startsWith(fixture.graph.nodes[n].label)).toBe(true);
		}
	});

	it('names the kind, the status, the rate and the port counts', () => {
		const text = describeNode(fixture.graph, dynamics, 40);
		const node = fixture.graph.nodes[40];
		expect(text).toContain(node.kind);
		expect(text).toContain(dynamics.view(40).status);
		expect(text).toMatch(/\d+ inputs?/);
		expect(text).toMatch(/\d+ outputs?/);
	});

	it('singularises a single port', () => {
		const single = fixture.graph.nodes.findIndex(
			(n) => n.inputs.length === 1 && n.outputs.length === 1
		);
		expect(single).toBeGreaterThanOrEqual(0);
		expect(describeNode(fixture.graph, dynamics, single)).toContain('1 input, 1 output');
	});

	it('returns nothing for a node that does not exist', () => {
		expect(describeNode(fixture.graph, dynamics, 99999)).toBe('');
	});
});

describe('describeEdge', () => {
	it('names the data type and both endpoints by label', () => {
		// Named by endpoints rather than by id, because `e4821` is not information.
		for (let e = 0; e < fixture.graph.edges.length; e++) {
			const text = describeEdge(fixture.graph, anchors, e);
			expect(text.startsWith(fixture.graph.edges[e].dataType)).toBe(true);
			expect(text).toContain(fixture.graph.nodes[anchors.source[e]].label);
			expect(text).toContain(fixture.graph.nodes[anchors.target[e]].label);
		}
	});

	it('returns nothing for an edge that does not exist', () => {
		expect(describeEdge(fixture.graph, anchors, 99999)).toBe('');
	});
});
