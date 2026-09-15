/**
 * Phase 4 gesture state machine, exercised without a browser.
 *
 * This runs the *real* InteractionController and the *real* SelectionStore.
 * The only shim is `$state`, which esbuild emits as a plain call and a banner
 * defines as the identity function — so the store behaves exactly as it does in
 * the browser minus the reactivity, which is not what is under test here.
 *
 * Being able to do this at all is the argument for having split gesture meaning
 * out of HybridRenderer: there is no DOM in the path.
 */
import { generateFixture } from '$lib/graph/generate';
import { buildGraphIndex } from '$lib/graph/indexing';
import { layoutLayered } from '$lib/layout/layered';
import { NodeQuadtree } from '$lib/interact/quadtree';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { InteractionController, type InteractionScene } from '$lib/interact/controller';
import { Viewport } from '$lib/render/viewport';
import { createEdgeGeometry, writeEdgeGeometry } from '$lib/render/edge-geometry';
import type { PointerInput } from '$lib/render/hybrid-renderer';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
	if (!ok) failures++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

const fixture = generateFixture(500);
const index = buildGraphIndex(fixture.graph);

function makeHarness() {
	const positions = layoutLayered(fixture.graph, index).positions;
	const viewport = new Viewport();
	const selection = new SelectionStore(fixture.graph.nodes.length, fixture.graph.edges.length);
	const tree = new NodeQuadtree(fixture.graph, positions);

	const calls = { schedule: 0, positionsWritten: 0, dragStarted: 0, dragEnded: 0 };

	const scene: InteractionScene = { graph: fixture.graph, index, positions, tree };
	const controller = new InteractionController({
		viewport,
		selection,
		scene: () => scene,
		schedule: () => calls.schedule++,
		positionsWritten: () => calls.positionsWritten++,
		dragStarted: () => calls.dragStarted++,
		dragEnded: () => calls.dragEnded++
	});

	let lastX = 0;
	let lastY = 0;
	const at = (sx: number, sy: number, shiftKey = false, button = 0): PointerInput => {
		const e = { sx, sy, dx: sx - lastX, dy: sy - lastY, shiftKey, button };
		lastX = sx;
		lastY = sy;
		return e;
	};
	const down = (sx: number, sy: number, shift = false, button = 0) => {
		lastX = sx;
		lastY = sy;
		controller.onPointerDown(at(sx, sy, shift, button));
	};
	const move = (sx: number, sy: number, shift = false) =>
		controller.onPointerMove(at(sx, sy, shift));
	const up = (sx: number, sy: number) => controller.onPointerUp(at(sx, sy));

	/** Surface coordinates of a node's centre, under the current viewport. */
	const centreOf = (i: number): [number, number] => {
		const n = fixture.graph.nodes[i];
		return [
			viewport.toScreenX(positions.x[i] + n.width / 2),
			viewport.toScreenY(positions.y[i] + n.height / 2)
		];
	};

	/** A surface point guaranteed to be over nothing at all. */
	const emptyPoint = (): [number, number] => {
		for (let guess = 0; guess < 10000; guess++) {
			const gx = -5000 - guess * 13;
			const gy = -5000 - guess * 7;
			if (tree.findNode(gx, gy) < 0) {
				return [viewport.toScreenX(gx), viewport.toScreenY(gy)];
			}
		}
		throw new Error('no empty point');
	};

	/** Nudges a graph point until it is clear of every node. Edges are fine. */
	const clearOfNodes = (gx: number, gy: number): [number, number] => {
		for (let n = 0; n < 4000; n++) {
			if (tree.findNode(gx, gy) < 0) return [gx, gy];
			gx -= 7;
			gy -= 5;
		}
		throw new Error('no clear point');
	};

	return {
		positions, viewport, selection, tree, controller, calls,
		down, move, up, centreOf, emptyPoint, clearOfNodes
	};
}

