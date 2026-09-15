<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Pipeline graph editor</title>
</svelte:head>

{@render children()}

<style>
	/*
	 * Global shell. Kept deliberately small: no component library, no reset
	 * beyond what this app actually needs. The palette is duplicated in
	 * src/lib/render/theme.ts because canvas draw calls cannot read CSS
	 * variables cheaply — see the note there.
	 */
	:global(:root) {
		--background: #0e1218;
		--surface: #161c25;
		--surface-raised: #1d2531;
		--border: #2a3442;
		--text: #c9d4e2;
		--text-muted: #7d8a9c;

		color-scheme: dark;
	}

	:global(html, body) {
		height: 100%;
		margin: 0;
		overflow: hidden;
		font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
		color: var(--text);
		background: var(--background);
	}

	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}
</style>
