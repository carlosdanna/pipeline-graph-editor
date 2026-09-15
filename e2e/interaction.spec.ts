import { expect, test } from '@playwright/test';
import {
	centredNode,
	drag,
	hudNumber,
	layerTransform,
	loadFixture,
	selectedNodes,
	surface,
	zoomToFullDetail
} from './helpers';

/**
 * Pan, zoom and selection, in a real browser.
 *
 * Everything here is deliberately checked through something the user can see:
 * the shared transform on the node layer, the selection counter in the stats
 * strip, the HUD. Reaching into the app's internals would test that the
 * internals are what I think they are, which the unit tests already do.
 */

test.describe('pan and zoom', () => {
	test.beforeEach(async ({ page }) => loadFixture(page, 500));

	test('dragging the surface pans both layers together', async ({ page }) => {
		const before = await layerTransform(page);

		await drag(page, { x: 700, y: 400 }, { x: 900, y: 500 });

		const after = await layerTransform(page);
		expect(after).not.toBe(before);

		// The canvas and the DOM layer share one transform applied in one frame,
		// so a pan must not change the scale — only the translation.
		const scaleOf = (t: string) => t.match(/scale\(([^)]+)\)/)?.[1];
		expect(scaleOf(after)).toBe(scaleOf(before));
	});

	test('the wheel zooms and the HUD agrees', async ({ page }) => {
		const before = await hudNumber(page, 'zoom');

		await page.mouse.move(700, 400);
		await page.mouse.wheel(0, -600);
		await page.waitForTimeout(300);

		expect(await hudNumber(page, 'zoom')).toBeGreaterThan(before);

		await page.mouse.wheel(0, 1200);
		await page.waitForTimeout(300);
		expect(await hudNumber(page, 'zoom')).toBeLessThan(before);
	});

	test('zoom holds the graph point under the cursor', async ({ page }) => {
		// The defining property of zoom-toward-cursor. Measured through the
		// transform rather than through the viewport object: with
		// `screen = graph * k + translate`, the graph point under a fixed screen
		// position is `(screen - translate) / k`, and it must not move.
		const read = () =>
			page.locator('.node-layer').evaluate((el) => {
				const t = (el as HTMLElement).style.transform;
				const translate = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
				const scale = t.match(/scale\(([-\d.]+)\)/);
				return {
					x: Number(translate?.[1]),
					y: Number(translate?.[2]),
					k: Number(scale?.[1])
				};
			});

		const CURSOR_X = 820;
		const CURSOR_Y = 360;
		await page.mouse.move(CURSOR_X, CURSOR_Y);

		const before = await read();
		await page.mouse.wheel(0, -400);
		await page.waitForTimeout(300);
		const after = await read();

		expect(after.k).toBeGreaterThan(before.k);

		// The surface is not at the page origin, so compare in surface-local
		// coordinates by using the same offset on both sides.
		const box = (await surface(page).boundingBox())!;
		const sx = CURSOR_X - box.x;
		const sy = CURSOR_Y - box.y;

		expect((sx - after.x) / after.k).toBeCloseTo((sx - before.x) / before.k, 1);
		expect((sy - after.y) / after.k).toBeCloseTo((sy - before.y) / before.k, 1);
	});

	test('pressing 0 fits the whole graph', async ({ page }) => {
		await page.mouse.move(700, 400);
		await page.mouse.wheel(0, -1200);
		await page.waitForTimeout(300);
		const zoomedIn = await hudNumber(page, 'zoom');

		await surface(page).click({ position: { x: 5, y: 5 } });
		await page.keyboard.press('0');
		await page.waitForTimeout(300);

		expect(await hudNumber(page, 'zoom')).toBeLessThan(zoomedIn);
	});

	test('+ and - zoom about the centre', async ({ page }) => {
		await surface(page).click({ position: { x: 5, y: 5 } });

		const start = await hudNumber(page, 'zoom');
		await page.keyboard.press('+');
		await page.waitForTimeout(250);
		const zoomedIn = await hudNumber(page, 'zoom');
		expect(zoomedIn).toBeGreaterThan(start);

		await page.keyboard.press('-');
		await page.waitForTimeout(250);
		expect(await hudNumber(page, 'zoom')).toBeCloseTo(start, 3);
	});
});

