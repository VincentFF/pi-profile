import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError } from "../src/launcher/initial-profile.ts";
import { createProfileRuntime, type ProfileHostOptions } from "../src/profile-host.ts";
import { addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "fixture-skill");
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

/** The launcher's real build path against the standard fixture layout. */
function hostOptions(): ProfileHostOptions {
	return {
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		sessionManager: SessionManager.inMemory(fixture.cwd),
	};
}

describe("createProfileRuntime (integration: real launcher build path, fixture layout)", () => {
	it("starts the default profile and exposes the fixture skill before any agent turn", async () => {
		const { runtime, plan } = await createProfileRuntime(parseLauncherArgs([]), hostOptions());

		expect(plan.profile).toBe("default");

		const skills = runtime.services.resourceLoader.getSkills().skills;
		expect(skills.map((skill) => skill.name)).toContain("fixture-skill");
	});

	it("writes no profile state and no pi settings; SDK-managed stores stay inside the isolated agent dir", async () => {
		const before = await listFiles(fixture.root);

		await createProfileRuntime(parseLauncherArgs([]), hostOptions());

		const after = await listFiles(fixture.root);
		const created = after.filter((file) => !before.includes(file));
		// ModelRuntime creates auth.json/models-store.json in the agent dir — the
		// same stores native pi maintains on every start. pi-profile must not add
		// anything beyond those: no state file, no settings.json anywhere.
		expect(created.every((file) => file.startsWith(fixture.agentDir))).toBe(true);
		expect(after.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
		expect(after.filter((file) => file.endsWith("settings.json"))).toEqual([]);
	});

	it("rejects an unknown profile name before creating a runtime", async () => {
		await expect(createProfileRuntime(parseLauncherArgs(["review"]), hostOptions())).rejects.toBeInstanceOf(
			UnknownProfileError,
		);
	});

	it("loads the pi-profile extension entry as a valid extension module", async () => {
		const extension = await import("../extensions/pi-profile/index.ts");
		expect(typeof extension.default).toBe("function");
	});
});
