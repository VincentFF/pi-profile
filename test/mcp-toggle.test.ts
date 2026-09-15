import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfileCatalog } from "../src/profile-catalog.ts";
import { setMcpServerEnabled } from "../src/switching/mcp-toggle.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const input = (profile: { name: string; source: string }) => ({
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	profile,
});

async function seed(): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: { review: { mcps: ["github"] }, impl: { mcps: ["linear"] } },
		}),
	);
	await writeFile(
		path.join(fixture.agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { github: {}, linear: {}, slack: {} } }),
	);
}

const activeMcp = async (name: string) =>
	(await ProfileCatalog.load(fixture.agentDir)).resolve(name)?.definition.mcps;

describe("setMcpServerEnabled", () => {
	it("enable appends a discovered server to the active profile only", async () => {
		await seed();
		const result = await setMcpServerEnabled(input({ name: "review", source: "global" }), "linear", true);

		expect(result.mcps).toEqual(["github", "linear"]);
		expect(await activeMcp("review")).toEqual(["github", "linear"]);
		// Other profiles untouched.
		expect(await activeMcp("impl")).toEqual(["linear"]);
	});

	it("enable fails fast on names the adapter has not discovered", async () => {
		await seed();
		await expect(setMcpServerEnabled(input({ name: "review", source: "global" }), "ghost", true)).rejects.toThrow(
			/unknown MCP server "ghost"/,
		);
		expect(await activeMcp("review")).toEqual(["github"]);
	});

	it("disable removes present and stale (no longer discovered) names alike", async () => {
		await seed();
		// "stale" is in the profile but not in mcp.json — disable must clean it.
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { mcps: ["github", "stale"] }, impl: {} } }),
		);

		const result = await setMcpServerEnabled(input({ name: "review", source: "global" }), "stale", false);

		expect(result.mcps).toEqual(["github"]);
		expect(await activeMcp("review")).toEqual(["github"]);
	});

	it("drops the mcp key entirely when the last server is disabled", async () => {
		await seed();
		await setMcpServerEnabled(input({ name: "impl", source: "global" }), "linear", false);

		expect(await activeMcp("impl")).toBeUndefined();
	});

	it("is a no-op when the requested state already holds", async () => {
		await seed();
		const before = await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8");
		const result = await setMcpServerEnabled(input({ name: "review", source: "global" }), "github", true);

		expect(result.mcps).toEqual(["github"]);
		expect(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8")).toBe(before);
	});

	it("refuses the built-in default profile with a clear message", async () => {
		await seed();
		await expect(setMcpServerEnabled(input({ name: "default", source: "builtin" }), "github", false)).rejects.toThrow(
			/built-in default profile has no catalog entry/,
		);
	});

	it("never touches the adapter's own mcp.json configuration", async () => {
		await seed();
		const before = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		await setMcpServerEnabled(input({ name: "review", source: "global" }), "linear", true);
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(before);
	});
});
