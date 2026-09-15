/**
 * Phase 8: keyboard navigation, the accessible tree, and the shortcut table.
 *
 * All three are pure logic, which is the point of having put them in
 * `src/lib/a11y/` rather than inside a component. The thing a screen reader
 * user experiences is a graph traversal and a set of strings, and both can be
 * checked exhaustively here in a way that clicking around never would.
 */
import { generateFixture, FIXTURE_SIZES } from '$lib/graph/generate';
import { buildGraphIndex, computeLayers } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { DynamicsStore } from '$lib/graph/dynamics.svelte';
import { buildEdgeAnchors } from '$lib/render/edge-anchors';
import {
	moveFocus,
	downstream,
	upstream,
	type Direction,
	type NavigationContext
} from '$lib/a11y/navigate';
import { buildAccessibleTree, A11Y_NODE_LIMIT } from '$lib/a11y/tree';
import { actionFor, KEY_ZOOM_STEP } from '$lib/a11y/shortcuts';
import { describeNode, describeEdge, spokenThroughput } from '$lib/a11y/describe';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

const built = FIXTURE_SIZES.map((size) => {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	const positions = layoutLayered(fixture.graph, index).positions;
	const layers = computeLayers(fixture.graph, index) ?? new Int32Array(fixture.graph.nodes.length);
	return {
		size,
		graph: fixture.graph,
		index,
		positions,
		layers,
		anchors: buildEdgeAnchors(fixture.graph, index),
		dynamics: DynamicsStore.from(fixture.initialDynamics),
		ctx: { graph: fixture.graph, index, positions, layers } satisfies NavigationContext
	};
});

function centreY(ctx: NavigationContext, node: number): number {
	return ctx.positions.y[node] + ctx.graph.nodes[node].height / 2;
}

console.log('\n=== arrow keys move between connected nodes ===\n');
for (const f of built) {
	let selfMoves = 0;
	let unconnected = 0;
	let outOfRange = 0;
	let moves = 0;

	for (let n = 0; n < f.graph.nodes.length; n++) {
		for (const direction of DIRECTIONS) {
			const to = moveFocus(f.ctx, n, direction);
			if (to < 0) continue;
			moves++;

			if (to === n) selfMoves++;
			if (to < 0 || to >= f.graph.nodes.length) outOfRange++;

			// Left and right follow an edge. Up and down walk the layer, so the
			// invariant there is "same layer", not "adjacent" — see navigate.ts
			// for why that trade was made.
			const connected =
				direction === 'right'
					? downstream(f.ctx, n).includes(to)
					: direction === 'left'
						? upstream(f.ctx, n).includes(to)
						: f.layers[to] === f.layers[n];
			if (!connected) unconnected++;
		}
	}

	check(
		`every move lands on a connected node  n=${String(f.size).padStart(5)}`,
		unconnected === 0 && selfMoves === 0 && outOfRange === 0,
		`${moves} moves, ${unconnected} unconnected, ${selfMoves} self, ${outOfRange} out of range`
	);
}

console.log('\n=== up and down retrace exactly ===\n');
for (const f of built) {
	// The property a keyboard user actually feels: press down, press up, be back
	// where you started. This is why up and down walk the layer — the sibling
	// model managed 74%, because "nearest sibling" is not a total order.
	let tried = 0;
	let retraced = 0;
	for (let n = 0; n < f.graph.nodes.length; n++) {
		const down = moveFocus(f.ctx, n, 'down');
		if (down >= 0) {
			tried++;
			if (moveFocus(f.ctx, down, 'up') === n) retraced++;
		}
		const up = moveFocus(f.ctx, n, 'up');
		if (up >= 0) {
			tried++;
			if (moveFocus(f.ctx, up, 'down') === n) retraced++;
		}
	}
	check(
		`down then up returns to the start  n=${String(f.size).padStart(5)}`,
		retraced === tried,
		`${retraced}/${tried} (${((retraced / tried) * 100).toFixed(1)}%)`
	);
}

