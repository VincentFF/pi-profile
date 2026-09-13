/**
 * The first-load seed: a fresh install must find a usable default catalog,
 * and an existing catalog must never be touched. The byte-level contract with
 * the published `examples/profiles.json` is asserted here, so the shipped
 * example cannot drift from what the extension actually writes.
 */

import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PROFILE_CATALOG, seedDefaultProfilesSync } from "../src/default-profiles.ts";
import { PROFILE_PRESETS } from "../src/profile-presets.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function catalogPath(): string {
	return path.join(fixture.agentDir, "profiles.json");
}

describe("DEFAULT_PROFILE_CATALOG", () => {
	it("is the shipped preset catalog", () => {
		expect(DEFAULT_PROFILE_CATALOG).toEqual({
			schemaVersion: 1,
			profiles: Object.fromEntries(PROFILE_PRESETS.map((preset) => [preset.name, preset.definition])),
		});
	});

	it("matches the published examples/profiles.json byte for byte", async () => {
		seedDefaultProfilesSync(fixture.agentDir);

		expect(await readFile(catalogPath(), "utf8")).toBe(
			await readFile(path.resolve("examples", "profiles.json"), "utf8"),
		);
	});
});

describe("seedDefaultProfilesSync", () => {
	it("writes the default catalog when the agent dir has none", () => {
		expect(seedDefaultProfilesSync(fixture.agentDir)).toBe("seeded");
	});

	it("leaves an existing catalog exactly as it is", async () => {
		const userCatalog = '{ "schemaVersion": 1, "profiles": { "mine": {} } }\n';
		await writeFile(catalogPath(), userCatalog);

		expect(seedDefaultProfilesSync(fixture.agentDir)).toBe("present");
		expect(await readFile(catalogPath(), "utf8")).toBe(userCatalog);
	});

	it("refuses to overwrite an empty file, which is a user decision", async () => {
		await writeFile(catalogPath(), "");

		expect(seedDefaultProfilesSync(fixture.agentDir)).toBe("present");
		expect(await readFile(catalogPath(), "utf8")).toBe("");
	});

	it("creates the agent dir when it does not exist yet", () => {
		const fresh = path.join(fixture.root, "fresh-agent");

		expect(seedDefaultProfilesSync(fresh)).toBe("seeded");
		expect(JSON.parse(readFileSync(path.join(fresh, "profiles.json"), "utf8"))).toEqual(DEFAULT_PROFILE_CATALOG);
	});

	it("seeding is idempotent across runs", () => {
		expect(seedDefaultProfilesSync(fixture.agentDir)).toBe("seeded");
		expect(seedDefaultProfilesSync(fixture.agentDir)).toBe("present");
	});
});
