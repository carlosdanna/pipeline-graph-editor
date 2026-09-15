import {
	FIXTURE_SIZES,
	generateFixture,
	type FixtureSize
} from '$lib/graph/generate';
import { moveFocus as moveFocusTo, type NavigationContext } from '$lib/a11y/navigate';
import { actionFor, isFromTextInput } from '$lib/a11y/shortcuts';
import { DynamicsStore, statusIndex } from '$lib/graph/dynamics.svelte';
import { buildGraphIndex, computeLayers, type GraphIndex } from '$lib/graph/indexing';
import { addDownstreamStage, pickUpstreamCandidate } from '$lib/graph/mutate';
import type { PositionStore } from '$lib/graph/positions';
import type { NodeDynamics, PipelineGraph } from '$lib/graph/types';
import { validateGraph, type ValidationResult } from '$lib/graph/validate';
import {
	InteractionController,
	type InteractionHost,
	type InteractionScene
} from '$lib/interact/controller';
import { NodeQuadtree } from '$lib/interact/quadtree';
import { SelectionStore } from '$lib/interact/selection.svelte';
import { PositionAnimator, snapTo } from '$lib/layout/animate';
import { LayoutCancelledError, LayoutClient } from '$lib/layout/client';
import {
	dirtyRegion,
	fullLayoutTargets,
	incrementalTargets,
	type PositionTargets
} from '$lib/layout/incremental';
import { fullLayoutJob, regionLayoutJob } from '$lib/layout/jobs';
import { layoutLayered } from '$lib/layout/layered';
import { DEFAULT_PRESET, INCREMENTAL_OPTIONS, LAYOUT_PRESETS } from '$lib/layout/options';
import { buildEdgeAnchors, type EdgeAnchors } from '$lib/render/edge-anchors';
import { buildEdgeBuckets, type EdgeBuckets } from '$lib/render/edge-buckets';
import { HybridRenderer } from '$lib/render/hybrid-renderer';
import { DOM_NODE_LIMIT } from '$lib/render/limits';
import { PerfMonitor } from '$lib/render/perf.svelte';
import { VisibleNodes } from '$lib/render/visible.svelte';
import { Viewport } from '$lib/render/viewport';
import { UpdateBatcher } from '$lib/stream/batcher.svelte';
import { MockUpdateSource, UPDATE_RATES } from '$lib/stream/source';

/**
 * Everything the page knows about the current graph, and every operation that
 * can change it.
 *
 * Pulled out of the component because from phase 3 onward the renderer, the
 * hit-tester, the table pane and the accessibility tree all need to read this
 * same state, and threading a dozen props through would be worse than a single
 * object they can all be handed.
 */

/**
 * Above this many nodes a layout result snaps instead of tweening.
 *
 * Tied to the DOM node limit on purpose. Above it, nodes are not drawn at all
 * yet, and tweening the edges alone would animate a picture with no nodes in
 * it — motion that explains nothing.
 */
export const ANIMATE_NODE_LIMIT = DOM_NODE_LIMIT;

/** Cached once: a newly added stage starts idle. */
const IDLE_STATUS = statusIndex('idle');

export type LayoutPhase = 'placeholder' | 'running' | 'done' | 'error';

export interface LayoutRun {
	readonly mode: 'full' | 'incremental';
	readonly nodesLaidOut: number;
	readonly edgesLaidOut: number;
	readonly elkMs: number;
	readonly totalMs: number;
	readonly retried: boolean;
}

export interface BenchmarkRow {
	readonly size: number;
	readonly nodes: number;
	readonly edges: number;
	readonly elkMs: number | null;
	readonly totalMs: number | null;
	readonly retried: boolean;
	readonly error?: string;
}

/**
 * One immutable structural snapshot. Replaced wholesale on any structural
 * change; `positions` is the deliberate exception — the animator writes into
 * its Float32Arrays in place, and `positionsVersion` is what tells Svelte.
 */
