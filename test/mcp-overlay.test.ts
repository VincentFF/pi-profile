import { describe, expect, it } from "vitest";

import {
	buildMcpOverlay,
	isDisabledStub,
	isGeneratedOverlay,
	MCP_GENERATED_MARKER,
	MCP_SLOT_FILE_NAME,
	MCP_SOURCE_FILE_NAME,
	mcpSlotPath,
	mcpSourcePath,
	resolveAllowedServers,
	serializeMcpOverlay,
} from "../src/mcp-overlay.ts";

const slotDocument = {
	mcpServers: {
		github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer x" } },
		linear: { command: "mcp-linear" },
	},
	settings: { toolPrefix: "server" },
};

describe("resolveAllowedServers", () => {
	it("treats an absent declaration as no filtering", () => {
		expect(resolveAllowedServers(undefined, ["github"])).toBe("all");
	});

	it("resolves literals and globs against the discovered names", () => {
		expect(resolveAllowedServers([], ["github", "linear"])).toEqual([]);
		expect(resolveAllowedServers(["github"], ["github", "linear"])).toEqual(["github"]);
		expect(resolveAllowedServers(["git*"], ["github", "linear"])).toEqual(["github"]);
		expect(resolveAllowedServers(["ghost"], ["github"])).toEqual([]);
	});
});

describe("buildMcpOverlay", () => {
	const marker = { [MCP_GENERATED_MARKER]: { generated: true, version: 1 } };

	it("carries the sidecar document verbatim when the profile declares nothing", () => {
		const document = buildMcpOverlay({ slotDocument, otherServerNames: ["other"], allowed: "all" });

		expect(document).toEqual({ ...marker, ...slotDocument });
		expect(isGeneratedOverlay(document)).toBe(true);
	});

	it("disables the slot servers outside the allowlist, keeping their definitions", () => {
		const document = buildMcpOverlay({ slotDocument, otherServerNames: [], allowed: ["github"] });

		expect(document.mcpServers).toEqual({
			github: slotDocument.mcpServers.github,
			linear: { command: "mcp-linear", disabled: true },
		});
		expect(document.settings).toEqual({ toolPrefix: "server" });
	});

	it("disables every discovered server for an empty allowlist", () => {
		const document = buildMcpOverlay({ slotDocument, otherServerNames: ["other"], allowed: [] });

		expect(document.mcpServers).toEqual({
			github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer x" }, disabled: true },
			linear: { command: "mcp-linear", disabled: true },
			other: { disabled: true },
		});
	});

	it("writes credential-free stubs for the adapter's other sources", () => {
		const document = buildMcpOverlay({ otherServerNames: ["linear"], allowed: ["github"] });

		expect(document).toEqual({ ...marker, mcpServers: { linear: { disabled: true } } });
		expect(isDisabledStub((document.mcpServers as Record<string, unknown>).linear)).toBe(true);
		expect(isDisabledStub({ disabled: true, url: "https://x" })).toBe(false);
	});

	it("lets the slot definition own a name that also appears elsewhere", () => {
		const document = buildMcpOverlay({ slotDocument, otherServerNames: ["github"], allowed: [] });

		expect(document.mcpServers).toEqual({
			github: { ...slotDocument.mcpServers.github, disabled: true },
			linear: { command: "mcp-linear", disabled: true },
		});
	});

	it("keeps an already disabled server disabled", () => {
		const document = buildMcpOverlay({
			slotDocument: { mcpServers: { linear: { command: "mcp-linear", disabled: true } } },
			otherServerNames: [],
			allowed: ["linear"],
		});

		expect(document.mcpServers).toEqual({ linear: { command: "mcp-linear", disabled: true } });
	});

	it("never carries a stale marker from the sidecar", () => {
		const document = buildMcpOverlay({
			slotDocument: { [MCP_GENERATED_MARKER]: { generated: false }, mcpServers: {} },
			otherServerNames: [],
			allowed: "all",
		});

		expect(document[MCP_GENERATED_MARKER]).toEqual({ generated: true, version: 1 });
	});

	it("produces stable bytes regardless of discovery order", () => {
		const first = serializeMcpOverlay(buildMcpOverlay({ otherServerNames: ["b", "a"], allowed: [] }));
		const second = serializeMcpOverlay(buildMcpOverlay({ otherServerNames: ["a", "b"], allowed: [] }));

		expect(first).toBe(second);
		expect(first.endsWith("\n")).toBe(true);
	});
});

describe("paths", () => {
	it("are fixed files inside the agent dir", () => {
		expect(mcpSlotPath("/tmp/agent")).toBe(`/tmp/agent/${MCP_SLOT_FILE_NAME}`);
		expect(mcpSourcePath("/tmp/agent")).toBe(`/tmp/agent/${MCP_SOURCE_FILE_NAME}`);
		expect(isGeneratedOverlay({})).toBe(false);
	});
});
