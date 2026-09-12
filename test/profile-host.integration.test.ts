import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError } from "../src/launcher/initial-profile.ts";
import { createProfileRuntime } from "../src/profile-host.ts";

let fixture: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	fixture = await mkdtemp(path.join(tmpdir(), "pi-profile-host-"));
	cwd = path.join(fixture, "project");
	agentDir = path.join(fixture, "agent");
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	await mkdir(path.join(agentDir, "skills", "fixture-skill"), { recursive: true });
	await writeFile(
		path.join(agentDir, "skills", "fixture-skill", "SKILL.md"),
		"---\nname: fixture-skill\ndescription: A fixture skill for launcher integration tests\n---\n\nFixture skill body.\n",
	);
});

afterEach(async () => {
	await rm(fixture, { recursive: true, force: true });
});

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(full)));
		else files.push(full);
	}
	return files;
}

describe("createProfileRuntime (integration: real launcher build path, fixture dirs)", () => {
	it("starts the default profile and exposes the fixture skill before any agent turn", async () => {
		const args = parseLauncherArgs([]);
		const { runtime, plan } = await createProfileRuntime(args, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(plan.profile).toBe("default");

		const skills = runtime.services.resourceLoader.getSkills().skills;
		expect(skills.map((skill) => skill.name)).toContain("fixture-skill");
	});

	it("writes no runtime state anywhere under the fixture root", async () => {
		await createProfileRuntime(parseLauncherArgs([]), {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});

		const files = await listFiles(fixture);
		expect(files.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
	});

	it("rejects an unknown profile name before creating a runtime", async () => {
		await expect(
			createProfileRuntime(parseLauncherArgs(["review"]), {
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
			}),
		).rejects.toBeInstanceOf(UnknownProfileError);
	});

	it("loads the pi-profile extension entry as a valid extension module", async () => {
		const extension = await import("../extensions/pi-profile/index.ts");
		expect(typeof extension.default).toBe("function");
	});
});
