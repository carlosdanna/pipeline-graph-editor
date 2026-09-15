/// <reference lib="webworker" />

import { fromElkGraph, toElkGraph } from './elk-adapter';
import { elk, postToHost } from './elk-inline';
import {
	resultTransfers,
	type LayoutRequestMessage,
	type LayoutResultMessage,
	type WorkerOutbound
} from './protocol';

/**
 * The layout worker. ELK never runs on the main thread — a 10k-node layout is
 * ~4.6 seconds of straight-line JavaScript, which on the main thread would be
 * roughly 280 dropped frames.
 *
 * Deliberately dumb: it owns no state beyond the ELK instance, decides nothing
 * about what to lay out, and has never heard of "pinned". That all lives on the
 * main thread in incremental.ts, so the code that is awkward to debug across a
 * thread boundary stays as small as it can be.
 *
 * Note `postToHost` rather than `self.postMessage`: elk-inline.ts hands
 * `self.postMessage` to ELK. See that file for why.
 */

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<LayoutRequestMessage>): Promise<void> => {
	const request = event.data;
	if (request.type !== 'layout') return;

	try {
		const startedAt = performance.now();
		const laidOut = await elk.layout(toElkGraph(request));
		const elkMs = performance.now() - startedAt;

		const result: LayoutResultMessage = {
			type: 'layout-result',
			requestId: request.requestId,
			...fromElkGraph(laidOut),
			elkMs
		};
		postToHost(result, resultTransfers(result));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failure: WorkerOutbound = {
			type: 'layout-error',
			requestId: request.requestId,
			message,
			stackOverflow: /call stack|stack size|stack overflow/i.test(message)
		};
		postToHost(failure);
	}
};
