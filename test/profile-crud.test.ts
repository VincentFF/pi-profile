import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError, ProfileCatalog } from "../src/profile-catalog.ts";
import { createProfile, deleteProfile, duplicateProfile, editProfile } from "../src/switching/profile-crud.ts";
import { listProfiles } from "../src/switching/list-profiles.ts";
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
const trust = () => writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));

describe("createProfile", () => {
	it("creates in the chosen scope; the profile is immediately listed with that source", async () => {
		await createProfile(input(), "global", "review", { label: "Code review" });
		await trust();
		await createProfile(input(), "project", "proj", { description: "Project profile" });

		const entries = await listProfiles(input());
		expect(entries.find((entry) => entry.name === "review")?.source).toBe("global");
		expect(entries.find((entry) => entry.name === "proj")?.source).toBe("project");
	});

	it("refuses duplicate names and untrusted project writes", async () => {
		await createProfile(input(), "global", "review", {});
		await expect(createProfile(input(), "global", "review", {})).rejects.toThrow(/already exists/);

		// Genuinely untrusted: a trust-requiring file with no decision.
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: {} }),
		);
		await expect(createProfile(input(), "project", "x", {})).rejects.toThrow(CatalogError);
	});
});

describe("editProfile", () => {
	it("replaces the definition wholesale; unknown names and default are refused", async () => {
		await createProfile(input(), "global", "review", { label: "old", skills: ["a"] });
		await editProfile(input(), "global", "review", { label: "new" });

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review")?.definition).toEqual({ label: "new" });

		await expect(editProfile(input(), "global", "ghost", {})).rejects.toThrow(/not found/);
		await expect(editProfile(input(), "global", "default", {})).rejects.toThrow(/built in/);
	});
});

describe("deleteProfile", () => {
	it("refuses to delete the active profile without a replacement", async () => {
		await createProfile(input(), "global", "review", {});
		await expect(deleteProfile(input(), "global", "review", { activeProfile: "review" })).rejects.toThrow(
			/choose a replacement/,
		);
		await deleteProfile(input(), "global", "review", { activeProfile: "review", replacement: "default" });
		expect((await ProfileCatalog.load(fixture.agentDir)).resolve("review")).toBeUndefined();
	});

	it("deleting a project override reveals the same-name global profile", async () => {
		await createProfile(input(), "global", "shared", { label: "global shared" });
		await trust();
		await createProfile(input(), "project", "shared", { label: "project shared" });
		expect((await listProfiles(input())).find((entry) => entry.name === "shared")?.label).toBe("project shared");

		await deleteProfile(input(), "project", "shared", { activeProfile: "impl" });

		const revealed = (await listProfiles(input())).find((entry) => entry.name === "shared");
		expect(revealed?.source).toBe("global");
		expect(revealed?.label).toBe("global shared");
	});

	it("never deletes the built-in default", async () => {
		await expect(deleteProfile(input(), "global", "default", { activeProfile: "impl" })).rejects.toThrow(/built in/);
	});
});

describe("duplicateProfile", () => {
	it("copies the complete definition under a new name; existing names refused", async () => {
		await createProfile(input(), "global", "review", {
			label: "Code review",
			skills: ["r*"],
			extensions: ["linter"],
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-pro",
			instructions: "Be terse.",
		});
		await duplicateProfile(input(), "global", "review", "review-strict");

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		expect(catalog.resolve("review-strict")?.definition).toEqual(catalog.resolve("review")?.definition);

		await expect(duplicateProfile(input(), "global", "review", "review")).rejects.toThrow(/already exists/);
		await expect(duplicateProfile(input(), "global", "ghost", "x")).rejects.toThrow(/not found/);
	});
});