console.log('\n=== up and down are monotonic in screen position ===\n');
for (const f of built) {
	let wrongWay = 0;
	let checked = 0;

	for (let n = 0; n < f.graph.nodes.length; n++) {
		const up = moveFocus(f.ctx, n, 'up');
		if (up >= 0) {
			checked++;
			// Strictly above, or level and earlier — level siblings are common in a
			// layered layout, and without the tiebreak up and down would both find
			// the node you are already on.
			const above = centreY(f.ctx, up) < centreY(f.ctx, n);
			const levelEarlier = centreY(f.ctx, up) === centreY(f.ctx, n) && up < n;
			if (!above && !levelEarlier) wrongWay++;
		}

		const down = moveFocus(f.ctx, n, 'down');
		if (down >= 0) {
			checked++;
			const below = centreY(f.ctx, down) > centreY(f.ctx, n);
			const levelLater = centreY(f.ctx, down) === centreY(f.ctx, n) && down > n;
			if (!below && !levelLater) wrongWay++;
		}
	}

	check(
		`up goes up and down goes down  n=${String(f.size).padStart(5)}`,
		wrongWay === 0,
		`${checked} moves checked, ${wrongWay} wrong way`
	);
}

console.log('\n=== focus cannot get stuck or loop ===\n');
for (const f of built) {
	// Repeatedly pressing one direction must terminate, not cycle.
	let cycles = 0;
	const starts = Math.min(400, f.graph.nodes.length);
	for (let s = 0; s < starts; s++) {
		const start = Math.floor((s * f.graph.nodes.length) / starts);
		for (const direction of DIRECTIONS) {
			const seen = new Set<number>([start]);
			let at = start;
			for (let step = 0; step < 5000; step++) {
				const next = moveFocus(f.ctx, at, direction);
				if (next < 0) break;
				if (seen.has(next)) {
					cycles++;
					break;
				}
				seen.add(next);
				at = next;
			}
		}
	}
	check(
		`holding one arrow terminates  n=${String(f.size).padStart(5)}`,
		cycles === 0,
		`${starts * 4} runs, ${cycles} cycles`
	);
}

console.log('\n=== the whole graph is reachable from the keyboard ===\n');
for (const f of built) {
	// Breadth-first over the four arrow moves only. If this does not cover the
	// graph, there are stages a keyboard user simply cannot get to.
	const seen = new Uint8Array(f.graph.nodes.length);
	const queue = [0];
	seen[0] = 1;
	let count = 1;

	for (let head = 0; head < queue.length; head++) {
		for (const direction of DIRECTIONS) {
			const next = moveFocus(f.ctx, queue[head], direction);
			if (next >= 0 && seen[next] === 0) {
				seen[next] = 1;
				count++;
				queue.push(next);
			}
		}
	}

	const pct = (count / f.graph.nodes.length) * 100;
	check(
		`arrow keys reach every stage  n=${String(f.size).padStart(5)}`,
		count === f.graph.nodes.length,
		`${count}/${f.graph.nodes.length} (${pct.toFixed(1)}%)`
	);
}

