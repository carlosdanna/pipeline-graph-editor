import { NODE_STATUSES, type DataType, type NodeKind, type NodeStatus } from '$lib/graph/types';

/**
 * Colours live in TypeScript rather than CSS custom properties because from
 * phase 3 onward most of them are consumed by canvas draw calls, which cannot
 * read CSS variables without a `getComputedStyle` round trip — exactly the kind
 * of layout read that must not happen in a render loop.
 */

export const PALETTE = {
	background: '#0e1218',
	surface: '#161c25',
	surfaceRaised: '#1d2531',
	border: '#2a3442',
	text: '#c9d4e2',
	textMuted: '#7d8a9c',
	grid: '#1a212b'
} as const;

export const KIND_COLOR: Record<NodeKind, string> = {
	source: '#4fb3ff',
	transform: '#9d7bff',
	filter: '#f5a524',
	aggregate: '#2fd4a7',
	sink: '#ff7a90'
};

export const STATUS_COLOR: Record<NodeStatus, string> = {
	idle: '#6b7785',
	running: '#34d399',
	degraded: '#fbbf24',
	failed: '#f87171'
};

/**
 * The same colours indexed by position in `NODE_STATUSES`.
 *
 * Status is stored as a byte in `DynamicsStore`, so the canvas draw loop would
 * otherwise have to turn that byte back into a string on every visible node,
 * every frame, purely to index a record.
 */
export const STATUS_COLORS: readonly string[] = NODE_STATUSES.map((s) => STATUS_COLOR[s]);

export const DATA_TYPE_COLOR: Record<DataType, string> = {
	records: '#5b84b1',
	events: '#8a76c4',
	metrics: '#2f9f84',
	errors: '#c2635e'
};

/**
 * Selection accents.
 *
 * Deliberately the same hue as the `source` node kind rather than a fifth
 * colour: selection is a transient state, and inventing a new colour for it
 * would compete with the four data-type colours that carry real information.
 */
export const SELECTION = {
	/** Ring drawn around a selected node, outside its bounds. */
	node: '#4fb3ff',
	/** A selected edge, drawn over the bucketed pass at full opacity. */
	edge: '#9ad4ff',
	marqueeFill: 'rgb(79 179 255 / 0.09)',
	marqueeStroke: '#4fb3ff'
} as const;

/** Compact rate, e.g. 1234 -> "1.2k/s". Used in node headers and, later, the table. */
export function formatThroughput(recordsPerSecond: number): string {
	if (recordsPerSecond <= 0) return '—';
	if (recordsPerSecond < 1000) return `${recordsPerSecond}/s`;
	if (recordsPerSecond < 1_000_000) return `${(recordsPerSecond / 1000).toFixed(1)}k/s`;
	return `${(recordsPerSecond / 1_000_000).toFixed(1)}M/s`;
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
