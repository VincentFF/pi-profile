import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatProfileList, listProfiles } from "../src/switching/list-profiles.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 2,
			profiles: {
				review: { label: "Review", skills: ["code-review"] },
				implement: { skills: [] },
			},
		}),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("listProfiles", () => {
	it("lists the built-in default first, then global profiles", async () => {
		const { entries } = await listProfiles({
			realAgentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
		});

		expect(entries.map((entry) => `${entry.name}:${entry.source}`)).toEqual([
			"default:builtin",
			"review:global",
			"implement:global",
		]);
		expect(entries[1]?.label).toBe("Review");
	});

	it("shows project overrides only in a trusted project and marks the shadow", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 2, profiles: { review: { skills: ["project-skill"] }, local: {} } }),
		);

		const untrusted = await listProfiles({
			realAgentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
		});
		expect(untrusted.entries.map((entry) => entry.name)).toEqual(["default", "review", "implement"]);

		const trusted = await listProfiles({
			realAgentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: true,
		});
		const review = trusted.entries.find((entry) => entry.name === "review");
		expect(review?.source).toBe("project");
		expect(review?.shadowsGlobal).toBe(true);
		expect(trusted.entries.some((entry) => entry.name === "local")).toBe(true);
	});

	it("carries catalog compatibility warnings", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { extensions: ["x"] } } }),
		);

		const { warnings } = await listProfiles({
			realAgentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
		});

		expect(warnings.join("\n")).toMatch(/schemaVersion 1/);
	});
});

describe("formatProfileList", () => {
	it("marks the active profile and shows source, shadow, and label", () => {
		const text = formatProfileList(
			[
				{ name: "default", source: "builtin", shadowsGlobal: false },
				{ name: "review", source: "project", shadowsGlobal: true, label: "Review" },
			],
			"review",
		);

		expect(text).toBe("default [builtin]\nreview [project] (shadows global) — Review ← active");
	});
});
