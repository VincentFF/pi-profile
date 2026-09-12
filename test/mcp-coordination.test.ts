import { describe, expect, it } from "vitest";

import { isAdapterExtension, MCP_ALLOWLIST_EVENT, probeAdapterPresence } from "../src/mcp-coordination.ts";
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

describe("isAdapterExtension", () => {
	it("matches an npm package install path", () => {
		expect(isAdapterExtension({ entry: "/x/npm/node_modules/pi-mcp-adapter/index.ts" })).toBe(true);
	});

	it("matches a local directory named after the adapter", () => {
		expect(isAdapterExtension({ entry: "/home/u/exts/pi-mcp-adapter/index.ts" })).toBe(true);
	});

	it("rejects unrelated extensions", () => {
		expect(isAdapterExtension({ entry: "/home/u/exts/my-tools/index.ts" })).toBe(false);
	});
});

describe("MCP_ALLOWLIST_EVENT", () => {
	it("is the versioned coordination channel", () => {
		expect(MCP_ALLOWLIST_EVENT).toBe("pi-profile:mcp-allowlist:v1");
	});
});
