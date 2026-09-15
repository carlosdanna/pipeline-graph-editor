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
import { SVG_NODE_LIMIT } from '$lib/render/limits';

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
 * Above this many nodes we do not animate, because we do not draw either.
 * Tied to the render limit on purpose: tweening positions nobody can see is
 * pure cost.
 */
export const ANIMATE_NODE_LIMIT = SVG_NODE_LIMIT;

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
	/**
	 * Bumped only when the graph has settled. The phase 2 viewport is derived
	 * from graph bounds, and recomputing it every animation frame would rescale
	 * the view in lockstep with the nodes — which makes moving nodes look
	 * stationary, hiding the exact thing the animation exists to show.
	 */
	viewVersion = $state(0);
	layoutPhase = $state<LayoutPhase>('placeholder');
	layoutError = $state<string | null>(null);
	lastRun = $state.raw<LayoutRun | null>(null);
	benchmark = $state.raw<readonly BenchmarkRow[]>([]);
	benchmarkRunning = $state(false);

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
		this.viewVersion++;
		this.layoutPhase = 'placeholder';
		this.lastRun = null;
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
			this.#animator.start(positions, targets, (done) => {
				this.positionsVersion++;
				if (done) this.viewVersion++;
			});
		} else {
			snapTo(positions, targets);
			this.positionsVersion++;
			this.viewVersion++;
		}
	}

	dispose(): void {
		this.#animator.stop();
		this.#client.dispose();
	}
}
