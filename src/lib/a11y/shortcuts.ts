import type { Direction } from './navigate';

/**
 * Keyboard shortcuts, as a pure mapping from a key to an intent.
 *
 * Separated from the component so the whole shortcut table can be asserted
 * without a DOM — including the awkward cases, which are most of them. Key
 * handling looks trivial and then you discover that `+` is Shift and `=` on a
 * US layout, that Firefox still reports `Add` from the numeric keypad, and that
 * swallowing Ctrl and Meta breaks the browser's own zoom and the user's
 * expectations at the same time.
 */

export type GraphAction =
	| { readonly type: 'move'; readonly direction: Direction }
	| { readonly type: 'select'; readonly additive: boolean }
	| { readonly type: 'clear' }
	| { readonly type: 'zoom'; readonly factor: number }
	| { readonly type: 'fit' };

/** One press of `+` or `-`. Matches the feel of a couple of wheel notches. */
export const KEY_ZOOM_STEP = 1.4;

export interface KeyLike {
	readonly key: string;
	readonly shiftKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly metaKey?: boolean;
	readonly altKey?: boolean;
}

export function actionFor(event: KeyLike): GraphAction | null {
	// Ctrl, Meta and Alt belong to the browser and the operating system.
	// Ctrl+`-` is the page zoom, Meta+0 resets it; taking those would be rude and
	// would break the one zoom control a low-vision user already knows.
	if (event.ctrlKey || event.metaKey || event.altKey) return null;

	switch (event.key) {
		case 'ArrowUp':
			return { type: 'move', direction: 'up' };
		case 'ArrowDown':
			return { type: 'move', direction: 'down' };
		case 'ArrowLeft':
			return { type: 'move', direction: 'left' };
		case 'ArrowRight':
			return { type: 'move', direction: 'right' };

		case 'Enter':
			return { type: 'select', additive: event.shiftKey === true };

		case 'Escape':
			return { type: 'clear' };

		// `+` needs Shift on most layouts, so `=` is the key that is actually
		// under the finger. `Add` is the numeric keypad.
		case '+':
		case '=':
		case 'Add':
			return { type: 'zoom', factor: KEY_ZOOM_STEP };
		case '-':
		case '_':
		case 'Subtract':
			return { type: 'zoom', factor: 1 / KEY_ZOOM_STEP };

		case '0':
			return { type: 'fit' };

		default:
			return null;
	}
}

/**
 * Whether a key event came from somewhere that owns its own keys.
 *
 * The shortcut handler sits on the graph surface, so this should rarely fire —
 * but the surface contains the accessible tree, and a future control inside it
 * would otherwise find its arrow keys eaten.
 */
export function isFromTextInput(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
	);
}