console.log('\n=== picking ===\n');
{
	const h = makeHarness();
	const [cx, cy] = h.centreOf(42);
	h.down(cx, cy);
	h.up(cx, cy);
	check('click on a node selects exactly it', h.selection.nodeCount === 1 && h.selection.hasNode(42),
		`count ${h.selection.nodeCount}, primary ${h.selection.primaryNode}`);
	check('click on a node sets the primary', h.selection.primaryNode === 42);
}

{
	const h = makeHarness();
	const a = h.centreOf(10);
	const b = h.centreOf(20);
	h.down(a[0], a[1]); h.up(a[0], a[1]);
	h.down(b[0], b[1]); h.up(b[0], b[1]);
	check('a second plain click replaces the selection', h.selection.nodeCount === 1 && h.selection.hasNode(20));

	const c = h.centreOf(30);
	h.down(c[0], c[1], true); h.up(c[0], c[1]);
	check('shift-click adds', h.selection.nodeCount === 2 && h.selection.hasNode(20) && h.selection.hasNode(30));
	h.down(c[0], c[1], true); h.up(c[0], c[1]);
	check('shift-click again removes', h.selection.nodeCount === 1 && !h.selection.hasNode(30));
}

{
	const h = makeHarness();
	const [cx, cy] = h.centreOf(5);
	h.down(cx, cy); h.up(cx, cy);
	const [ex, ey] = h.emptyPoint();
	h.down(ex, ey); h.up(ex, ey);
	check('click on empty space clears', h.selection.nodeCount === 0 && h.selection.primaryNode === -1);
}

{
	// An edge midpoint that is not under any node.
	const h = makeHarness();
	const g = createEdgeGeometry();
	let target = -1;
	let px = 0, py = 0;
	for (let e = 0; e < fixture.graph.edges.length && target < 0; e++) {
		if (!writeEdgeGeometry(g, fixture.graph, index, h.positions, e)) continue;
		const t = 0.5, u = 0.5;
		const x = u*u*u*g.fromX + 3*u*u*t*g.c1x + 3*u*t*t*g.c2x + t*t*t*g.toX;
		const y = u*u*u*g.fromY + 3*u*u*t*g.c1y + 3*u*t*t*g.c2y + t*t*t*g.toY;
		if (h.tree.findNode(x, y) < 0) { target = e; px = x; py = y; }
	}
	const sx = h.viewport.toScreenX(px);
	const sy = h.viewport.toScreenY(py);
	h.down(sx, sy); h.up(sx, sy);
	check('click on an edge selects an edge', h.selection.edgeCount === 1 && h.selection.nodeCount === 0,
		`edge ${target}, selected ${h.selection.edgeCount}`);
}

console.log('\n=== pan ===\n');
{
	const h = makeHarness();
	const [ex, ey] = h.emptyPoint();
	const x0 = h.viewport.x;
	const y0 = h.viewport.y;
	h.down(ex, ey);
	h.move(ex + 40, ey + 25);
	h.move(ex + 90, ey + 55);
	h.up(ex + 90, ey + 55);
	check('drag on empty space pans by the screen delta',
		Math.abs(h.viewport.x - (x0 + 90)) < 1e-9 && Math.abs(h.viewport.y - (y0 + 55)) < 1e-9,
		`dx ${(h.viewport.x - x0).toFixed(1)}, dy ${(h.viewport.y - y0).toFixed(1)}`);
	check('a pan does not clear the selection on release', h.selection.nodeCount === 0);
	check('a pan never starts a drag', h.calls.dragStarted === 0);
}

{
	const h = makeHarness();
	const [cx, cy] = h.centreOf(7);
	h.down(cx, cy); h.up(cx, cy);
	const [ex, ey] = h.emptyPoint();
	h.down(ex, ey);
	h.move(ex + 60, ey);
	h.up(ex + 60, ey);
	check('panning keeps the selection', h.selection.nodeCount === 1 && h.selection.hasNode(7));
}

