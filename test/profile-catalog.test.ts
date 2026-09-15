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

async function writeCatalog(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

async function writeProjectCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(
		path.join(fixture.cwd, ".pi", "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles }),
	);
}

const reviewProfile = {
	label: "Review",
	description: "Code review workflow",
	skills: ["code-review", "git-commit"],
	extensions: ["review-guard"],
	mcps: ["github"],
	tools: ["read", "grep"],
	defaultProvider: "openai",
	defaultModel: "gpt-5.4",
	defaultThinkingLevel: "high",
	instructions: "Be picky.",
};

describe("ProfileCatalog (global catalog)", () => {
	it("resolves a named global profile with its definition and global source", async () => {
		await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		const resolved = catalog.resolve("review");

		expect(resolved).toEqual({ name: "review", source: "global", definition: reviewProfile });
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

	it("lists the built-in default first, then named profiles in file order", async () => {
		await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile, implement: { skills: [] } } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);

		expect(catalog.list().map((profile) => `${profile.name}:${profile.source}`)).toEqual([
			"default:builtin",
			"review:global",
			"implement:global",
		]);
	});

	it("fails loudly on invalid JSON", async () => {
		await writeCatalog("{ not json");

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(CatalogError);
	});

	it("fails loudly on an unsupported schemaVersion", async () => {
		await writeCatalog({ schemaVersion: 99, profiles: {} });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/schemaVersion/);
	});

	it("fails loudly when the catalog file redefines the built-in default profile", async () => {
		await writeCatalog({ schemaVersion: 1, profiles: { default: { skills: [] } } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/default/);
	});

	it("fails loudly when a profile field has the wrong shape", async () => {
		await writeCatalog({ schemaVersion: 1, profiles: { review: { skills: "code-review" } } });

		await expect(ProfileCatalog.load(fixture.agentDir)).rejects.toThrow(/review/);
	});

	it("defaults optional fields to absent rather than empty", async () => {
		await writeCatalog({ schemaVersion: 1, profiles: { review: { label: "Review" } } });

		const catalog = await ProfileCatalog.load(fixture.agentDir);
		const resolved = catalog.resolve("review");

		expect(resolved?.definition.skills).toBeUndefined();
		expect(resolved?.definition.mcps).toBeUndefined();
		expect(resolved?.definition.defaultProvider).toBeUndefined();
		expect(resolved?.definition.defaultModel).toBeUndefined();
		expect(resolved?.definition.defaultThinkingLevel).toBeUndefined();
		expect(resolved?.definition.instructions).toBeUndefined();
	});

	describe("project catalog (trusted projects only)", () => {
		it("resolves project-only profiles with project source", async () => {
			await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile } });
			await writeProjectCatalog({ implement: { skills: ["project-skill"] } });

			const catalog = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(catalog.resolve("implement")).toEqual({
				name: "implement",
				source: "project",
				definition: { skills: ["project-skill"] },
			});
		});

		it("a same-name project profile fully replaces the global definition", async () => {
			await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile } });
			await writeProjectCatalog({ review: { description: "Project override" } });

			const catalog = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });
			const resolved = catalog.resolve("review");

			// Full replacement: no global fields survive, no merge.
			expect(resolved).toEqual({
				name: "review",
				source: "project",
				definition: { description: "Project override" },
			});
		});

		it("removing the project override immediately reveals the global definition", async () => {
			await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile } });
			await writeProjectCatalog({ review: { description: "Project override" } });
			const withOverride = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });
			expect(withOverride.resolve("review")?.source).toBe("project");

			await writeProjectCatalog({});
			const afterRemoval = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(afterRemoval.resolve("review")).toEqual({
				name: "review",
				source: "global",
				definition: reviewProfile,
			});
		});

		it("without a project dir, project catalogs are not read at all", async () => {
			await writeProjectCatalog({ implement: { skills: [] } });

			const catalog = await ProfileCatalog.load(fixture.agentDir);

			expect(catalog.resolve("implement")).toBeUndefined();
		});

		it("lists each profile once with its effective source", async () => {
			await writeCatalog({ schemaVersion: 1, profiles: { review: reviewProfile, shared: { skills: [] } } });
			await writeProjectCatalog({ shared: { tools: ["read"] }, implement: {} });

			const catalog = await ProfileCatalog.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(catalog.list().map((profile) => `${profile.name}:${profile.source}`)).toEqual([
				"default:builtin",
				"review:global",
				"shared:project",
				"implement:project",
			]);
		});
	});
});
