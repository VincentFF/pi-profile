import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";
import { customizeOverlay, parseCustomizeArgs, resetOverlay } from "../src/switching/customize.ts";
import type { SwitchDeps } from "../src/switching/switch-profile.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;
let runtimeDir: string;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
	runtimeDir = (await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir })).runtimeDir;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const deps = (): SwitchDeps => ({
	runtimeDir,
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	waitForIdle: async () => {},
	reload: async () => {},
	assertStale: () => {
		throw new Error("stale");
	},
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await import("node:fs/promises").then((fs) =>
		fs.writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles })),
	);
}

async function activate(name: string): Promise<void> {
	// Simulate a launched named profile: rewrite the runtime for it.
	const { switchProfile } = await import("../src/switching/switch-profile.ts");
	await switchProfile(name, deps(), { clearOverlay: true });
}

async function readState(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"));
}

async function readSettings(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
}

describe("parseCustomizeArgs", () => {
	it("parses disable/enable/tools mutations", () => {
		expect(parseCustomizeArgs("disable skill noisy")({})).toEqual({ disabledSkills: ["noisy"] });
		expect(parseCustomizeArgs("enable skill noisy")({ disabledSkills: ["noisy"] })).toEqual({});
		expect(parseCustomizeArgs("tools read grep")({})).toEqual({ tools: ["read", "grep"] });
		expect(parseCustomizeArgs("tools")({ tools: ["read"] })).toEqual({});
	});

	it("rejects malformed invocations", () => {
		expect(() => parseCustomizeArgs("disable")).toThrow(/usage/);
		expect(() => parseCustomizeArgs("frobnicate skill x")).toThrow(/usage/);
	});
});

describe("customizeOverlay / resetOverlay", () => {
	it("applies the overlay through re-resolution and persists it to state, never the catalog", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");

		await customizeOverlay(deps(), parseCustomizeArgs("disable skill beta-skill"));

		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"), `-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`]);
		expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
		// The catalog file is untouched.
		const catalog = JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8"));
		expect(catalog.profiles.review.skills).toEqual(["alpha-skill", "beta-skill"]);
	});

	it("rejects disabling a resource the profile does not resolve, writing nothing", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await activate("review");
		const before = await readSettings();

		await expect(customizeOverlay(deps(), parseCustomizeArgs("disable skill ghost"))).rejects.toThrow(
			/overlay disables unknown skill "ghost"/,
		);

		expect(await readSettings()).toEqual(before);
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
	});

	it("reset discards the overlay and reactivates the profile exactly as declared", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");
		await customizeOverlay(deps(), parseCustomizeArgs("disable skill beta-skill"));

		await resetOverlay(deps());

		const settings = await readSettings();
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
		]);
		expect((await readState()).overlay).toBeUndefined();
	});

	it("a plain reload re-applies the stored overlay so runtime and state never diverge", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");
		await customizeOverlay(deps(), parseCustomizeArgs("disable skill beta-skill"));

		const { switchProfile } = await import("../src/switching/switch-profile.ts");
		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"), `-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`]);
		expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
	});

	it("narrows the default profile via a synthetic everything-minus-disabled selection", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({});
		// The launch profile is default (the beforeEach generated it).

		await customizeOverlay(deps(), parseCustomizeArgs("disable skill beta-skill"));

		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"), `-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`]);
		expect(settings.defaultProjectTrust).toBe("never");
	});
});
