import { expect, type Locator, type Page } from '@playwright/test';

/** Reads a value out of the perf HUD — the app's own instrument, not a shadow of it. */
export async function hud(page: Page, key: string): Promise<string> {
	return (await page.locator(`[data-hud="${key}"] .value`).innerText()).trim();
}

export async function hudNumber(page: Page, key: string): Promise<number> {
	const text = await hud(page, key);
	const match = text.match(/-?[\d.]+/);
	return match ? Number(match[0]) : NaN;
}

/** The graph surface. Every pointer gesture goes through it. */
export function surface(page: Page): Locator {
	return page.locator('.surface');
}

/** Fixture buttons are labelled with a thousands separator, so pick by position. */
const FIXTURE_ORDER = [50, 500, 2000, 10000];

/**
 * Loads a fixture and waits for the layout to settle, however it settles.
 *
 * Waits for *either* outcome rather than for success, because at 10,000 nodes
 * ELK does not succeed in a browser: it overflows the worker's stack, both warm
 * and on the fresh-worker retry. The app falls back to the placeholder layered
 * layout and carries on, so everything these tests are about — culling,
 * semantic zoom, the canvas fallback, picking — still works and is still worth
 * asserting. See NOTES.md, phase 9.
 *
 * Waiting for settlement at all matters because none of these tests should be
 * measuring the layout: a frame-time assertion taken while a worker is
 * saturating a core is a measurement of the worker.
 */
export async function loadFixture(page: Page, size: number): Promise<'elk' | 'placeholder'> {
	await page.goto('/');
	await page
		.locator('nav[aria-label="Fixture size"] button')
		.nth(FIXTURE_ORDER.indexOf(size))
		.click();

	const status = page.locator('header .status');
	await expect(status).toHaveAttribute('data-phase', /done|error/, { timeout: 120_000 });

	// One more frame so the refit has been applied and drawn.
	await page.waitForTimeout(400);
	return (await status.getAttribute('data-phase')) === 'done' ? 'elk' : 'placeholder';
}

/**
 * Zooms in until nodes are full-detail DOM elements.
 *
 * Needed by every test that wants to click a node element, because
 * fit-to-screen lands *below* the dot threshold at every fixture size — 0.177x
 * at 500 nodes, 0.021x at 10,000 — so the default view after loading a fixture
 * has no node elements at all. That is phase 5 working as specified rather than
 * a problem, but it caught me out writing these.
 */
export async function zoomToFullDetail(page: Page): Promise<void> {
	const box = (await surface(page).boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

	for (let i = 0; i < 40; i++) {
		const detail = await page.locator('[data-hud="detail"] .value').innerText();
		if (detail.trim() === 'full') break;
		await page.mouse.wheel(0, -400);
		await page.waitForTimeout(80);
	}

	await page.locator('.node-layer .node').first().waitFor({ timeout: 10_000 });
}

/**
 * A node element that is genuinely inside the surface, with its centre.
 *
 * Not `.first()`: the cull margin keeps nodes for 160px beyond the viewport
 * edge, so the lowest rendered index is often *off screen* and clicking its
 * centre clicks nothing. This picks the one nearest the middle of the surface,
 * which is unambiguously hittable.
 */
export async function centredNode(
	page: Page
): Promise<{ label: string; x: number; y: number }> {
	const box = (await surface(page).boundingBox())!;

	const found = await page.evaluate(
		({ left, top, width, height }) => {
			const cx = left + width / 2;
			const cy = top + height / 2;
			let best: { label: string; x: number; y: number } | null = null;
			let bestDistance = Infinity;

			for (const element of document.querySelectorAll('.node-layer .node')) {
				const rect = element.getBoundingClientRect();
				// Fully inside the surface, with a little room to spare.
				if (rect.left < left + 4 || rect.right > left + width - 4) continue;
				if (rect.top < top + 4 || rect.bottom > top + height - 4) continue;

				const x = rect.left + rect.width / 2;
				const y = rect.top + rect.height / 2;
				const distance = Math.hypot(x - cx, y - cy);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = {
						label: element.querySelector('.label')?.textContent?.trim() ?? '',
						x,
						y
					};
				}
			}
			return best;
		},
		{ left: box.x, top: box.y, width: box.width, height: box.height }
	);

	if (!found) throw new Error('no node element fully inside the surface');
	return found;
}

/**
 * How many nodes are selected, read from the table pane's footer.
 *
 * The footer is a single unambiguous number; the stats strip says "N nodes"
 * twice, once for the graph and once for the selection.
 */
export async function selectedNodes(page: Page): Promise<number> {
	const text = await page.locator('.pane footer').innerText();
	return Number(text.match(/(\d[\d,]*)\s+selected/)?.[1]?.replace(/,/g, '') ?? '-1');
}

/** The DOM node layer's transform, which is how a pan or zoom is observable. */
export async function layerTransform(page: Page): Promise<string> {
	return page.locator('.node-layer').evaluate((el) => (el as HTMLElement).style.transform);
}

/** Drags across the surface with the left button, in steps, like a real pan. */
export async function drag(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	options: { modifier?: 'Shift' } = {}
): Promise<void> {
	await page.mouse.move(from.x, from.y);
	if (options.modifier) await page.keyboard.down(options.modifier);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 20 });
	await page.mouse.up();
	if (options.modifier) await page.keyboard.up(options.modifier);
}
