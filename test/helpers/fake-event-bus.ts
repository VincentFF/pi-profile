/**
 * A fake event bus in the spirit of Pi's EventBus: synchronous delivery,
 * handlers may mutate the emitted object (the adapter's result pattern).
 * Shared by unit tests that fake the pi-mcp-adapter boundary (spec:
 * "外部边界（pi-mcp-adapter）用 fake").
 */

import { MCP_ADAPTER_SNAPSHOT_EVENT } from "../../src/mcp-coordination.ts";

export interface FakeEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }>;
	on(channel: string, handler: (data: unknown) => void): void;
	emit(channel: string, data: unknown): void;
}

export function fakeEventBus(): FakeEventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		emitted,
		on(channel, handler) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
		},
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of handlers.get(channel) ?? []) {
				handler(data);
			}
		},
	};
}

/** Simulates an installed adapter: answers snapshot probes with a result
 *  (a bogus-name error — the result being set is what proves presence). */
export function installFakeAdapter(bus: FakeEventBus): void {
	bus.on(MCP_ADAPTER_SNAPSHOT_EVENT, (request) => {
		(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };
	});
}