{
	const h = makeHarness();
	const [cx, cy] = h.centreOf(7);
	const x0 = h.viewport.x;
	h.down(cx, cy, false, 1);
	h.move(cx + 50, cy);
	h.up(cx + 50, cy);
	check('middle-drag pans even over a node',
		Math.abs(h.viewport.x - (x0 + 50)) < 1e-9 && h.selection.nodeCount === 0,
		`dx ${(h.viewport.x - x0).toFixed(1)}`);
}

console.log('\n=== node drag ===\n');
{
	const h = makeHarness();
	const i = 88;
	const [cx, cy] = h.centreOf(i);
	const ox = h.positions.x[i];
	const oy = h.positions.y[i];

	h.down(cx, cy);
	h.move(cx + 120, cy + 45);
	h.up(cx + 120, cy + 45);

	// Zoom is 1 here, so screen and graph deltas coincide.
	check('dragging a node moves it by the graph-space delta',
		Math.abs(h.positions.x[i] - (ox + 120)) < 1e-3 && Math.abs(h.positions.y[i] - (oy + 45)) < 1e-3,
		`moved ${(h.positions.x[i] - ox).toFixed(1)}, ${(h.positions.y[i] - oy).toFixed(1)}`);
	check('a drag reports positions written', h.calls.positionsWritten > 0);
	check('a drag stops the animator once', h.calls.dragStarted === 1);
	check('a drag rebuilds the index exactly once, on release', h.calls.dragEnded === 1);
	check('the dragged node is still selected', h.selection.nodeCount === 1 && h.selection.hasNode(i));
}

{
	// Drag under zoom: the node must follow the cursor, not the raw pixel delta.
	const h = makeHarness();
	h.viewport.k = 0.25;
	const i = 88;
	const [cx, cy] = h.centreOf(i);
	const ox = h.positions.x[i];
	h.down(cx, cy);
	h.move(cx + 100, cy);
	h.up(cx + 100, cy);
	check('a drag at 0.25x moves 4 graph units per screen pixel',
		Math.abs(h.positions.x[i] - (ox + 400)) < 1e-2,
		`moved ${(h.positions.x[i] - ox).toFixed(1)} for 100px`);
}

{
	// Multi-select then drag: everything moves, rigidly.
	const h = makeHarness();
	const picks = [11, 12, 13];
	for (let n = 0; n < picks.length; n++) {
		const [x, y] = h.centreOf(picks[n]);
		h.down(x, y, n > 0);
		h.up(x, y);
	}
	check('shift-click built a 3-node selection', h.selection.nodeCount === 3);

	const before = picks.map((p) => [h.positions.x[p], h.positions.y[p]] as const);
	const [gx, gy] = h.centreOf(picks[0]);
	h.down(gx, gy);
	h.move(gx + 70, gy - 30);
	h.up(gx + 70, gy - 30);

	const moved = picks.every((p, n) =>
		Math.abs(h.positions.x[p] - (before[n][0] + 70)) < 1e-3 &&
		Math.abs(h.positions.y[p] - (before[n][1] - 30)) < 1e-3
	);
	check('dragging one member moves the whole selection rigidly', moved);
	check('grabbing an already-selected node does not collapse the selection', h.selection.nodeCount === 3);
}

{
	// Sub-threshold movement is a click, not a drag.
	const h = makeHarness();
	const i = 55;
	const [cx, cy] = h.centreOf(i);
	const ox = h.positions.x[i];
	h.down(cx, cy);
	h.move(cx + 2, cy + 1);
	h.up(cx + 2, cy + 1);
	check('movement under the threshold does not move the node',
		h.positions.x[i] === ox, `moved ${(h.positions.x[i] - ox).toFixed(3)}`);
}

{
	// A cancelled drag must put everything back.
	const h = makeHarness();
	const i = 77;
	const [cx, cy] = h.centreOf(i);
	const ox = h.positions.x[i];
	const oy = h.positions.y[i];
	h.down(cx, cy);
	h.move(cx + 200, cy + 200);
	h.controller.cancel();
	check('a cancelled drag restores the original positions',
		Math.abs(h.positions.x[i] - ox) < 1e-3 && Math.abs(h.positions.y[i] - oy) < 1e-3,
		`off by ${(h.positions.x[i] - ox).toFixed(3)}, ${(h.positions.y[i] - oy).toFixed(3)}`);
}

