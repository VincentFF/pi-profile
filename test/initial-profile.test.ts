import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

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

const context = () => ({ agentDir: fixture.agentDir, cwd: fixture.cwd });

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles }),
	);
}

describe("resolveInitialProfile", () => {
	it("returns the unfiltered default plan when no name and no saved state exist", async () => {
		const { plan } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("default");
		expect(plan.filter).toBe("none");
	});

	it("resolves a positional named profile against the global catalog", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });

		const { plan } = await resolveInitialProfile("review", context());

		expect(plan.profile).toBe("review");
		expect(plan.filter).toBe("selection");
		expect(plan.skills.map((skill) => skill.name)).toEqual(["alpha-skill"]);
	});

	it("restores the saved active profile when no positional name is given", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "review" }),
		);

		const { plan } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("review");
	});

	it("a positional name wins over the saved active profile", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] }, implement: { skills: ["beta-skill"] } });
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "implement" }),
		);

		const { plan } = await resolveInitialProfile("review", context());

		expect(plan.profile).toBe("review");
	});

	it("warns and falls back to default when the saved active profile no longer exists", async () => {
		await writeFile(
			path.join(fixture.agentDir, "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "ghost" }),
		);

		const { plan, warnings } = await resolveInitialProfile(undefined, context());

		expect(plan.profile).toBe("default");
		expect(warnings.some((warning) => warning.includes("ghost"))).toBe(true);
	});

	it("rejects an unknown positional profile before any spawn", async () => {
		await expect(resolveInitialProfile("review", context())).rejects.toThrow(/unknown profile: review/);
	});

	it("does not write runtime state for the initial selection", async () => {
		await writeCatalog({ review: { skills: [] } });

		await resolveInitialProfile("review", context());

		await expect(readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8")).rejects.toThrow();
	});

	it("fails activation when a profile references a missing skill", async () => {
		await writeCatalog({ review: { skills: ["ghost-skill"] } });

		await expect(resolveInitialProfile("review", context())).rejects.toThrow(/ghost-skill/);
	});

	describe("project trust gating", () => {
		async function writeProjectCatalog(profiles: Record<string, unknown>): Promise<void> {
			await writeFile(
				path.join(fixture.cwd, ".pi", "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles }),
			);
		}

		async function addProjectSkill(name: string): Promise<void> {
			const dir = path.join(fixture.cwd, ".pi", "skills", name);
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: p\n---\n`);
		}

		async function trustProject(): Promise<void> {
			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		}

		it("an untrusted project's catalog is never read", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });

			await expect(resolveInitialProfile("impl", context())).rejects.toThrow(/unknown profile/);
		});

		it("a trusted project's profiles resolve and select project skills", async () => {
			await addProjectSkill("proj-skill");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"] } });
			await trustProject();

			const { plan } = await resolveInitialProfile("impl", context());

			expect(plan.source).toBe("project");
			expect(plan.skills.map((skill) => skill.name)).toEqual(["proj-skill"]);
		});

		it("--approve grants one-run trust so project profiles resolve", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });

			const { plan } = await resolveInitialProfile("impl", { ...context(), trustOverride: true });

			expect(plan.profile).toBe("impl");
		});

		it("--no-approve distrusts even a stored trust entry", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await trustProject();

			await expect(resolveInitialProfile("impl", { ...context(), trustOverride: false })).rejects.toThrow(
				/unknown profile/,
			);
		});

		it("restores the project state file's active profile when trusted", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await trustProject();
			await writeFile(
				path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "impl" }),
			);

			const { plan } = await resolveInitialProfile(undefined, context());

			expect(plan.profile).toBe("impl");
		});

		it("ignores the project state file when untrusted", async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await writeFile(
				path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "impl" }),
			);

			const { plan } = await resolveInitialProfile(undefined, context());

			expect(plan.profile).toBe("default");
		});
	});
});
