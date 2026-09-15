/**
 * Deterministic PRNG (mulberry32).
 *
 * Fixtures must be reproducible: phase 9 asserts on quadtree and layout output,
 * and comparing HUD numbers across runs is meaningless if the graph differs each
 * time. `Math.random()` would make every measurement in this project anecdotal.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return function next(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Integer in [min, max]. */
export function randInt(rng: Rng, min: number, max: number): number {
	return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)] as T;
}

/**
 * Picks an index from a list of weights. Used for status distributions and
 * node-kind mixes, where "70% running" should mean exactly that.
 */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
	let total = 0;
	for (const w of weights) total += w;
	let r = rng() * total;
	for (let i = 0; i < weights.length; i++) {
		r -= weights[i] as number;
		if (r <= 0) return i;
	}
	return weights.length - 1;
}
