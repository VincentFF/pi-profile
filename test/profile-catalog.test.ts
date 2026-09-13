import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogError, ProfileCatalog } from "../src/profile-catalog.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeGlobal(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

async function writeProject(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.cwd, ".pi", "profiles.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

const reviewProfile = {
	label: "Review",
	description: "Code review workflow",
	skills: ["code-review", "git-commit"],
	mcps: ["atlassian"],
	tools: ["read", "grep"],
	model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" },
	instructions: "Be picky.",
};

describe("ProfileCatalog (global catalog)", () => {
	it("resolves a named global profile with its definition and global source", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: reviewProfile } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")).toEqual({
			name: "review",
			source: "global",
			definition: reviewProfile,
		});
	});

	it("resolves the built-in default profile even without a catalog file", async () => {
		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("default")).toEqual({ name: "default", source: "builtin", definition: {} });
	});

	it("treats a missing catalog file as an empty catalog", async () => {
		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")).toBeUndefined();
		expect(catalog.list().map((profile) => profile.name)).toEqual(["default"]);
	});

	it("lists the built-in default first, then profiles in file order", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: reviewProfile, implement: { skills: [] } } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.list().map((profile) => `${profile.name}:${profile.source}`)).toEqual([
			"default:builtin",
			"review:global",
			"implement:global",
		]);
	});

	it("rejects a catalog that redefines the built-in default", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { default: {} } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toBeInstanceOf(CatalogError);
	});

	it("fails loudly on malformed JSON", async () => {
		await writeGlobal("{ not json");

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/invalid JSON/);
	});

	it("fails loudly on an unsupported schemaVersion", async () => {
		await writeGlobal({ schemaVersion: 99, profiles: {} });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/unsupported schemaVersion/);
	});

	it("fails loudly on the version 2 shape written by v0.1.0", async () => {
		await writeGlobal({ schemaVersion: 2, profiles: { review: { skills: ["git-commit"] } } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/unsupported schemaVersion 2/);
	});

	it("fails loudly on a malformed profile field", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: { skills: "git-commit" } } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/"skills" must be an array of strings/);
	});
});

describe("ProfileCatalog unknown-field tolerance", () => {

	it("drops a profile's extensions field silently", async () => {
		await writeGlobal({
			schemaVersion: 1,
			profiles: { review: { skills: ["git-commit"], extensions: ["pi-plan-build"] } },
		});

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")?.definition).toEqual({ skills: ["git-commit"] });
	});

	it("ignores inheritance-like fields entirely (no profile inheritance)", async () => {
		await writeGlobal({
			schemaVersion: 1,
			profiles: { review: { skills: ["git-commit"], extends: "base", skillsAppend: ["x"] } },
		});

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")?.definition).toEqual({ skills: ["git-commit"] });
	});
});

describe("ProfileCatalog legacy mcp alias", () => {
	it("reads the legacy \"mcp\" key as the \"mcps\" declaration", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: { mcp: ["atlassian"] } } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")?.definition).toEqual({ mcps: ["atlassian"] });
	});

	it("lets the canonical \"mcps\" key win when a file carries both", async () => {
		await writeGlobal({
			schemaVersion: 1,
			profiles: { review: { mcps: ["canonical"], mcp: ["legacy"] } },
		});

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")?.definition).toEqual({ mcps: ["canonical"] });
	});

	it("still fails loudly on a wrong-typed alias value", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: { mcp: "atlassian" } } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/"mcp" must be an array of strings/);
	});
});

describe("ProfileCatalog (project catalog)", () => {
	it("replaces a same-name global profile with the project definition and reports the shadow", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: reviewProfile, implement: {} } });
		await writeProject({ schemaVersion: 1, profiles: { review: { skills: ["project-only"] } } });

		const catalog = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });

		expect(catalog.resolve("review")).toEqual({
			name: "review",
			source: "project",
			definition: { skills: ["project-only"] },
		});
		expect(catalog.shadowsGlobal("review")).toBe(true);
		expect(catalog.shadowsGlobal("implement")).toBe(false);
	});

	it("reveals the global definition as soon as the project entry is gone", async () => {
		await writeGlobal({ schemaVersion: 1, profiles: { review: reviewProfile } });

		const withProject = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });

		expect(withProject.resolve("review")?.source).toBe("global");
		expect(withProject.shadowsGlobal("review")).toBe(false);
	});

	it("does not read the project catalog when no projectDir is given (untrusted project)", async () => {
		await writeProject({ schemaVersion: 1, profiles: { review: reviewProfile } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.resolve("review")).toBeUndefined();
	});
});