interface FixtureState {
	readonly size: FixtureSize;
	readonly graph: PipelineGraph;
	/**
	 * The generator's starting telemetry. Only ever read once, to seed the live
	 * `DynamicsStore` — it is not the running state, and nothing renders from it.
	 */
	readonly initialDynamics: readonly NodeDynamics[];
	readonly index: GraphIndex;
	/**
	 * Layer per node. Used by keyboard navigation, where up and down walk the
	 * layer — see a11y/navigate.ts. Structural, so it is computed with the index
	 * and survives a drag, which grouping by x position would not.
	 */
	readonly layers: Int32Array;
	readonly validation: ValidationResult;
	readonly positions: PositionStore;
	/**
	 * Render caches derived from structure. Owned here rather than inside the
	 * component so the renderer and the hit-tester read the same arrays — and
	 * so they are rebuilt exactly when structure changes, which is the only
	 * time they can go stale.
	 */
	readonly anchors: EdgeAnchors;
	readonly buckets: EdgeBuckets;
	readonly generationMs: number;
	readonly placeholderMs: number;
}

function buildFixtureState(size: FixtureSize): FixtureState {
	const fixture = generateFixture(size);
	const index = buildGraphIndex(fixture.graph);
	// The naive column layout runs synchronously so there is something on screen
	// in the same frame the fixture loads, rather than an empty canvas for the
	// however-many seconds ELK takes.
	const placeholder = layoutLayered(fixture.graph, index);

	return {
		size,
		graph: fixture.graph,
		initialDynamics: fixture.initialDynamics,
		index,
		// A cyclic graph has no layering; one flat layer still gives a total order
		// for up and down, so navigation degrades rather than breaking.
		layers: computeLayers(fixture.graph, index) ?? new Int32Array(fixture.graph.nodes.length),
		validation: validateGraph(fixture.graph, index),
		positions: placeholder.positions,
		anchors: buildEdgeAnchors(fixture.graph, index),
		buckets: buildEdgeBuckets(fixture.graph),
		generationMs: fixture.generationMs,
		placeholderMs: placeholder.durationMs
	};
}

export class GraphSession implements InteractionHost {
	fixture = $state.raw<FixtureState>(buildFixtureState(50));
	/** Bumped whenever the animator writes into `fixture.positions`. */
	positionsVersion = $state(0);
	layoutPhase = $state<LayoutPhase>('placeholder');
	layoutError = $state<string | null>(null);
	lastRun = $state.raw<LayoutRun | null>(null);
	benchmark = $state.raw<readonly BenchmarkRow[]>([]);
	benchmarkRunning = $state(false);

	/**
	 * Viewport and renderer are plain, non-reactive objects: they are read by
	 * imperative draw code every frame and nothing in a template derives from
	 * them. The perf monitor is the bridge — it publishes a summary into
	 * `$state` a few times a second so the HUD can show it.
	 */
	readonly viewport = new Viewport();
	readonly perf = new PerfMonitor();
	/** Which nodes the DOM layer should render. Written by the frame loop. */
	readonly visibleNodes = new VisibleNodes();
	readonly renderer = new HybridRenderer(this.viewport, this.perf, this.visibleNodes);

	/**
	 * Selection is reactive only in its summary — the flag arrays behind it are
	 * read straight by the canvas. See selection.svelte.ts.
	 */
	readonly selection = new SelectionStore(
		this.fixture.graph.nodes.length,
		this.fixture.graph.edges.length
	);
	readonly interaction = new InteractionController(this);

	/**
	 * Live status and throughput. A single long-lived store rather than a field
	 * on the fixture snapshot, because the streaming source and the batcher hold
	 * references to it across fixture changes — and because it is emphatically
	 * not structure.
	 */
	readonly dynamics = DynamicsStore.from(this.fixture.initialDynamics);

	/**
	 * Updates in, one flush per frame out.
	 *
	 * `isVisible` reads the cull flags the renderer already maintains, which is
	 * what lets an off-screen update cost two array writes and stop there.
	 */
	readonly stream = new UpdateBatcher(this.dynamics, {
		isVisible: (index) => this.renderer.isVisible(index),
		repaint: () => this.renderer.repaintNodes()
	});

