import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
	]
});
