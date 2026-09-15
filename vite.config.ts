import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
// `vitest/config` rather than `vite`, so the `test` block below is typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes-only for our own source. Libraries in node_modules keep their own mode.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// SPA: every route is served from a single fallback document. Combined with
			// `ssr = false` in +layout.ts this gives us a pure client-side app, which is
			// what we want — the whole point here is browser rendering performance, and
			// a canvas/worker app has nothing useful to say on a server.
			adapter: adapter({ fallback: 'index.html', strict: false })
		})
	],

	test: {
		/*
		 * Two projects, because the tests fall into two genuinely different kinds.
		 *
		 * Most of this codebase is deliberately free of the DOM — the transform
		 * maths, the quadtree, the layout diff, the batcher, the virtual window,
		 * the keyboard navigation — and those run fastest and most honestly in
		 * plain Node. Only the components need jsdom, and jsdom is slow enough
		 * and different enough from a browser that it is worth confining.
		 *
		 * Both extend this config, so `$lib` resolves and `.svelte.ts` modules are
		 * compiled by the Svelte plugin. That matters more than it sounds: it
		 * means the runes stores are tested with *real* signals rather than with
		 * the `$state = identity` shim the tools/ benchmarks have to use.
		 */
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.dom.test.ts']
				}
			},
			{
				extends: './vite.config.ts',
				/*
				 * Without the browser condition, Vite hands these tests Svelte's
				 * *server* build and `mount()` throws — the components would be
				 * rendered to a string instead of to the document, which is the one
				 * thing this project exists to avoid.
				 */
				resolve: { conditions: ['browser'] },
				test: {
					name: 'dom',
					environment: 'jsdom',
					include: ['src/**/*.dom.test.ts'],
					setupFiles: ['./tests/setup-dom.ts']
				}
			}
		]
	}
});