	readonly source = new MockUpdateSource((node, status, throughput) =>
		this.stream.queue(node, status, throughput)
	);

	streaming = $state(false);
	updateRate = $state<number>(UPDATE_RATES[0]);

	/**
	 * The node the keyboard is on, or -1.
	 *
	 * Separate from `selection.primaryNode` because moving focus must not select
	 * — otherwise arrowing across the graph would select every node on the way,
	 * and Enter would have nothing left to mean. They are kept in step from the
	 * other direction: a pointer pick moves focus, so an arrow key after a click
	 * continues from what was clicked.
	 */
	focusedNode = $state(-1);

	/** Build time of the current spatial index, for the stats strip. */
	treeBuildMs = $state<number | null>(null);

	/**
	 * Both default on. They exist so the phase 5 numbers can be compared against
	 * the phase 4 ones live in the HUD, which is what the phase asked for —
	 * turning culling off restores exactly the old draw loop, because "off" is
	 * an unbounded view rectangle rather than a second code path.
	 */
	cullingEnabled = $state(true);
	semanticZoomEnabled = $state(true);

	#client = new LayoutClient();
	#animator = new PositionAnimator();

	/**
	 * The spatial index for picking. Not reactive: it is read by pointer
	 * handlers and nothing in a template derives from it.
	 *
	 * Rebuilt only when the geometry has *settled* — after a layout animation
	 * finishes, after a snap, after a drag ends, and after a structural change.
	 * Never per animation frame: a 10k rebuild costs a whole frame budget, and
	 * nothing picks anything mid-animation anyway.
	 */
	#tree: NodeQuadtree | null = null;

	constructor() {
		this.renderer.setInput(this.interaction);
		this.renderer.setKeyHandler((event) => this.handleKey(event));
		this.#rebuildTree();
		this.source.reset(this.dynamics.status, this.dynamics.throughput);
	}

	// --- Streaming -----------------------------------------------------------

	toggleStream(): void {
		if (this.streaming) this.stopStream();
		else this.startStream();
	}

	startStream(): void {
		if (this.streaming) return;
		this.source.start();
		this.streaming = this.source.running;
	}

	stopStream(): void {
		this.source.stop();
		this.streaming = false;
		// Anything queued but not yet notified would otherwise sit dirty forever,
		// since nothing will schedule another flush.
		this.stream.flush();
	}

	setUpdateRate(rate: number): void {
		this.updateRate = rate;
		this.source.setRate(rate);
	}

	get graph(): PipelineGraph {
		return this.fixture.graph;
	}

	get busy(): boolean {
		return this.layoutPhase === 'running' || this.benchmarkRunning;
	}

	async loadFixture(size: FixtureSize): Promise<void> {
		this.#animator.stop();
		this.interaction.cancel();

		// The feed points at node indices, so it has to stop before they change
		// meaning. Restarted below once the new store is in place.
		const wasStreaming = this.streaming;
		this.stopStream();
		this.stream.reset();

		this.fixture = buildFixtureState(size);
		this.focusedNode = -1;
		this.dynamics.resize(this.fixture.graph.nodes.length);
		for (let i = 0; i < this.fixture.initialDynamics.length; i++) {
			const d = this.fixture.initialDynamics[i];
			this.dynamics.write(i, statusIndex(d.status), d.throughput);
		}
		this.stream.resize(this.fixture.graph.nodes.length);
		this.source.reset(this.dynamics.status, this.dynamics.throughput);
		this.selection.resize(this.fixture.graph.nodes.length, this.fixture.graph.edges.length);
		this.selection.clear();
		// Build against the placeholder layout so the graph is pickable in the
		// same frame it appears, rather than only once ELK answers.
		this.#rebuildTree();
		this.positionsVersion++;
		this.layoutPhase = 'placeholder';
		this.lastRun = null;
		this.perf.layoutMs = null;
		// Frame the placeholder immediately; the real layout refits when it lands.
		this.renderer.requestFit();
		if (wasStreaming) this.startStream();
		await this.runFullLayout();
	}

