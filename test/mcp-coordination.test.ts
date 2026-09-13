import { describe, expect, it } from "vitest";

import { MCP_ALLOWLIST_EVENT, probeAdapterPresence } from "../src/mcp-coordination.ts";
import { fakeEventBus, installFakeAdapter } from "./helpers/fake-event-bus.ts";

describe("probeAdapterPresence", () => {
	it("reports absent when no listener answers the probe", () => {
		expect(probeAdapterPresence(fakeEventBus())).toBe(false);
	});

	it("reports present when a listener fills the request result, even with an error", () => {
		const bus = fakeEventBus();
		installFakeAdapter(bus);

		expect(probeAdapterPresence(bus)).toBe(true);
	});
});

describe("MCP_ALLOWLIST_EVENT", () => {
	it("is the versioned coordination channel", () => {
		expect(MCP_ALLOWLIST_EVENT).toBe("pi-profile:mcp-allowlist:v1");
	});
});