test.describe('selection', () => {
	test.beforeEach(async ({ page }) => loadFixture(page, 500));

	test('clicking a node selects exactly one', async ({ page }) => {
		await zoomToFullDetail(page);
		const node = await centredNode(page);

		await page.mouse.click(node.x, node.y);
		await expect.poll(() => selectedNodes(page)).toBe(1);
	});

	test('clicking empty space clears the selection', async ({ page }) => {
		await zoomToFullDetail(page);
		const node = await centredNode(page);
		await page.mouse.click(node.x, node.y);
		await expect.poll(() => selectedNodes(page)).toBe(1);

		await surface(page).click({ position: { x: 4, y: 4 } });
		await expect.poll(() => selectedNodes(page)).toBe(0);
	});

	test('shift-dragging empty space marquees several nodes', async ({ page }) => {
		const box = (await surface(page).boundingBox())!;

		await drag(
			page,
			{ x: box.x + 60, y: box.y + 60 },
			{ x: box.x + box.width - 60, y: box.y + box.height - 60 },
			{ modifier: 'Shift' }
		);

		await expect.poll(() => selectedNodes(page)).toBeGreaterThan(1);
	});

	test('plain dragging empty space pans and selects nothing', async ({ page }) => {
		const before = await layerTransform(page);
		const box = (await surface(page).boundingBox())!;

		await drag(page, { x: box.x + 60, y: box.y + 60 }, { x: box.x + 260, y: box.y + 200 });

		expect(await layerTransform(page)).not.toBe(before);
		expect(await selectedNodes(page)).toBe(0);
	});

	test('selection is bidirectional between the canvas and the table', async ({ page }) => {
		await zoomToFullDetail(page);
		const node = await centredNode(page);
		const label = node.label.replace('…', '');

		await page.mouse.click(node.x, node.y);

		// The table scrolled to it and marked it selected.
		const row = page.locator('[role="row"][aria-selected="true"]');
		await expect(row).toHaveCount(1);
		await expect(row).toContainText(label.slice(0, 8));
	});

	test('clicking a table row selects and pans to the node', async ({ page }) => {
		const before = await layerTransform(page);

		// A row far down the list, so the pan is unmistakable.
		await page.locator('[role="grid"]').click();
		await page.keyboard.press('End');
		await page.waitForTimeout(200);

		const lastRow = page.locator('[role="row"][data-row]').last();
		await lastRow.click();

		await expect.poll(() => selectedNodes(page)).toBe(1);
		expect(await layerTransform(page)).not.toBe(before);
	});
});

test.describe('keyboard', () => {
	test.beforeEach(async ({ page }) => loadFixture(page, 500));

	test('arrow keys move focus between connected stages', async ({ page }) => {
		await surface(page).click({ position: { x: 4, y: 4 } });

		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(150);

		const focused = page.locator('[role="option"][tabindex="0"]');
		await expect(focused).toHaveCount(1);
		const first = await focused.getAttribute('data-node');

		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(150);
		expect(await focused.getAttribute('data-node')).not.toBe(first);
	});

	test('enter selects the focused stage and escape clears it', async ({ page }) => {
		await surface(page).click({ position: { x: 4, y: 4 } });
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(150);

		await page.keyboard.press('Enter');
		await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);

		await page.keyboard.press('Escape');
		await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
	});

	test('the graph is reachable by keyboard alone', async ({ page }) => {
		// No pointer at all: tab to the graph and drive it.
		await page.keyboard.press('Tab');
		for (let i = 0; i < 12; i++) {
			const reached = await page
				.locator('[role="option"]:focus')
				.count()
				.catch(() => 0);
			if (reached > 0) break;
			await page.keyboard.press('Tab');
		}

		await expect(page.locator('[role="option"]:focus')).toHaveCount(1);
	});
});

test.describe('the accessible tree stays in step with what is drawn', () => {
	test('describes the canvas even when nodes are not DOM elements', async ({ page }) => {
		await loadFixture(page, 10000);

		// Above the DOM limit there are no node elements at all...
		await expect(page.locator('.node-layer .node')).toHaveCount(0);
		// ...but the graph is still described, and still bounded.
		const options = page.locator('[role="option"]');
		expect(await options.count()).toBeGreaterThan(0);
		expect(await options.count()).toBeLessThan(250);
	});

	test('hides the visual layers from assistive technology', async ({ page }) => {
		await loadFixture(page, 500);
		await expect(page.locator('canvas')).toHaveAttribute('aria-hidden', 'true');
		await expect(page.locator('.node-layer')).toHaveAttribute('aria-hidden', 'true');
	});
});
