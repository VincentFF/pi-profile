import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("generateRuntimeDir (default profile)", () => {
	it("preserves user settings keys and re-includes the real agent dir's resource dirs", async () => {
		const settings = { defaultModel: "claude-sonnet-4-5", theme: "dark", customKey: { nested: true } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const generated = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));

		expect(generated.defaultModel).toBe("claude-sonnet-4-5");
		expect(generated.customKey).toEqual({ nested: true });
		// The discovery root moved with PI_CODING_AGENT_DIR, so the real
		// agent dir's skills dir must be re-included explicitly.
		expect(generated.skills).toContain(path.join(fixture.agentDir, "skills"));
	});

	it("writes an empty settings object when the user has none", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"))).toEqual({});
	});

	it("does not set defaultProjectTrust for the default profile", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const settings = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultProjectTrust).toBeUndefined();
	});

	it("symlinks trust/auth/models state back to the real agent dir", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "models.json"), "{}");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "trust.json", "models.json"]) {
			expect(await realpath(path.join(result.runtimeDir, name))).toBe(await realpath(path.join(fixture.agentDir, name)));
		}
	});

	it("points PI_CODING_AGENT_DIR at the runtime dir and sessions at the real dir", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.env.PI_CODING_AGENT_DIR).toBe(result.runtimeDir);
		expect(result.env.PI_CODING_AGENT_SESSION_DIR).toBe(path.join(fixture.agentDir, "sessions"));
	});

	it("generates no filtering flags for the default profile", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.flags).toEqual([]);
	});

	it("places the runtime dir under the agent dir's pi-profile runtime root", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.runtimeDir.startsWith(path.join(fixture.agentDir, "pi-profile", "runtime"))).toBe(true);
	});
});