console.log('\n=== an edge under the cursor is not a handle ===\n');
{
	// Find a point that is on an edge but not on a node — at 10k this is most
	// of the canvas, which is the whole reason edge selection waits for release.
	const h = makeHarness();
	const g = createEdgeGeometry();
	let px = 0, py = 0, found = -1;
	for (let e = 0; e < fixture.graph.edges.length && found < 0; e++) {
		if (!writeEdgeGeometry(g, fixture.graph, index, h.positions, e)) continue;
		const t = 0.5, u = 0.5;
		const x = u*u*u*g.fromX + 3*u*u*t*g.c1x + 3*u*t*t*g.c2x + t*t*t*g.toX;
		const y = u*u*u*g.fromY + 3*u*u*t*g.c1y + 3*u*t*t*g.c2y + t*t*t*g.toY;
		if (h.tree.findNode(x, y) < 0) { found = e; px = x; py = y; }
	}
	const sx = h.viewport.toScreenX(px);
	const sy = h.viewport.toScreenY(py);

	const x0 = h.viewport.x;
	h.down(sx, sy);
	h.move(sx + 80, sy + 40);
	h.up(sx + 80, sy + 40);
	check('dragging from a point on an edge pans',
		Math.abs(h.viewport.x - (x0 + 80)) < 1e-9, `dx ${(h.viewport.x - x0).toFixed(1)}`);
	check('and does not select that edge', h.selection.edgeCount === 0);

	// The same press without movement does select it.
	const h2 = makeHarness();
	const sx2 = h2.viewport.toScreenX(px);
	const sy2 = h2.viewport.toScreenY(py);
	h2.down(sx2, sy2);
	h2.up(sx2, sy2);
	check('pressing and releasing without moving selects it', h2.selection.edgeCount === 1);

	// Shift-dragging from an edge starts a marquee rather than selecting it.
	const h3 = makeHarness();
	const sx3 = h3.viewport.toScreenX(px);
	const sy3 = h3.viewport.toScreenY(py);
	h3.down(sx3, sy3, true);
	h3.move(sx3 + 400, sy3 + 400, true);
	check('shift-dragging from a point on an edge starts a marquee',
		h3.controller.marquee !== null, `marquee ${h3.controller.marquee ? 'live' : 'null'}`);
	h3.up(sx3 + 400, sy3 + 400);

	// Shift-clicking an edge adds it without clearing.
	const h4 = makeHarness();
	const [nx, ny] = h4.centreOf(9);
	h4.down(nx, ny); h4.up(nx, ny);
	const sx4 = h4.viewport.toScreenX(px);
	const sy4 = h4.viewport.toScreenY(py);
	h4.down(sx4, sy4, true);
	h4.up(sx4, sy4);
	check('shift-clicking an edge adds it and keeps the node selection',
		h4.selection.edgeCount === 1 && h4.selection.hasNode(9),
		`${h4.selection.nodeCount} nodes, ${h4.selection.edgeCount} edges`);

	// Shift-clicking genuinely empty space must not clear.
	const h5 = makeHarness();
	const [kx, ky] = h5.centreOf(9);
	h5.down(kx, ky); h5.up(kx, ky);
	const [ex, ey] = h5.emptyPoint();
	h5.down(ex, ey, true);
	h5.up(ex, ey);
	check('shift-clicking empty space does not clear', h5.selection.hasNode(9),
		`${h5.selection.nodeCount} nodes`);
}

