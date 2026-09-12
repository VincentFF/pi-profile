import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatProfileList, listProfiles } from "../src/switching/list-profiles.ts";
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

const input = () => ({ realAgentDir: fixture.agentDir, cwd: fixture.cwd });

async function writeGlobal(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function writeProject(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.cwd, ".pi", "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function trustProject(): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
}

describe("listProfiles", () => {
	it("lists the built-in default plus global profiles with their sources", async () => {
		await writeGlobal({ review: { label: "Code review" }, impl: { description: "Implementation" } });

		const entries = await listProfiles(input());

		expect(entries.map((entry) => `${entry.name}:${entry.source}`)).toContain("default:builtin");
		expect(entries.find((entry) => entry.name === "review")?.label).toBe("Code review");
	});

	it("shows project profiles only when trusted, with the winning source", async () => {
		await writeGlobal({ review: {}, shared: { label: "global shared" } });
		await writeProject({ proj: {}, shared: { label: "project shared" } });

		// Untrusted: only the global shared definition is visible.
		expect((await listProfiles(input())).map((entry) => entry.name).sort()).toEqual([
			"default",
			"review",
			"shared",
		]);

		await trustProject();
		const entries = await listProfiles(input());
		const shared = entries.find((entry) => entry.name === "shared");
		expect(shared?.source).toBe("project");
		expect(shared?.shadowsGlobal).toBe(true);
		expect(shared?.label).toBe("project shared");
	});
});

describe("formatProfileList", () => {
	it("marks the active profile and shadowing", () => {
		const text = formatProfileList(
			[
				{ name: "default", source: "builtin", shadowsGlobal: false },
				{ name: "shared", source: "project", label: "project shared", shadowsGlobal: true },
			],
			"shared",
		);

		expect(text).toContain("shared [project] (shadows global) — project shared ← active");
	});
});
