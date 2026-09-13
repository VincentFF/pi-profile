import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError } from "../src/profile-catalog.ts";
import { ProfileCatalogStore } from "../src/profile-catalog-store.ts";
import {
	createProfile,
	deleteProfile,
	duplicateProfile,
	editProfile,
	readCatalogScope,
} from "../src/switching/profile-crud.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

const trusted = () => ({ realAgentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: true });
const untrusted = () => ({ realAgentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

async function writeGlobal(): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["git-commit"] } } }),
	);
}

describe("profile CRUD", () => {
	it("creates a complete definition in the chosen scope", async () => {
		await createProfile(trusted(), "global", "review", { skills: ["git-commit"] });

		expect((await readCatalogScope(untrusted(), "global")).get("review")).toEqual({ skills: ["git-commit"] });
	});

	it("refuses a project write when the project is not trusted", async () => {
		await expect(createProfile(untrusted(), "project", "review", {})).rejects.toBeInstanceOf(CatalogError);
	});

	it("does not read the project catalog when the project is not trusted", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: {} } }),
		);

		expect(await readCatalogScope(untrusted(), "project")).toEqual(new Map());
	});

	it("refuses to create a duplicate name", async () => {
		await writeGlobal();

		await expect(createProfile(trusted(), "global", "review", {})).rejects.toThrow(/already exists/);
	});

	it("edits an existing definition and refuses the built-in default", async () => {
		await writeGlobal();

		await editProfile(trusted(), "global", "review", { tools: ["read"] });
		expect((await readCatalogScope(trusted(), "global")).get("review")).toEqual({ tools: ["read"] });

		await expect(editProfile(trusted(), "global", "default", {})).rejects.toThrow(/built in/);
	});

	it("requires a replacement before deleting the active profile", async () => {
		await writeGlobal();

		await expect(
			deleteProfile(trusted(), "global", "review", { activeProfile: "review" }),
		).rejects.toThrow(/choose a replacement/);

		await deleteProfile(trusted(), "global", "review", { activeProfile: "review", replacement: "default" });
		expect((await readCatalogScope(trusted(), "global")).has("review")).toBe(false);
	});

	it("copies a complete definition under a new name", async () => {
		await writeGlobal();

		await duplicateProfile(trusted(), "global", "review", "review-2");

		const definitions = await readCatalogScope(trusted(), "global");
		expect(definitions.get("review-2")).toEqual({ skills: ["git-commit"] });
	});

	it("refuses to duplicate onto an existing name", async () => {
		await writeGlobal();

		await expect(duplicateProfile(trusted(), "global", "review", "review")).rejects.toThrow(/already exists/);
	});

	it("writes both scopes independently", async () => {
		await createProfile(trusted(), "global", "shared", { tools: ["read"] });
		await createProfile(trusted(), "project", "shared", { tools: ["grep"] });

		expect((await readCatalogScope(trusted(), "global")).get("shared")).toEqual({ tools: ["read"] });
		expect((await readCatalogScope(trusted(), "project")).get("shared")).toEqual({ tools: ["grep"] });
		// Deleting the project record reveals the global one (merged-catalog semantics).
		await deleteProfile(trusted(), "project", "shared", {});
		expect((await readCatalogScope(trusted(), "project")).has("shared")).toBe(false);
		expect((await readCatalogScope(trusted(), "global")).get("shared")).toEqual({ tools: ["read"] });
	});
});

describe("ProfileCatalogStore path construction", () => {
	it("writes the global catalog into the agent dir and the project one into .pi", async () => {
		await new ProfileCatalogStore(path.join(fixture.agentDir, "profiles.json")).upsert("a", {});
		await new ProfileCatalogStore(path.join(fixture.cwd, ".pi", "profiles.json")).upsert("b", {});

		expect((await readCatalogScope(trusted(), "global")).has("a")).toBe(true);
		expect((await readCatalogScope(trusted(), "project")).has("b")).toBe(true);
	});
});