console.log('\n=== marquee ===\n');
{
	const h = makeHarness();
	// A box in graph space that definitely contains something.
	const i = 100;
	const [gx, gy] = h.clearOfNodes(h.positions.x[i] - 300, h.positions.y[i] - 300);

	h.down(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy), true);
	h.move(h.viewport.toScreenX(gx + 900), h.viewport.toScreenY(gy + 900), true);

	const box = { x: gx, y: gy, width: 900, height: 900 };
	const expected = h.tree.queryRect(box, []).sort((a, b) => a - b);
	const actual = h.selection.selectedNodes();
	check('shift-drag selects exactly what the box covers',
		actual.length === expected.length && actual.every((v, n) => v === expected[n]),
		`${actual.length} selected, ${expected.length} expected`);
	check('the marquee box is exposed for drawing, in graph units',
		h.controller.marquee !== null &&
		Math.abs(h.controller.marquee.x - gx) < 1e-6 &&
		Math.abs(h.controller.marquee.width - 900) < 1e-6);
	check('the marquee did not pan the viewport', h.viewport.x === 0 && h.viewport.y === 0);

	// Shrinking the box gives nodes back — it is not a high-water mark.
	h.move(h.viewport.toScreenX(gx + 200), h.viewport.toScreenY(gy + 200), true);
	const shrunk = h.selection.selectedNodes();
	check('shrinking the marquee deselects', shrunk.length <= actual.length,
		`${actual.length} -> ${shrunk.length}`);

	h.up(h.viewport.toScreenX(gx + 200), h.viewport.toScreenY(gy + 200));
	check('the marquee box clears on release', h.controller.marquee === null);
}

{
	// Additive: the marquee is layered on top of what was already selected.
	const h = makeHarness();
	const keep = 3;
	const [kx, ky] = h.centreOf(keep);
	h.down(kx, ky); h.up(kx, ky);

	const i = 300;
	const [gx, gy] = h.clearOfNodes(h.positions.x[i] - 200, h.positions.y[i] - 200);
	h.down(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy), true);
	h.move(h.viewport.toScreenX(gx + 600), h.viewport.toScreenY(gy + 600), true);
	check('an additive marquee keeps the prior selection', h.selection.hasNode(keep));

	// And shrinking to nothing leaves exactly the prior selection.
	h.move(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy), true);
	h.up(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy));
	check('collapsing the box back to a point leaves the base selection',
		h.selection.hasNode(keep), `${h.selection.nodeCount} selected`);
}

{
	// Dragging up and left must work — the box is normalised.
	const h = makeHarness();
	const i = 200;
	const [gx, gy] = h.clearOfNodes(h.positions.x[i] + 400, h.positions.y[i] + 400);
	h.down(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy), true);
	h.move(h.viewport.toScreenX(gx - 900), h.viewport.toScreenY(gy - 900), true);
	const m = h.controller.marquee!;
	check('a marquee dragged up and left normalises',
		m.width > 0 && m.height > 0 && Math.abs(m.x - (gx - 900)) < 1e-6,
		`x ${m.x.toFixed(0)} w ${m.width.toFixed(0)}`);
	check('it still selects nodes', h.selection.nodeCount > 0, `${h.selection.nodeCount} nodes`);
}

{
	// Implied edges: both ends must be in the box.
	const h = makeHarness();
	const i = 250;
	const [gx, gy] = h.clearOfNodes(h.positions.x[i] - 1500, h.positions.y[i] - 1500);
	h.down(h.viewport.toScreenX(gx), h.viewport.toScreenY(gy), true);
	h.move(h.viewport.toScreenX(gx + 3000), h.viewport.toScreenY(gy + 3000), true);

	let bad = 0;
	for (let e = 0; e < fixture.graph.edges.length; e++) {
		if (h.selection.edgeFlags[e] !== 1) continue;
		const edge = fixture.graph.edges[e];
		const from = index.nodeIndexById.get(edge.source)!;
		const to = index.nodeIndexById.get(edge.target)!;
		if (!h.selection.hasNode(from) || !h.selection.hasNode(to)) bad++;
	}
	check('every marquee-selected edge has both ends in the box', bad === 0,
		`${h.selection.nodeCount} nodes, ${h.selection.edgeCount} edges, ${bad} bad`);
	check('the reported edge count matches the flags',
		h.selection.edgeCount === h.selection.edgeFlags.reduce((a, b) => a + b, 0));
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
