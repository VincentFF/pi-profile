import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError, ProfileCatalog } from "../src/profile-catalog.ts";
import { ProfileCatalogStore } from "../src/profile-catalog-store.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

const store = () => new ProfileCatalogStore(path.join(fixture.agentDir, "profiles.json"));

describe("ProfileCatalogStore", () => {
	it("upserts a self-contained definition into a missing file, loadable by ProfileCatalog", async () => {
		await store().upsert("review", {
			label: "Code review",
			skills: ["review*"],
			extensions: ["linter"],
			model: { provider: "deepseek", id: "deepseek-v4-pro", thinkingLevel: "high" },
			instructions: "Be terse.",
		});

		const raw = JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8"));
		expect(raw.profiles.review).toEqual({
			label: "Code review",
			skills: ["review*"],
			extensions: ["linter"],
			model: { provider: "deepseek", id: "deepseek-v4-pro", thinkingLevel: "high" },
			instructions: "Be terse.",
		});
		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review")?.definition.label).toBe("Code review");
	});

	it("writes back only declared fields — unknown keys do not survive a save", async () => {
		await store().upsert("review", { label: "ok" });
		await store().upsert("review", { skills: ["a"] });

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review")?.definition).toEqual({ skills: ["a"] });
	});

	it("rejects the built-in name and malformed definitions loudly", async () => {
		await expect(store().upsert("default", {})).rejects.toThrow(CatalogError);
		await expect(store().upsert("review", { skills: "oops" as never })).rejects.toThrow(CatalogError);
		await expect(store().upsert(" ", {})).rejects.toThrow(CatalogError);
	});

	it("drops inheritance fields — the editor has no inheritance concept", async () => {
		// Unknown keys (extends, merge, ...) are not part of the definition
		// model: they cannot survive a save, so no profile can inherit.
		await store().upsert("review", { label: "x", extends: "base" } as never);

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review")?.definition).toEqual({ label: "x" });
	});

	it("remove deletes the profile and is loud about unknown names", async () => {
		await store().upsert("review", {});
		await store().remove("review");

		expect((await ProfileCatalog.load(fixture.agentDir)).resolve("review")).toBeUndefined();
		await expect(store().remove("review")).rejects.toThrow(CatalogError);
	});

	it("saves never block on external concurrent edits (re-read at write time)", async () => {
		await store().upsert("review", { label: "mine" });
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { external: { description: "theirs" } } }),
		);

		await store().upsert("review", { label: "updated" });
		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review")?.definition.label).toBe("updated");
		expect(catalog.resolve("external")).toBeDefined();
	});
});
