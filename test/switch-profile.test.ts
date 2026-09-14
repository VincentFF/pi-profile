import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateRuntimeDir } from "../src/settings-generator.ts";
import { defaultPlan } from "../src/profile-resolver.ts";
import { switchProfile, SwitchError } from "../src/switching/switch-profile.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;
let runtimeDir: string;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
	runtimeDir = (
		await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir })
	).runtimeDir;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const deps = (overrides?: Partial<Parameters<typeof switchProfile>[1]>) => ({
	runtimeDir,
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	waitForIdle: async () => {},
	reload: async () => {},
	// Tests simulate the reload having re-executed extensions (context stale).
	assertStale: () => {
		throw new Error("stale");
	},
	...overrides,
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles }),
	);
}

async function readPlanFile(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8"));
}

describe("switchProfile", () => {
	it("rewrites the runtime files for the target profile and marks the plan for persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });

		const result = await switchProfile("impl", deps());

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.profile).toBe("impl");
		expect(plan.switchedFrom).toBe("default");
		expect(plan.persistSelection).toBe(true);
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
		expect(settings.defaultProjectTrust).toBe("never");
	});

	it("waits for the agent to be idle before touching the runtime files", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		let releaseIdle!: () => void;
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const original = await readFile(path.join(runtimeDir, "settings.json"), "utf8");

		const pending = switchProfile("impl", deps({ waitForIdle: () => idleGate }));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const observed = (await readFile(path.join(runtimeDir, "settings.json"), "utf8")) === original ? "untouched" : "rewritten";
		releaseIdle();
		await pending;

		expect(observed).toBe("untouched");
	});

	it("leaves the runtime untouched when the target fails to resolve", async () => {
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const originalPlan = await readPlanFile();

		await expect(switchProfile("ghost", deps())).rejects.toThrow(/unknown profile/);

		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect(await readPlanFile()).toEqual(originalPlan);
	});

	it("restores the snapshot and reloads again when reload fails", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};

		await expect(switchProfile("impl", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
	});

	it("rolls back when Pi silently skips the reload (context never goes stale)", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;

		await expect(
			switchProfile(
				"impl",
				deps({
					reload: async () => {
						reloads += 1;
					},
					assertStale: () => {}, // still valid: the reload never re-executed extensions
				}),
			),
		).rejects.toThrow(/did not run the reload/);

		expect(reloads).toBe(2); // the restore reload
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
	});

	it("reload re-resolves the current profile without a switch marker and keeps its persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await switchProfile("impl", deps());

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.switchedFrom).toBeUndefined();
		expect(plan.persistSelection).toBe(true);
	});

	it("reload of a transient launch selection stays transient", async () => {
		// Launch plans have no persistSelection (the CLI selection is transient).
		expect((await readPlanFile()).persistSelection).toBeUndefined();
		await writeCatalog({});

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("default");
		expect((await readPlanFile()).persistSelection).toBe(false);
	});

	it("re-resolves at switch time, so catalog edits are picked up", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
		await switchProfile("impl", deps());
		// The profile definition changes after activation; reload propagates it.
		await writeCatalog({ impl: { skills: ["beta-skill"] } });

		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const runtimeDir = deps().runtimeDir;
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
			`-${path.join(runtimeDir, "skills", "alpha-skill", "SKILL.md")}`,
		]);
	});
});