	async runFullLayout(): Promise<void> {
		const state = this.fixture;
		this.layoutPhase = 'running';
		this.layoutError = null;

		const job = fullLayoutJob(state.graph, state.index, LAYOUT_PRESETS[DEFAULT_PRESET]);

		try {
			const result = await this.#client.layout(job);
			// The fixture may have been swapped while ELK was working. The client
			// also cancels, so this is the second of two guards; both are cheap.
			if (this.fixture !== state) return;

			this.#apply(fullLayoutTargets(result), state.graph.nodes.length <= ANIMATE_NODE_LIMIT);
			// A full layout moves everything, so the old viewport is meaningless.
			// An incremental one deliberately does not refit — moving the view
			// under someone who just added a node is the opposite of stable.
			this.renderer.requestFit();
			this.perf.layoutMs = result.elkMs;
			this.lastRun = {
				mode: 'full',
				nodesLaidOut: job.nodeId.length,
				edgesLaidOut: job.edgeSource.length,
				elkMs: result.elkMs,
				totalMs: result.totalMs,
				retried: result.retried
			};
			this.layoutPhase = 'done';
		} catch (error) {
			if (error instanceof LayoutCancelledError) return;
			this.layoutError = error instanceof Error ? error.message : String(error);
			this.layoutPhase = 'error';
		}
	}

	/**
	 * Adds one stage downstream of a random existing node and lays out only the
	 * region around it. This is the stability demonstration: whatever the graph
	 * size, the layout job that follows contains a handful of nodes, and no
	 * existing node's position is written.
	 */
	async addStage(): Promise<void> {
		const previous = this.fixture;
		const upstream = pickUpstreamCandidate(previous.graph, previous.index, Math.random());
		const mutation = addDownstreamStage(previous.graph, upstream);
		if (mutation.addedIndices.length === 0) return;

		this.#animator.stop();

		const index = buildGraphIndex(mutation.graph);
		const positions = previous.positions.resized(mutation.graph.nodes.length);
		// Start the new node just downstream of its parent, so the animation has a
		// sensible origin instead of sliding in from (0, 0).
		const upstreamNode = previous.graph.nodes[upstream];
		for (const added of mutation.addedIndices) {
			positions.set(
				added,
				previous.positions.x[upstream] + upstreamNode.width + 120,
				previous.positions.y[upstream]
			);
		}

		const next: FixtureState = {
			...previous,
			graph: mutation.graph,
			index,
			layers: computeLayers(mutation.graph, index) ?? new Int32Array(mutation.graph.nodes.length),
			positions,
			anchors: buildEdgeAnchors(mutation.graph, index),
			buckets: buildEdgeBuckets(mutation.graph),
			validation: validateGraph(mutation.graph, index)
		};
		this.fixture = next;
		// Node and edge indices are append-only, so these keep every existing
		// selection and every live reading intact, and simply make room on the end.
		this.selection.resize(next.graph.nodes.length, next.graph.edges.length);
		this.dynamics.resize(next.graph.nodes.length);
		this.stream.resize(next.graph.nodes.length);
		// A stage that was just added has not processed anything yet.
		for (const added of mutation.addedIndices) this.dynamics.write(added, IDLE_STATUS, 0);
		this.source.reset(this.dynamics.status, this.dynamics.throughput);
		this.#rebuildTree();
		this.positionsVersion++;

		const region = dirtyRegion(next.graph, next.index, mutation.addedIndices);
		const job = regionLayoutJob(next.graph, next.index, next.positions, region, INCREMENTAL_OPTIONS);

		this.layoutPhase = 'running';
		this.layoutError = null;

		try {
			const result = await this.#client.layout(job);
			if (this.fixture !== next) return;

			this.#apply(incrementalTargets(result, region, next.positions), true);
			this.perf.layoutMs = result.elkMs;
			this.lastRun = {
				mode: 'incremental',
				nodesLaidOut: job.nodeId.length,
				edgesLaidOut: job.edgeSource.length,
				elkMs: result.elkMs,
				totalMs: result.totalMs,
				retried: result.retried
			};
			this.layoutPhase = 'done';
		} catch (error) {
			if (error instanceof LayoutCancelledError) return;
			this.layoutError = error instanceof Error ? error.message : String(error);
			this.layoutPhase = 'error';
		}
	}

