import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAdapterServerNames, McpConfigError, readAdapterMcpViewSync } from "../src/mcp-config.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

/** Discovery reads the adapter's global sources from the home directory; the
 *  fixture root stands in for it so no test touches the developer's files. */
function names(projectDir?: string): Promise<string[]> {
	return discoverAdapterServerNames(fixture.agentDir, projectDir, fixture.root);
}

describe("discoverAdapterServerNames", () => {
	it("returns no names when no config exists", async () => {
		expect(await names()).toEqual([]);
	});

	it("reads server names from the global agentDir mcp.json", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "mcp-linear" } } }),
		);

		expect(await names()).toEqual(["github", "linear"]);
	});

	it("ignores non-server keys and never exposes connection config", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x", headers: { auth: "secret" } } }, settings: {} }),
		);

		expect(await names()).toEqual(["github"]);
	});

	it("merges the trusted project's .pi/mcp.json names", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
		await writeFile(
			path.join(fixture.cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { "proj-server": {}, github: {} } }),
		);

		expect(await names(fixture.cwd)).toEqual(["github", "proj-server"]);
	});

	it("reads the adapter's other global file sources under home", async () => {
		await mkdir(path.join(fixture.root, ".config", "mcp"), { recursive: true });
		await writeFile(
			path.join(fixture.root, ".config", "mcp", "mcp.json"),
			JSON.stringify({ mcpServers: { shared: {} } }),
		);
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { agents: {} } }));

		expect(await names()).toEqual(["agents", "shared"]);
	});

	it("reads the project standard .mcp.json as well", async () => {
		await writeFile(path.join(fixture.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { standard: {} } }));

		expect(await names(fixture.cwd)).toEqual(["standard"]);
	});

	it("never reads project files without a trusted project", async () => {
		await writeFile(path.join(fixture.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { standard: {} } }));
		await writeFile(path.join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { pi: {} } }));

		expect(await names()).toEqual([]);
	});

	it("fails loudly on a malformed config instead of reading it as empty", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: ["not-an-object"] }));

		await expect(names()).rejects.toThrow(McpConfigError);
	});
});

describe("readAdapterMcpViewSync", () => {
	it("reports the slot document, slot names and other-source names", async () => {
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" } }, settings: { toolPrefix: "server" } }),
		);
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { linear: {} } }));

		const view = readAdapterMcpViewSync({
			agentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
			homeDir: fixture.root,
		});

		expect(view.slotPath).toBe(path.join(fixture.agentDir, "mcp.json"));
		expect(view.slotNames).toEqual(["github"]);
		expect(view.otherNames).toEqual(["linear"]);
		expect(view.serverNames).toEqual(["github", "linear"]);
		expect(view.slotDocument).toEqual({
			mcpServers: { github: { url: "https://x" } },
			settings: { toolPrefix: "server" },
		});
	});

	it("treats an explicit override path as the slot", async () => {
		const overridePath = path.join(fixture.root, "own-config.json");
		await writeFile(overridePath, JSON.stringify({ mcpServers: { own: {} } }));

		const view = readAdapterMcpViewSync({
			agentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
			overridePath,
			homeDir: fixture.root,
		});

		expect(view.slotPath).toBe(overridePath);
		expect(view.serverNames).toEqual(["own"]);
	});
});
