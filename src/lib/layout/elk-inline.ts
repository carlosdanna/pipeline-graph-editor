import ELK from 'elkjs/lib/elk-api.js';
// Side-effect import: in any scope where `self` exists, this file assumes it IS
// the worker script and installs `self.onmessage`. We take that handler over.
import 'elkjs/lib/elk-worker.js';

/**
 * Runs ELK inline in the current worker thread.
 *
 * ## Why this file exists
 *
 * The obvious thing — `import ELK from 'elkjs/lib/elk.bundled.js'; new ELK()` —
 * **does not work in a browser**, in a worker or on the main thread. That file
 * is browserified from elkjs's *Node* entry point (see its package.json
 * `browserifyBundle` script), whose constructor does:
 *
 *     const Worker = require('./elk-worker.min.js').Worker;
 *     workerFactory = (url) => new Worker(url);
 *
 * and `elk-worker.min.js` only exports `.Worker` when `self` is undefined. When
 * `self` exists it assumes it is being loaded *as* the worker script, installs
 * `self.onmessage`, and exports nothing — so the factory calls `new undefined()`
 * and you get `TypeError: _Worker is not a constructor`.
 *
 * Node has no `self`, which is why this only shows up in a browser and why
 * every measurement taken outside one will happily pass.
 *
 * ## What this does instead
 *
 * elk-worker installs its handler on our scope; we take it, hand it back a
 * worker-shaped object, and let `elk-api` drive its own protocol across it. No
 * second thread, no nested worker (which Safari was late to support), and no
 * message shapes reverse-engineered from elkjs internals — `workerFactory` is
 * public API.
 *
 * The one subtlety: ELK replies by calling `self.postMessage`, so that function
 * now belongs to ELK. Anything wanting to talk to the host must use the
 * `postToHost` handle captured here, before the swap.
 */

interface WorkerScope {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

interface InlineWorker {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown): void;
	terminate(): void;
}

const scope = globalThis as unknown as WorkerScope;

/** `postMessage` as it was before ELK took it over. Use this to reply to the host. */
export const postToHost: (message: unknown, transfer?: Transferable[]) => void =
	scope.postMessage.bind(scope);

const elkHandler = scope.onmessage;
if (typeof elkHandler !== 'function') {
	throw new Error(
		'elkjs did not install a message handler on this scope — ' +
			'elk-worker.js expects a worker-like global with `self` defined.'
	);
}
scope.onmessage = null;

const inlineWorker: InlineWorker = {
	onmessage: null,
	// ELK "sends" to its worker: run its handler here, synchronously, in-thread.
	postMessage(message: unknown): void {
		elkHandler.call(scope, { data: message } as MessageEvent);
	},
	terminate(): void {
		// Nothing to tear down: there is no second thread. The LayoutClient's
		// cancellation works by terminating this whole worker instead.
	}
};

// ELK "replies" by calling self.postMessage. Route that to its worker object.
scope.postMessage = (message: unknown): void => {
	inlineWorker.onmessage?.({ data: message });
};

// `workerFactory` is typed as returning a full `Worker`, but elk-api only ever
// touches `postMessage`, `onmessage` and `terminate` (verified against
// elk-api.js: PromisedWorker's constructor even guards on `postMessage` alone).
// The cast records that, rather than stubbing a dozen members that are never
// called.
export const elk = new ELK({
	workerFactory: () => inlineWorker as unknown as Worker
});