	/** Full ELK layout for every fixture size, reported as it goes. */
	async runBenchmark(): Promise<void> {
		this.benchmarkRunning = true;
		this.benchmark = [];
		const rows: BenchmarkRow[] = [];

		for (const size of FIXTURE_SIZES) {
			const fixture = generateFixture(size);
			const index = buildGraphIndex(fixture.graph);
			const job = fullLayoutJob(fixture.graph, index, LAYOUT_PRESETS[DEFAULT_PRESET]);

			try {
				const result = await this.#client.layout(job);
				rows.push({
					size,
					nodes: fixture.graph.nodes.length,
					edges: fixture.graph.edges.length,
					elkMs: result.elkMs,
					totalMs: result.totalMs,
					retried: result.retried
				});
			} catch (error) {
				rows.push({
					size,
					nodes: fixture.graph.nodes.length,
					edges: fixture.graph.edges.length,
					elkMs: null,
					totalMs: null,
					retried: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
			this.benchmark = [...rows];
		}

		this.benchmarkRunning = false;
	}

	// --- InteractionHost -----------------------------------------------------
	//
	// The controller is handed this object rather than a dozen callbacks. Every
	// method here is one sentence long, which is the point: the session owns
	// *what exists*, the controller owns *what a gesture means*, and this is the
	// entire surface between them.

	scene(): InteractionScene | null {
		if (!this.#tree) return null;
		const state = this.fixture;
		return { positions: state.positions, anchors: state.anchors, tree: this.#tree };
	}

	schedule(): void {
		this.renderer.schedule();
	}

	setCulling(enabled: boolean): void {
		this.cullingEnabled = enabled;
		this.renderer.setCulling(enabled);
	}

	setSemanticZoom(enabled: boolean): void {
		this.semanticZoomEnabled = enabled;
		this.renderer.setSemanticZoom(enabled);
	}

	/**
	 * A drag wrote into the position arrays. The canvas is redrawn directly and
	 * the version counter is bumped for the DOM node layer — exactly what a
	 * layout tween does, because it is exactly the same kind of change: geometry
	 * moved, structure did not.
	 */
	positionsWritten(): void {
		this.renderer.schedule();
		this.positionsVersion++;
	}

	dragStarted(): void {
		// A layout tween and a pointer both writing the same Float32Array would
		// fight, and the tween would win every frame.
		this.#animator.stop();
	}

	dragEnded(): void {
		this.#rebuildTree();
	}

	nodePicked(index: number): void {
		this.focusedNode = index;
	}

	// --- Keyboard ------------------------------------------------------------

	/**
	 * Every shortcut, in one place. The mapping from key to intent lives in
	 * `shortcuts.ts` and is tested on its own; this is only what each intent does.
	 */
	handleKey(event: KeyboardEvent): void {
		if (isFromTextInput(event.target)) return;

		const action = actionFor(event);
		if (!action) return;
		event.preventDefault();

		switch (action.type) {
			case 'move':
				this.#moveFocus(action.direction);
				break;

			case 'select': {
				const target = this.#effectiveFocus();
				if (target < 0) return;
				if (action.additive) this.selection.toggleNode(target);
				else this.selection.selectNode(target, false);
				this.renderer.schedule();
				break;
			}

			case 'clear':
				this.selection.clear();
				this.renderer.schedule();
				break;

			case 'zoom':
				this.renderer.zoomAtCentre(action.factor);
				break;

			case 'fit':
				this.renderer.requestFit();
				break;
		}
	}

	/**
	 * Where an arrow key starts from.
	 *
	 * Falls back to the selection, then to the first node on screen, so the very
	 * first arrow press always does something visible rather than silently
	 * finding nothing to move from.
	 */
	#effectiveFocus(): number {
		if (this.focusedNode >= 0) return this.focusedNode;
		if (this.selection.primaryNode >= 0) return this.selection.primaryNode;
		return this.visibleNodes.indices[0] ?? (this.fixture.graph.nodes.length > 0 ? 0 : -1);
	}

	#moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void {
		const start = this.#effectiveFocus();
		if (start < 0) return;

		// The first press only establishes where focus is; it should not also
		// jump somewhere, or the graph moves before you have seen where you are.
		if (this.focusedNode < 0) {
			this.focusNode(start);
			return;
		}

		const next = moveFocusTo(this.navigationContext(), start, direction);
		// -1 means the end of a branch. Focus stays put rather than wrapping,
		// which at 10,000 nodes would teleport you with no way to notice.
		if (next >= 0) this.focusNode(next);
	}

	/** Everything keyboard navigation and the accessible tree need to read. */
	navigationContext(): NavigationContext {
		const state = this.fixture;
		return {
			graph: state.graph,
			index: state.index,
			positions: state.positions,
			layers: state.layers
		};
	}

	/** Moves keyboard focus to a node and brings it on screen. */
	focusNode(index: number): void {
		this.focusedNode = index;
		this.revealNode(index);
	}

	/**
	 * A row was clicked in the table.
	 *
	 * Half of the bidirectional selection: this selects and pans. The other half
	 * needs no code here at all — the table watches `selection.primaryNode`,
	 * which the canvas already sets, so picking on the canvas scrolls the list.
	 */
	selectFromTable(index: number, additive: boolean): void {
		if (additive) this.selection.toggleNode(index);
		else this.selection.selectNode(index, false);
		this.focusedNode = index;

		// Panning to a node that was just deselected would be confusing.
		if (this.selection.hasNode(index)) this.revealNode(index);
		this.renderer.schedule();
	}

	/** Centres the viewport on one node, without changing zoom. */
	revealNode(index: number): void {
		const state = this.fixture;
		const node = state.graph.nodes[index];
		if (!node) return;
		this.renderer.centreOn(
			state.positions.x[index] + node.width / 2,
			state.positions.y[index] + node.height / 2
		);
	}

	/** Frames the current selection, or the whole graph if nothing is selected. */
	fitSelection(): void {
		const state = this.fixture;
		if (this.selection.nodeCount === 0) {
			this.renderer.requestFit();
			return;
		}

		const flags = this.selection.nodeFlags;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (let i = 0; i < flags.length; i++) {
			if (flags[i] !== 1) continue;
			const node = state.graph.nodes[i];
			const x = state.positions.x[i];
			const y = state.positions.y[i];
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x + node.width > maxX) maxX = x + node.width;
			if (y + node.height > maxY) maxY = y + node.height;
		}

		this.renderer.fitTo({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
	}

	#rebuildTree(): void {
		const state = this.fixture;
		this.#tree = new NodeQuadtree(state.graph, state.positions);
		this.treeBuildMs = this.#tree.buildMs;
	}

	#apply(targets: PositionTargets, animate: boolean): void {
		const positions = this.fixture.positions;
		if (animate) {
			this.#animator.start(positions, targets, (done) => {
				// Schedule the canvas redraw directly rather than waiting for the
				// version bump to travel through Svelte and back; that would put
				// the canvas one frame behind the DOM node layer.
				this.renderer.schedule();
				this.positionsVersion++;
				// Only on the last frame: the index describes where things ended
				// up, and rebuilding it 25 times during a tween would cost more
				// than the tween.
				if (done) this.#rebuildTree();
			});
		} else {
			snapTo(positions, targets);
			this.renderer.schedule();
			this.positionsVersion++;
			this.#rebuildTree();
		}
	}

	dispose(): void {
		this.source.stop();
		this.#animator.stop();
		this.#client.dispose();
	}
}