console.log('\n=== the accessible tree ===\n');
for (const f of built) {
	const visibleAll: number[] = [];
	for (let i = 0; i < Math.min(f.graph.nodes.length, A11Y_NODE_LIMIT); i++) visibleAll.push(i);

	let missingFocus = 0;
	let missingNeighbour = 0;
	let overLimit = 0;
	let danglingEdge = 0;
	const probes = Math.min(300, f.graph.nodes.length);

	for (let p = 0; p < probes; p++) {
		const focused = Math.floor((p * f.graph.nodes.length) / probes);
		const tree = buildAccessibleTree(
			f.ctx,
			f.anchors,
			visibleAll,
			f.graph.nodes.length,
			focused
		);
		const members = new Set(tree.nodes);

		if (!members.has(focused)) missingFocus++;

		// The load-bearing property: an arrow key must have an element to move to.
		for (const direction of DIRECTIONS) {
			const target = moveFocus(f.ctx, focused, direction);
			if (target >= 0 && !members.has(target)) missingNeighbour++;
		}

		// Bounded, allowing for the focused node and its neighbours on top.
		// The limit bounds the on-screen nodes; focus, its four arrow targets and
		// its adjacency are added on top and are what keep navigation working.
		const extras = f.index.incoming[focused].length + f.index.outgoing[focused].length + 5;
		if (tree.nodes.length > A11Y_NODE_LIMIT + extras) overLimit++;

		for (const e of tree.edges) {
			if (!members.has(f.anchors.source[e]) && !members.has(f.anchors.target[e])) danglingEdge++;
		}
	}

	check(
		`the focused node is always described     n=${String(f.size).padStart(5)}`,
		missingFocus === 0,
		`${probes} probes`
	);
	check(
		`every arrow target is always described   n=${String(f.size).padStart(5)}`,
		missingNeighbour === 0,
		`${probes * 4} targets, ${missingNeighbour} missing`
	);
	check(
		`the tree stays bounded                   n=${String(f.size).padStart(5)}`,
		overLimit === 0,
		`limit ${A11Y_NODE_LIMIT}`
	);
	check(
		`every described edge touches the tree    n=${String(f.size).padStart(5)}`,
		danglingEdge === 0
	);
}

{
	const f = built[3];
	const visible: number[] = [];
	for (let i = 0; i < 40; i++) visible.push(i);

	const tree = buildAccessibleTree(f.ctx, f.anchors, visible, 9000, 5000);
	check('truncation is reported when on-screen nodes are elided', tree.truncated,
		`${tree.nodes.length} described, ${tree.visibleCount} on screen`);
	check('the focused node survives truncation', tree.nodes.includes(5000));

	const whole = buildAccessibleTree(f.ctx, f.anchors, visible, 40, 5000);
	check('no truncation when everything on screen is described', !whole.truncated,
		`${whole.nodes.length} described of 40 on screen`);

	const unfocused = buildAccessibleTree(f.ctx, f.anchors, visible, 40, -1);
	check('an unfocused tree still describes what is on screen',
		unfocused.nodes.length === 40, `${unfocused.nodes.length} nodes`);
}

console.log('\n=== the shortcut table ===\n');
{
	const table: [string, string][] = [
		['ArrowUp', 'move'],
		['ArrowDown', 'move'],
		['ArrowLeft', 'move'],
		['ArrowRight', 'move'],
		['Enter', 'select'],
		['Escape', 'clear'],
		['+', 'zoom'],
		['=', 'zoom'],
		['Add', 'zoom'],
		['-', 'zoom'],
		['_', 'zoom'],
		['Subtract', 'zoom'],
		['0', 'fit']
	];

	let wrong = 0;
	for (const [key, type] of table) {
		const action = actionFor({ key });
		if (!action || action.type !== type) wrong++;
	}
	check('every documented key maps to its action', wrong === 0, `${table.length} keys`);

	check('+ zooms in and - zooms out', (() => {
		const zoomIn = actionFor({ key: '+' });
		const zoomOut = actionFor({ key: '-' });
		return (
			zoomIn?.type === 'zoom' &&
			zoomOut?.type === 'zoom' &&
			zoomIn.factor === KEY_ZOOM_STEP &&
			Math.abs(zoomOut.factor - 1 / KEY_ZOOM_STEP) < 1e-12
		);
	})());

	check('shift and Enter is additive',
		actionFor({ key: 'Enter', shiftKey: true })?.type === 'select' &&
			(actionFor({ key: 'Enter', shiftKey: true }) as { additive: boolean }).additive === true);
	check('plain Enter is not additive',
		(actionFor({ key: 'Enter' }) as { additive: boolean }).additive === false);

	// The browser's own shortcuts must survive.
	let stolen = 0;
	for (const key of ['-', '+', '0', 'ArrowDown', 'Enter']) {
		if (actionFor({ key, ctrlKey: true })) stolen++;
		if (actionFor({ key, metaKey: true })) stolen++;
		if (actionFor({ key, altKey: true })) stolen++;
	}
	check('ctrl, meta and alt combinations are left alone', stolen === 0, `${stolen} stolen`);

	let noise = 0;
	for (const key of ['a', 'Z', 'Tab', 'F5', ' ', 'PageDown', '1', 'Backspace']) {
		if (actionFor({ key })) noise++;
	}
	check('unrelated keys do nothing', noise === 0, `${noise} claimed`);
}

