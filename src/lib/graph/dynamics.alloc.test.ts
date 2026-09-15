import { describe, expect, it } from 'vitest';
import { DynamicsStore } from './dynamics.svelte';

describe('eager cell allocation', () => {
	it('costs little enough to do at fixture load', () => {
		const results: string[] = [];

		for (const count of [500, 2000, 10_000]) {
			const times: number[] = [];
			for (let r = 0; r < 9; r++) {
				const t0 = performance.now();
				new DynamicsStore(count);
				times.push(performance.now() - t0);
			}
			times.sort((a, b) => a - b);
			results.push(`${count} nodes: ${times[4].toFixed(3)} ms`);
			// Generous, because CI machines vary — the point is the order of
			// magnitude against a 40 ms generate and a multi-second layout.
			expect(times[4]).toBeLessThan(50);
		}

		console.log('  cell allocation (real signals): ' + results.join(', '));
	});
});
