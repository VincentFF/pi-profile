import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/runtime-state-store.ts";
import { ActivationError, activateProfile, type ActivationDeps } from "../src/switching/activate-profile.ts";
import { fakeApplySurface, liveResources } from "./helpers/fake-apply.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: {
				review: { skills: ["git-commit"], tools: ["read"], mcps: ["atlassian"] },
				plain: {},
				picky: { model: { provider: "openai", id: "gpt" } },
			},
		}),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<ActivationDeps> = {}): ActivationDeps & { calls: ReturnType<typeof fakeApplySurface>["calls"] } {
	const { surface, calls } = fakeApplySurface();
	return {
		agentDir: fixture.agentDir,
		cwd: fixture.cwd,
		projectTrusted: false,
		live: liveResources(),
		surface,
		presetInputs: {
			explicit: { model: false, thinking: false, tools: false },
			session: { hasRecordedModel: false, hasRecordedThinking: false },
			force: false,
		},
		calls,
		...overrides,
	};
}

async function readState(dir: string): Promise<unknown> {
	return JSON.parse(await readFile(path.join(dir, "pi-profile-state.json"), "utf8"));
}

describe("activateProfile", () => {
	it("applies the runtime parts and persists the selection", async () => {
		const deps = makeDeps();

		const result = await activateProfile("review", deps);

		expect(result.selection.name).toBe("review");
		expect(deps.calls.activeTools).toEqual([["read"]]);
		expect(deps.calls.emitted).toHaveLength(1);
		expect(await readState(fixture.agentDir)).toEqual({ activeProfile: "review" });
	});

	it("writes project profiles to the project state file", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["grep"] } } }),
		);
		const deps = makeDeps({ projectTrusted: true });

		await activateProfile("local", deps);

		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({ activeProfile: "local" });
		await expect(readState(fixture.agentDir)).rejects.toThrow();
	});

	it("clears a project selection when a global profile is activated", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["grep"] } } }),
		);
		const deps = makeDeps({ projectTrusted: true });
		await activateProfile("local", deps);

		await activateProfile("review", deps);

		// The saved selection lives in one scope only: the stale project entry
		// would shadow this global choice on the next startup.
		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({});
		expect(await readState(fixture.agentDir)).toEqual({ activeProfile: "review" });
	});

	it("clears a project selection when the built-in default is activated", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["grep"] } } }),
		);
		const deps = makeDeps({ projectTrusted: true });
		await activateProfile("local", deps);

		await activateProfile("default", deps);

		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({});
		expect(await readState(fixture.agentDir)).toEqual({ activeProfile: "default" });
	});

	it("keeps the project overlay that belongs to the project profile", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["grep"] } } }),
		);
		await writeFile(
			path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "local", overlay: { disabledSkills: ["git-commit"] } }),
		);
		const deps = makeDeps({ projectTrusted: true });

		await activateProfile("review", deps);

		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({
			overlay: { disabledSkills: ["git-commit"] },
		});
	});

	it("clears a global selection when a project profile is activated", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["grep"] } } }),
		);
		const deps = makeDeps({ projectTrusted: true });
		await activateProfile("review", deps);

		await activateProfile("local", deps);

		expect(await readState(fixture.agentDir)).toEqual({});
		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({ activeProfile: "local" });
	});

	it("never touches an untrusted project's state file", async () => {
		await writeFile(
			path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "local" }),
		);
		const deps = makeDeps({ projectTrusted: false });

		await activateProfile("review", deps);

		expect(await readState(fixture.agentDir)).toEqual({ activeProfile: "review" });
		// Left byte-identical: an untrusted project is not read or written.
		expect(await readState(path.join(fixture.cwd, ".pi"))).toEqual({ activeProfile: "local" });
	});

	it("does not persist a transient startup selection", async () => {
		const deps = makeDeps();

		await activateProfile("review", deps, { persist: false });

		await expect(readState(fixture.agentDir)).rejects.toThrow();
	});

	it("persists an overlay and clears it when none is given", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({ activeProfile: "plain", overlay: { disabledMcp: ["atlassian"] } });
		const deps = makeDeps();

		await activateProfile("review", deps, { overlay: { disabledSkills: ["git-commit"] } });
		expect(await store.read()).toEqual({
			activeProfile: "review",
			overlay: { disabledSkills: ["git-commit"] },
		});

		await activateProfile("review", deps, { overlay: null });
		expect(await store.read()).toEqual({ activeProfile: "review" });
	});

	it("fails with candidates for an unknown profile and changes nothing", async () => {
		const deps = makeDeps();

		await expect(activateProfile("ghost", deps)).rejects.toThrow(ActivationError);
		await expect(activateProfile("ghost", deps)).rejects.toThrow(/available: \[default, review, plain, picky\]/);
		expect(deps.calls.activeTools).toEqual([]);
		await expect(readState(fixture.agentDir)).rejects.toThrow();
	});

	it("fails before writing state when the model preset cannot be validated", async () => {
		const deps = makeDeps({
			surface: fakeApplySurface({ findModel: false }).surface,
			presetInputs: {
				explicit: { model: false, thinking: false, tools: false },
				session: { hasRecordedModel: false, hasRecordedThinking: false },
				force: false,
			},
		});

		await expect(activateProfile("picky", deps)).rejects.toThrow(/declared model openai\/gpt not found/);
		await expect(readState(fixture.agentDir)).rejects.toThrow();
	});

	it("fails loudly when a declared MCP server cannot be satisfied", async () => {
		const deps = makeDeps({ live: liveResources({ mcp: { adapterPresent: false, servers: [] } }) });

		await expect(activateProfile("review", deps)).rejects.toThrow(/pi-mcp-adapter is not active/);
		await expect(readState(fixture.agentDir)).rejects.toThrow();
	});

	it("suppresses the model preset for a recorded session choice but applies it on force", async () => {
		const quiet = makeDeps({
			presetInputs: {
				explicit: { model: false, thinking: false, tools: false },
				session: { hasRecordedModel: true, hasRecordedThinking: false },
				force: false,
			},
		});
		await activateProfile("picky", quiet);
		expect(quiet.calls.models).toEqual([]);

		const forced = makeDeps({
			presetInputs: {
				explicit: { model: false, thinking: false, tools: false },
				session: { hasRecordedModel: true, hasRecordedThinking: false },
				force: true,
			},
		});
		await activateProfile("picky", forced);
		expect(forced.calls.models).toEqual([{ provider: "openai", id: "gpt" }]);
	});

	it("inspects zero-match skill globs through the selection warnings", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["zzz-*"] } } }),
		);
		const deps = makeDeps();

		const result = await activateProfile("review", deps);

		expect(result.selection.warnings.skillsUnmatched).toEqual(["zzz-*"]);
	});

	it("lets a CLI --tools declaration keep the active set unless the user chooses a profile", async () => {
		const startup = makeDeps({
			presetInputs: {
				explicit: { model: false, thinking: false, tools: true },
				session: { hasRecordedModel: false, hasRecordedThinking: false },
				force: false,
			},
		});

		// review declares tools: ["read"] — suppressed while the CLI owns the set.
		await activateProfile("review", startup);
		expect(startup.calls.activeTools).toEqual([]);

		const explicitChoice = makeDeps({
			presetInputs: {
				explicit: { model: false, thinking: false, tools: true },
				session: { hasRecordedModel: false, hasRecordedThinking: false },
				force: true,
			},
		});
		await activateProfile("review", explicitChoice);
		expect(explicitChoice.calls.activeTools).toEqual([["read"]]);
	});
});
