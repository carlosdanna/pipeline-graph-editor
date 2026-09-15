import { expect, test, type Page } from '@playwright/test';
import { hudNumber, loadFixture, surface } from './helpers';

/**
 * The frame budget at 2,000 nodes.
 *
 * Read off the app's own HUD rather than from a separate probe, because the HUD
 * is what the whole project has been tuned against and a second instrument
 * would only measure something adjacent. `frame` is the mean time inside the
 * draw call over the last publish window, and `worst` is the slowest single
 * draw in it — our JavaScript, not including the browser's rasterisation, which
 * is exactly what every number in NOTES.md means.
 *
 * Headless timings are noisier than a real session, so the budgets below are
 * the frame budget itself rather than the tight numbers NOTES records. A
 * regression that matters will blow through 16.7 ms; one that does not will
 * not, and a test that flakes gets ignored, which is worse than no test.
 */

const FRAME_BUDGET_MS = 16.7;

/** Pans continuously for a while, which is the most expensive thing the app does. */
async function panFor(page: Page, durationMs: number): Promise<void> {
	const box = (await surface(page).boundingBox())!;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;

	await page.mouse.move(cx, cy);
	await page.mouse.down();

	const started = Date.now();
	let step = 0;
	while (Date.now() - started < durationMs) {
		// A circle, so the viewport keeps moving over new material rather than
		// settling somewhere the culling has already warmed up.
		const angle = (step++ / 12) * Math.PI * 2;
		await page.mouse.move(cx + Math.cos(angle) * 220, cy + Math.sin(angle) * 140);
	}

	await page.mouse.up();
}

test.describe('2,000 nodes', () => {
	test('stays inside the frame budget while panning', async ({ page }) => {
		await loadFixture(page, 2000);
		await panFor(page, 1500);

		const mean = await hudNumber(page, 'frame');
		const worst = await hudNumber(page, 'worst');
		const fps = await hudNumber(page, 'fps');

		// eslint-disable-next-line no-console
		console.log(`  2,000 nodes panning: mean ${mean} ms, worst ${worst} ms, ${fps} fps`);

		expect(mean).toBeGreaterThan(0);
		expect(mean).toBeLessThan(FRAME_BUDGET_MS);
		// One slow frame is survivable; a consistently slow one is not.
		expect(worst).toBeLessThan(FRAME_BUDGET_MS * 2);
	});

	test('stays inside the budget with the feed running at 200 a second', async ({ page }) => {
		// Requirement 7: the graph must stay at 60fps while this runs.
		await loadFixture(page, 2000);
		await page.getByRole('button', { name: /start feed/ }).click();
		await page.waitForTimeout(500);

		await panFor(page, 1500);

		const mean = await hudNumber(page, 'frame');
		const updates = await hudNumber(page, 'updates');

		// eslint-disable-next-line no-console
		console.log(`  2,000 nodes + feed: mean ${mean} ms, ${updates} updates/s`);

		expect(updates).toBeGreaterThan(50);
		expect(mean).toBeLessThan(FRAME_BUDGET_MS);
	});

	test('draws far less than it holds, once culled', async ({ page }) => {
		// Not a timing assertion — a deterministic one. If culling silently stopped
		// working, the timings might still pass on a fast machine while the whole
		// of phase 5 had been undone.
		await loadFixture(page, 2000);

		await page.mouse.move(700, 450);
		await page.mouse.wheel(0, -900);
		await page.waitForTimeout(400);

		const nodes = await page.locator('[data-hud="nodes"] .value').innerText();
		const [visible, total] = nodes.split('/').map((part) => Number(part.replace(/[^\d]/g, '')));

		expect(total).toBe(2000);
		expect(visible).toBeLessThan(total / 2);
	});

	test('turning culling off makes it draw everything again', async ({ page }) => {
		await loadFixture(page, 2000);
		await page.mouse.move(700, 450);
		await page.mouse.wheel(0, -900);
		await page.waitForTimeout(400);

		await page.getByLabel('cull').uncheck();
		await page.waitForTimeout(400);

		const nodes = await page.locator('[data-hud="nodes"] .value').innerText();
		const [visible, total] = nodes.split('/').map((part) => Number(part.replace(/[^\d]/g, '')));
		expect(visible).toBe(total);
	});
});

test.describe('10,000 nodes', () => {
	test('falls back to canvas nodes and still pans within budget', async ({ page }) => {
		await loadFixture(page, 10000);

		// Above DOM_NODE_LIMIT there are no node elements at all.
		await expect(page.locator('.node-layer .node')).toHaveCount(0);
		await expect(page.locator('[data-hud="nodes-via"] .value')).toHaveText('canvas');

		await panFor(page, 1500);

		const mean = await hudNumber(page, 'frame');
		const worst = await hudNumber(page, 'worst');

		// eslint-disable-next-line no-console
		console.log(`  10,000 nodes panning: mean ${mean} ms, worst ${worst} ms`);

		expect(mean).toBeGreaterThan(0);
		expect(mean).toBeLessThan(FRAME_BUDGET_MS);
	});

	test('drops to coarser detail as it zooms out', async ({ page }) => {
		await loadFixture(page, 10000);

		// Fit-to-screen at this size is well below the dot threshold.
		await expect(page.locator('[data-hud="detail"] .value')).toHaveText('dot');

		await page.mouse.move(700, 450);
		await page.mouse.wheel(0, -3000);
		await page.waitForTimeout(500);

		const detail = await page.locator('[data-hud="detail"] .value').innerText();
		expect(['simple', 'full']).toContain(detail);
	});
});