console.log('\n=== descriptions ===\n');
{
	const f = built[1];

	check('a rate under a thousand is spoken in full',
		spokenThroughput(842) === '842 records per second', spokenThroughput(842));
	check('thousands are spoken as thousands',
		spokenThroughput(12_400) === '12.4 thousand records per second', spokenThroughput(12_400));
	check('millions are spoken as millions',
		spokenThroughput(2_500_000) === '2.5 million records per second', spokenThroughput(2_500_000));
	check('a stopped stage is idle, not zero', spokenThroughput(0) === 'idle');

	let empty = 0;
	let missingLabel = 0;
	for (let n = 0; n < f.graph.nodes.length; n++) {
		const text = describeNode(f.graph, f.dynamics, n);
		if (!text) empty++;
		if (!text.startsWith(f.graph.nodes[n].label)) missingLabel++;
	}
	check('every node describes itself', empty === 0, `${f.graph.nodes.length} nodes`);
	check('every description leads with the label', missingLabel === 0);

	let badEdge = 0;
	for (let e = 0; e < f.graph.edges.length; e++) {
		const text = describeEdge(f.graph, f.anchors, e);
		const edge = f.graph.edges[e];
		const source = f.graph.nodes[f.anchors.source[e]];
		const target = f.graph.nodes[f.anchors.target[e]];
		if (!text.includes(source.label) || !text.includes(target.label)) badEdge++;
		if (!text.startsWith(edge.dataType)) badEdge++;
	}
	check('every edge names its data type and both ends', badEdge === 0,
		`${f.graph.edges.length} edges`);

	console.log(`\n  sample node:  "${describeNode(f.graph, f.dynamics, 40)}"`);
	console.log(`  sample edge:  "${describeEdge(f.graph, f.anchors, 40)}"`);
}

console.log('\n=== cost ===\n');
{
	function median(v: number[]): number {
		return [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
	}

	console.log('  fixture | moveFocus | buildAccessibleTree | describe 150 nodes');
	console.log('  --------|-----------|---------------------|-------------------');

	for (const f of built) {
		const visible: number[] = [];
		for (let i = 0; i < Math.min(f.graph.nodes.length, A11Y_NODE_LIMIT); i++) visible.push(i);

		const moveTimes: number[] = [];
		for (let r = 0; r < 7; r++) {
			const t0 = performance.now();
			for (let i = 0; i < 2000; i++) {
				moveFocus(f.ctx, i % f.graph.nodes.length, DIRECTIONS[i & 3]);
			}
			moveTimes.push((performance.now() - t0) / 2000);
		}

		const treeTimes: number[] = [];
		for (let r = 0; r < 7; r++) {
			const t0 = performance.now();
			for (let i = 0; i < 200; i++) {
				buildAccessibleTree(f.ctx, f.anchors, visible, f.graph.nodes.length, i);
			}
			treeTimes.push((performance.now() - t0) / 200);
		}

		const describeTimes: number[] = [];
		const count = Math.min(150, f.graph.nodes.length);
		for (let r = 0; r < 7; r++) {
			const t0 = performance.now();
			for (let i = 0; i < count; i++) describeNode(f.graph, f.dynamics, i);
			describeTimes.push(performance.now() - t0);
		}

		console.log(
			`  ${String(f.size).padStart(6)}  | ${(median(moveTimes) * 1000).toFixed(2).padStart(6)} µs | ` +
				`${median(treeTimes).toFixed(3).padStart(16)} ms | ` +
				`${median(describeTimes).toFixed(3).padStart(15)} ms`
		);
	}
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
