import type { EdgeAnchors } from '$lib/render/edge-anchors';
import { moveFocus, type Direction, type NavigationContext } from './navigate';

/**
 * Which nodes and edges the parallel accessible tree describes.
 *
 * The brief asks for a tree "kept in sync with what's drawn". Taken literally
 * that is the culled set — but at fit-to-screen with the 10,000-node fixture
 * *everything* is drawn, and a 10,000-item listbox is both the DOM explosion the
 * canvas exists to avoid and completely useless to read. So the tree is bounded,
 * and membership is chosen to keep it navigable rather than complete:
 *
 *  1. **The focused node**, always.
 *  2. **Everywhere the four arrow keys can go from it**, always. This is the
 *     load-bearing one: an arrow key must have an element to move focus *to*,
 *     and that element has to exist before the viewport pans to reveal it.
 *     Asking `moveFocus` rather than assuming it means one-hop neighbours is
 *     what makes this survive a change to the navigation model — and it had to,
 *     because up and down turned out to walk the layer rather than the
 *     neighbours, and a tree built from adjacency alone left 28% of arrow
 *     presses with nowhere to land.
 *  3. **Every node it connects to**, so the connection list has both ends of
 *     each described edge wherever possible.
 *  4. **On-screen nodes**, in index order, up to a limit.
 *
 * Nothing is unreachable as a result. A screen reader user navigates by
 * traversing edges, and every neighbour is always present, so the whole graph is
 * walkable one hop at a time however large it is — which is a better experience
 * than a flat list of ten thousand items would have been anyway.
 *
 * Edge endpoints come from `EdgeAnchors`, the same flat arrays the renderer and
 * the hit-tester use. Resolving them through the graph would mean a map lookup
 * per edge per frame in yet another place; phase 5 built these precisely so
 * there would be one answer to "what does this edge connect".
 */

/**
 * How many on-screen nodes the tree describes beyond the focused node and its
 * neighbours.
 *
 * Small enough to stay a usable list, large enough that a zoomed-in viewport is
 * usually described completely. Tunable, like the render limits.
 */
export const A11Y_NODE_LIMIT = 150;

export interface AccessibleTree {
	/** Node indices to render, ascending. */
	readonly nodes: number[];
	/** Edge indices to describe, ascending. */
	readonly edges: number[];
	/** How many nodes are on screen in total, described or not. */
	readonly visibleCount: number;
	/** True when the limit elided some on-screen nodes. */
	readonly truncated: boolean;
}

const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

export function buildAccessibleTree(
	ctx: NavigationContext,
	anchors: EdgeAnchors,
	visible: readonly number[],
	visibleCount: number,
	focused: number,
	limit: number = A11Y_NODE_LIMIT
): AccessibleTree {
	const { index } = ctx;
	const nodes = new Set<number>();

	// Focus, then everywhere it can go, then its neighbours — in that order, so
	// the things navigation depends on survive the limit.
	if (focused >= 0 && focused < index.outgoing.length) {
		nodes.add(focused);

		for (const direction of DIRECTIONS) {
			const target = moveFocus(ctx, focused, direction);
			if (target >= 0) nodes.add(target);
		}

		for (const e of index.outgoing[focused]) {
			const target = anchors.target[e];
			if (target >= 0) nodes.add(target);
		}
		for (const e of index.incoming[focused]) {
			const source = anchors.source[e];
			if (source >= 0) nodes.add(source);
		}
	}

	for (let i = 0; i < visible.length && nodes.size < limit; i++) nodes.add(visible[i]);

	const list = [...nodes].sort((a, b) => a - b);

	// Every edge with at least one end described. An edge whose other end is off
	// the tree is still worth announcing — it is how you learn there is
	// somewhere else to go.
	const edges = new Set<number>();
	for (const node of list) {
		for (const e of index.outgoing[node]) edges.add(e);
		for (const e of index.incoming[node]) edges.add(e);
	}

	// Truncated means on-screen nodes were left out, not that neighbours were
	// added — those are extra, and counting them would make the flag lie.
	let visibleDescribed = 0;
	for (let i = 0; i < visible.length; i++) if (nodes.has(visible[i])) visibleDescribed++;

	return {
		nodes: list,
		edges: [...edges].sort((a, b) => a - b),
		visibleCount,
		truncated: visibleDescribed < visibleCount
	};
}
