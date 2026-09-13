import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/runtime-state-store.ts";
import { CUSTOMIZE_USAGE, customizeOverlay, parseCustomizeArgs, resetOverlay } from "../src/switching/customize.ts";
import { ActivationError, type ActivationDeps } from "../src/switching/activate-profile.ts";
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
				review: { skills: ["git-commit", "code-review"], tools: ["read"], mcp: ["atlassian"] },
				broken: { mcp: ["ghost-server"] },
			},
		}),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function deps(): ActivationDeps {
	const { surface } = fakeApplySurface();
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
	};
}

const target = { profile: { name: "review", source: "global" as const } };

describe("parseCustomizeArgs", () => {
	it("disables a skill", () => {
		expect(parseCustomizeArgs("disable skill git-commit")({})).toEqual({ disabledSkills: ["git-commit"] });
	});

	it("disables an mcp server", () => {
		expect(parseCustomizeArgs("disable mcp atlassian")({})).toEqual({ disabledMcp: ["atlassian"] });
	});

	it("re-enables a reference", () => {
		expect(parseCustomizeArgs("enable skill git-commit")({ disabledSkills: ["git-commit"] })).toEqual({});
	});

	it("replaces tool references and clears them", () => {
		expect(parseCustomizeArgs("tools read grep")({})).toEqual({ tools: ["read", "grep"] });
		expect(parseCustomizeArgs("tools")({ tools: ["read"] })).toEqual({});
	});

	it("rejects an unknown kind or malformed action", () => {
		expect(() => parseCustomizeArgs("disable extension x")).toThrow(ActivationError);
		expect(() => parseCustomizeArgs("disable skill")).toThrow(CUSTOMIZE_USAGE);
	});
});

describe("customizeOverlay / resetOverlay", () => {
	it("applies the narrowed selection and persists the overlay", async () => {
		const result = await customizeOverlay({ ...deps(), ...target }, (overlay) => ({
			...overlay,
			disabledSkills: ["git-commit"],
		}));

		expect(result.selection.skills).toEqual({
			refs: ["git-commit", "code-review"],
			disabled: ["git-commit"],
		});
		expect(await new RuntimeStateStore(fixture.agentDir).read()).toEqual({
			activeProfile: "review",
			overlay: { disabledSkills: ["git-commit"] },
		});
	});

	it("builds the mutation on top of the stored overlay", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({ activeProfile: "review", overlay: { disabledSkills: ["git-commit"] } });

		await customizeOverlay({ ...deps(), ...target }, parseCustomizeArgs("disable mcp atlassian"));

		expect(await store.read()).toEqual({
			activeProfile: "review",
			overlay: { disabledSkills: ["git-commit"], disabledMcp: ["atlassian"] },
		});
	});

	it("reactivates the declared profile and drops the overlay on reset", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({ activeProfile: "review", overlay: { disabledMcp: ["atlassian"] } });

		const result = await resetOverlay({ ...deps(), ...target });

		expect(result.selection.skills).toEqual({ refs: ["git-commit", "code-review"], disabled: [] });
		expect(result.selection.mcp).toEqual(["atlassian"]);
		expect(await store.read()).toEqual({ activeProfile: "review" });
	});

	it("leaves the stored overlay untouched when the activation fails", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({ activeProfile: "broken", overlay: { disabledSkills: ["git-commit"] } });

		await expect(
			customizeOverlay(
				{ ...deps(), profile: { name: "broken", source: "global" } },
				parseCustomizeArgs("disable skill git-commit"),
			),
		).rejects.toThrow(/unknown MCP server "ghost-server"/);
		expect(await store.read()).toEqual({
			activeProfile: "broken",
			overlay: { disabledSkills: ["git-commit"] },
		});
	});
});
