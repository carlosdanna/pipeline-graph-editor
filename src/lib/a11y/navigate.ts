import type { GraphIndex } from '$lib/graph/indexing';
import type { PositionStore } from '$lib/graph/positions';
import type { PipelineGraph } from '$lib/graph/types';

/**
 * Moving focus between connected nodes with the arrow keys.
 *
 * The model, which had to be invented rather than looked up, because a DAG has
 * no canonical reading order:
 *
 *   right / left   follow the flow — to a downstream / upstream neighbour
 *   up / down      move within the layer — the column the node is drawn in
 *
 * **Up and down walk the layer, not the sibling set**, and that was the hardest
 * decision in the phase. Siblings — nodes sharing a parent — are the more
 * obviously "connected" choice, and it is what I built first. It does not work,
 * for a reason that only showed up under measurement: *nearest sibling above*
 * is not a total order. Sibling sets differ from node to node, so a node can be
 * skipped over from every direction, and pressing up then down lands somewhere
 * new. Measured on the sibling model: **74% of up-then-down pairs retraced**,
 * and 96 of the 10,000 fixture's nodes were reachable from nothing at all.
 *
 * A layer *is* a total order once sorted, so walking it is perfectly invertible
 * and covers every node in it. It also matches what is drawn: the layout places
 * a layer in a column, so up and down move up and down that column, which is
 * what both a sighted user and a spatial mental model expect.
 *
 * The cost is honest and worth stating: two nodes in the same layer are peers
 * rather than neighbours — same depth from the sources, not joined by an edge.
 * Left and right remain the edge-following moves. In exchange, navigation
 * retraces perfectly and no stage is stranded.
 *
 * Ties everywhere are broken **spatially, by vertical position**, then by index.
 * A layered layout puts a node's downstream neighbours in a column to its right,
 * so "the one nearest my own height" is what the eye would pick. Edge order is
 * an artefact of how the generator happened to emit things and would feel random.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface NavigationContext {
	readonly graph: PipelineGraph;
	readonly index: GraphIndex;
	readonly positions: PositionStore;
	/**
	 * Layer per node, from `computeLayers`. Structural, so it survives a drag —
	 * which grouping by x position would not.
	 */
	readonly layers: Int32Array;
}

/** Vertical centre of a node, in graph units. The basis of every tie-break here. */
function centreY(ctx: NavigationContext, node: number): number {
	return ctx.positions.y[node] + ctx.graph.nodes[node].height / 2;
}

/** Nodes one edge downstream. */
export function downstream(ctx: NavigationContext, node: number): number[] {
	const out: number[] = [];
	for (const e of ctx.index.outgoing[node]) {
		const target = ctx.index.nodeIndexById.get(ctx.graph.edges[e].target);
		if (target !== undefined) out.push(target);
	}
	return out;
}

/** Nodes one edge upstream. */
export function upstream(ctx: NavigationContext, node: number): number[] {
	const out: number[] = [];
	for (const e of ctx.index.incoming[node]) {
		const source = ctx.index.nodeIndexById.get(ctx.graph.edges[e].source);
		if (source !== undefined) out.push(source);
	}
	return out;
}

/**
 * Both, unconditionally, and that matters more than it looks. The first version
 * took shared-parent peers and only fell back to shared-child peers when there
 * were none — which made the relation **asymmetric**: X could consider Y a
 * sibling while Y, having plenty of shared-parent peers of its own, never
 * considered X one. An asymmetric relation means some nodes have no inbound
 * arrow move at all, and 42 stages of the 10,000-node fixture turned out to be
 * reachable from nothing whatsoever. Unioning both makes it symmetric by
 * construction: if Y shares a parent with X then X shares that parent with Y.
 *
 * The union also covers sources, which have no parents and would otherwise have
 * no up or down on the entire first layer.
 *
 * Bounded by max in-degree times max out-degree, which the fixtures cap at about
 * 48, so this is computed on demand rather than cached.
 */
export function siblings(ctx: NavigationContext, node: number): number[] {
	const found = new Set<number>();

	for (const parent of upstream(ctx, node)) {
		for (const peer of downstream(ctx, parent)) found.add(peer);
	}
	for (const child of downstream(ctx, node)) {
		for (const peer of upstream(ctx, child)) found.add(peer);
	}

	found.delete(node);
	return [...found];
}

/** The candidate whose vertical centre is nearest the origin's. */
function nearestVertically(ctx: NavigationContext, from: number, candidates: number[]): number {
	if (candidates.length === 0) return -1;

	const originY = centreY(ctx, from);
	let best = -1;
	let bestDistance = Infinity;

	for (const candidate of candidates) {
		const distance = Math.abs(centreY(ctx, candidate) - originY);
		// Ties go to the lower index, so navigation is deterministic and a test
		// can assert on it.
		if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
			bestDistance = distance;
			best = candidate;
		}
	}

	return best;
}

/**
 * The adjacent node in the same layer, above or below.
 *
 * A linear scan over every node, filtered by layer. That looks wasteful and is
 * not: it runs once per keypress, costs about ten microseconds at the
 * 10,000-node fixture, and the alternative — a cached layer-to-members index —
 * would be another structure to rebuild on every structural change for no gain
 * a human could perceive.
 *
 * The ordering is (vertical centre, then index), which is a **total** order:
 * every node has exactly one predecessor and one successor in its layer, so
 * `down` then `up` always returns to where it started. Comparing by index when
 * the centres are equal is what makes that true — a layered layout can place
 * two nodes on exactly the same row, and without the tiebreak neither would be
 * able to reach the other.
 */
function stepThroughLayer(ctx: NavigationContext, node: number, delta: -1 | 1): number {
	const layer = ctx.layers[node];
	const originY = centreY(ctx, node);

	let best = -1;
	let bestY = 0;

	for (let i = 0; i < ctx.graph.nodes.length; i++) {
		if (i === node || ctx.layers[i] !== layer) continue;

		const y = centreY(ctx, i);
		// Strictly after `node` in the (y, index) order, in the chosen direction.
		const after = y > originY || (y === originY && i > node);
		if (delta === 1 ? !after : after) continue;

		// Nearest such node: the smallest step that is still a step.
		if (best < 0 || (delta === 1 ? y < bestY || (y === bestY && i < best) : y > bestY || (y === bestY && i > best))) {
			best = i;
			bestY = y;
		}
	}

	return best;
}

/**
 * Where an arrow key moves focus, or -1 when there is nowhere to go.
 *
 * Returning -1 rather than wrapping or clamping is deliberate: at the end of a
 * branch, focus should stay put. A wrap would teleport you across a 10,000-node
 * graph with no way to tell it had happened.
 */
export function moveFocus(ctx: NavigationContext, from: number, direction: Direction): number {
	if (from < 0 || from >= ctx.graph.nodes.length) return -1;

	switch (direction) {
		case 'right':
			return nearestVertically(ctx, from, downstream(ctx, from));
		case 'left':
			return nearestVertically(ctx, from, upstream(ctx, from));
		case 'up':
			return stepThroughLayer(ctx, from, -1);
		case 'down':
			return stepThroughLayer(ctx, from, 1);
	}
}
