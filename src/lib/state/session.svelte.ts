import {
	FIXTURE_SIZES,
	generateFixture,
	type FixtureSize
} from '$lib/graph/generate';
import { buildGraphIndex, type GraphIndex } from '$lib/graph/indexing';
import { addDownstreamStage, pickUpstreamCandidate } from '$lib/graph/mutate';
import type { PositionStore } from '$lib/graph/positions';
import type { NodeDynamics, PipelineGraph } from '$lib/graph/types';
import { validateGraph, type ValidationResult } from '$lib/graph/validate';
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
import { HybridRenderer } from '$lib/render/hybrid-renderer';
import { DOM_NODE_LIMIT } from '$lib/render/limits';
import { PerfMonitor } from '$lib/render/perf.svelte';
import { Viewport } from '$lib/render/viewport';

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
	readonly dynamics: readonly NodeDynamics[];
	readonly index: GraphIndex;
	readonly validation: ValidationResult;
	readonly positions: PositionStore;
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
		dynamics: fixture.initialDynamics,
		index,
		validation: validateGraph(fixture.graph, index),
		positions: placeholder.positions,
		generationMs: fixture.generationMs,
		placeholderMs: placeholder.durationMs
	};
}

export class GraphSession {
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
	readonly renderer = new HybridRenderer(this.viewport, this.perf);

	#client = new LayoutClient();
	#animator = new PositionAnimator();

	get graph(): PipelineGraph {
		return this.fixture.graph;
	}

	get busy(): boolean {
		return this.layoutPhase === 'running' || this.benchmarkRunning;
	}

	async loadFixture(size: FixtureSize): Promise<void> {
		this.#animator.stop();
		this.fixture = buildFixtureState(size);
		this.positionsVersion++;
		this.layoutPhase = 'placeholder';
		this.lastRun = null;
		this.perf.layoutMs = null;
		// Frame the placeholder immediately; the real layout refits when it lands.
		this.renderer.requestFit();
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
		const mutation = addDownstreamStage(previous.graph, previous.dynamics, upstream);
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
			dynamics: mutation.dynamics,
			index,
			positions,
			validation: validateGraph(mutation.graph, index)
		};
		this.fixture = next;
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

	#apply(targets: PositionTargets, animate: boolean): void {
		const positions = this.fixture.positions;
		if (animate) {
			// `_done` is unused for now; phase 4 rebuilds the quadtree on it, once
			// the graph has settled rather than on every tween frame.
			this.#animator.start(positions, targets, (_done) => {
				// Schedule the canvas redraw directly rather than waiting for the
				// version bump to travel through Svelte and back; that would put
				// the canvas one frame behind the DOM node layer.
				this.renderer.schedule();
				this.positionsVersion++;
			});
		} else {
			snapTo(positions, targets);
			this.renderer.schedule();
			this.positionsVersion++;
		}
	}

	dispose(): void {
		this.#animator.stop();
		this.#client.dispose();
	}
}
