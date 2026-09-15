import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the **production build**, not the dev server.
 *
 * That matters here more than it usually would. The thing under test is frame
 * time, and the dev server serves hundreds of unbundled modules with a
 * different worker pipeline — measuring it would be measuring Vite. The build
 * is also where the elkjs worker chunk is emitted as its own file, which is the
 * arrangement phase 3 had to fight for.
 */
export default defineConfig({
	testDir: './e2e',
	// Frame-time assertions are meaningless when several browsers are competing
	// for the same cores.
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'dot' : 'list',
	/*
	 * A 10,000-node ELK layout takes the better part of five seconds, and some
	 * tests load a fixture, zoom, and then pan for a second and a half. The
	 * default 30s is not enough for that on a loaded machine.
	 */
	timeout: 120_000,

	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure'
	},

	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 }
			}
		}
	],

	webServer: {
		command: 'npm run build && npm run preview -- --port 4173',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
