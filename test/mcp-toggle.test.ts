import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError } from "../src/profile-catalog.ts";
import { setMcpServerEnabled } from "../src/switching/mcp-toggle.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: { review: { mcps: ["atlassian"] }, empty: {} },
		}),
	);
	await writeFile(
		path.join(fixture.agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { atlassian: {}, github: {} } }),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

const globalInput = (name = "review") => ({
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	projectTrusted: true,
	profile: { name, source: "global" as const },
});

describe("setMcpServerEnabled", () => {
	it("adds a discovered server to the profile's mcps array", async () => {
		const result = await setMcpServerEnabled(globalInput(), "github", true);

		expect(result).toEqual({ mcps: ["atlassian", "github"], changed: true });
	});

	it("removes a server and drops the key when the array becomes empty", async () => {
		const result = await setMcpServerEnabled(globalInput(), "atlassian", false);

		expect(result).toEqual({ mcps: [], changed: true });
		const document = JSON.parse(
			await (await import("node:fs/promises")).readFile(path.join(fixture.agentDir, "profiles.json"), "utf8"),
		) as { profiles: Record<string, unknown> };
		expect(document.profiles.empty).toEqual({});
		expect(document.profiles.review).toEqual({});
	});

	it("reports no change when the server is already in the requested state", async () => {
		expect(await setMcpServerEnabled(globalInput(), "atlassian", true)).toEqual({
			mcps: ["atlassian"],
			changed: false,
		});
	});

	it("rejects enabling a server the adapter does not discover", async () => {
		await expect(setMcpServerEnabled(globalInput(), "ghost", true)).rejects.toThrow(/unknown MCP server "ghost"/);
	});

	it("allows disabling a name the adapter no longer discovers", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { mcps: ["removed"] } } }),
		);

		expect(await setMcpServerEnabled(globalInput(), "removed", false)).toEqual({ mcps: [], changed: true });
	});

	it("migrates a legacy \"mcp\" array to \"mcps\" on the next save", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { mcp: ["atlassian"] } } }),
		);

		await setMcpServerEnabled(globalInput(), "github", true);

		const text = await (await import("node:fs/promises")).readFile(
			path.join(fixture.agentDir, "profiles.json"),
			"utf8",
		);
		expect(JSON.parse(text).profiles.review).toEqual({ mcps: ["atlassian", "github"] });
		expect(text).not.toContain('"mcp"');
	});

	it("refuses the built-in default profile", async () => {
		await expect(
			setMcpServerEnabled(
				{ ...globalInput("default"), profile: { name: "default", source: "builtin" } },
				"github",
				true,
			),
		).rejects.toBeInstanceOf(CatalogError);
	});

	it("refuses a project profile when the project is not trusted", async () => {
		await expect(
			setMcpServerEnabled(
				{ ...globalInput(), projectTrusted: false, profile: { name: "review", source: "project" } },
				"github",
				true,
			),
		).rejects.toThrow(/not trusted/);
	});

	it("never touches the adapter's own configuration", async () => {
		const before = await (await import("node:fs/promises")).readFile(
			path.join(fixture.agentDir, "mcp.json"),
			"utf8",
		);

		await setMcpServerEnabled(globalInput(), "github", true);

		const after = await (await import("node:fs/promises")).readFile(
			path.join(fixture.agentDir, "mcp.json"),
			"utf8",
		);
		expect(after).toBe(before);
	});
});
