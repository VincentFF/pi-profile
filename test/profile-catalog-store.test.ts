import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError } from "../src/profile-catalog.ts";
import { ProfileCatalogStore } from "../src/profile-catalog-store.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function store(): ProfileCatalogStore {
	return new ProfileCatalogStore(path.join(fixture.agentDir, "profiles.json"));
}

async function readFileJson(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8")) as Record<string, unknown>;
}

describe("ProfileCatalogStore", () => {
	it("treats a missing catalog file as empty", async () => {
		expect(await store().readDefinitions()).toEqual(new Map());
	});

	it("writes schemaVersion 1 and only declared fields", async () => {
		await store().upsert("review", {
			skills: ["git-commit"],
			model: { provider: "openai", id: "gpt-5.4" },
		});

		const document = await readFileJson();
		expect(document.schemaVersion).toBe(1);
		expect(document.profiles).toEqual({
			review: { skills: ["git-commit"], model: { provider: "openai", id: "gpt-5.4" } },
		});
	});

	it("drops unrelated fields so written definitions stay self-contained", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({
				schemaVersion: 1,
				profiles: { review: { skills: ["git-commit"], extensions: ["x"], extends: "base" } },
			}),
		);

		await store().upsert("review", { skills: ["git-commit", "code-review"] });

		const document = await readFileJson();
		expect(document.profiles).toEqual({ review: { skills: ["git-commit", "code-review"] } });
	});

	it("refuses a catalog written by v0.1.0 (schemaVersion 2)", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 2, profiles: { review: { skills: ["git-commit"] } } }),
		);

		await expect(store().readDefinitions()).rejects.toThrow(/unsupported schemaVersion/);
	});

	it("refuses to write the built-in default profile", async () => {
		await expect(store().upsert("default", {})).rejects.toBeInstanceOf(CatalogError);
	});

	it("errors when removing an unknown profile", async () => {
		await expect(store().remove("ghost")).rejects.toThrow(/not found/);
	});

	it("removes an existing profile", async () => {
		await store().upsert("review", { skills: ["git-commit"] });

		await store().remove("review");

		expect(await store().readDefinitions()).toEqual(new Map());
	});

	it("fails loudly on a malformed existing file", async () => {
		await writeFile(path.join(fixture.agentDir, "profiles.json"), "{ not json");

		await expect(store().readDefinitions()).rejects.toThrow(/invalid JSON/);
	});
});
