import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

/**
 * jsdom implements no layout and no canvas, which is fine — the component tests
 * here are about *structure* (which elements exist, what they are labelled,
 * which one has focus), never about pixels. Everything about pixels is either a
 * pure-maths unit test or a Playwright assertion in a real browser.
 *
 * These three stubs are the minimum needed for a component that shares a page
 * with the renderer to mount at all.
 */

// The renderer asks for a 2D context. Returning null is honest — jsdom has no
// canvas — and HybridRenderer already handles a null context by not drawing.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

if (!globalThis.ResizeObserver) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as never;
}

// jsdom reports 0 for every measurement, so a component that scrolls needs to be
// told how tall its viewport is. Tests that care set clientHeight explicitly.
afterEach(() => cleanup());
