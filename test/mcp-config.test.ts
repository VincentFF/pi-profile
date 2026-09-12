import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAdapterServerNames, McpConfigError } from "../src/mcp-config.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("discoverAdapterServerNames", () => {
	it("returns no names when no config exists", async () => {
		expect(await discoverAdapterServerNames(fixture.agentDir)).toEqual([]);
	});

	it("reads server names from the global agentDir mcp.json", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "mcp-linear" } } }),
		);

		expect(await discoverAdapterServerNames(fixture.agentDir)).toEqual(["github", "linear"]);
	});

	it("ignores non-server keys and never exposes connection config", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x", headers: { auth: "secret" } } }, settings: {} }),
		);

		expect(await discoverAdapterServerNames(fixture.agentDir)).toEqual(["github"]);
	});

	it("merges the trusted project's .pi/mcp.json names", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "proj-server": {}, github: {} } }),
		);

		expect(await discoverAdapterServerNames(fixture.agentDir, fixture.cwd)).toEqual(["github", "proj-server"]);
	});

	it("fails loudly on a malformed config instead of reading it as empty", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: ["not-an-object"] }));

		await expect(discoverAdapterServerNames(fixture.agentDir)).rejects.toThrow(McpConfigError);
	});
});
