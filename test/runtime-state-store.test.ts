import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStateStore, overlayNarrows } from "../src/runtime-state-store.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeState(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "pi-profile-state.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

function store(): RuntimeStateStore {
	return new RuntimeStateStore(fixture.agentDir);
}

describe("RuntimeStateStore", () => {
	it("reads the saved active profile and overlay", async () => {
		await writeState({
			activeProfile: "review",
			overlay: { disabledSkills: ["git-commit"], disabledMcp: ["atlassian"], tools: ["read", "grep"] },
		});

		expect(await store().read()).toEqual({
			activeProfile: "review",
			overlay: { disabledSkills: ["git-commit"], disabledMcp: ["atlassian"], tools: ["read", "grep"] },
		});
	});

	it("returns an empty state when no state file exists", async () => {
		expect(await store().read()).toEqual({});
	});

	it("returns an empty state on malformed content rather than failing the session", async () => {
		await writeState("{ not json");

		expect(await store().read()).toEqual({});
	});

	it("ignores non-string activeProfile values", async () => {
		await writeState({ activeProfile: 42 });

		expect(await store().read()).toEqual({});
	});

	it("ignores fields retired by ADR-0007 instead of misreading them", async () => {
		await writeState({
			activeProfile: "review",
			lastVerifiedProfile: "implement",
			overlay: { disabledSkills: ["x"], disabledExtensions: ["old"], disabledMcp: ["m"] },
		});

		expect(await store().read()).toEqual({
			activeProfile: "review",
			overlay: { disabledSkills: ["x"], disabledMcp: ["m"] },
		});
	});

	it("writes only current fields, dropping retired ones", async () => {
		await store().write({ activeProfile: "review", overlay: { tools: ["read"] } });

		const raw = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				path.join(fixture.agentDir, "pi-profile-state.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		expect(raw).toEqual({ activeProfile: "review", overlay: { tools: ["read"] } });
	});

	it("merges patches without clobbering the other field", async () => {
		await store().write({ activeProfile: "review", overlay: { disabledSkills: ["x"] } });

		await store().update({ activeProfile: "implement" });

		expect(await store().read()).toEqual({
			activeProfile: "implement",
			overlay: { disabledSkills: ["x"] },
		});
	});

	it("deletes a field patched with undefined", async () => {
		await store().write({ activeProfile: "review", overlay: { disabledSkills: ["x"] } });

		await store().update({ overlay: undefined });

		expect(await store().read()).toEqual({ activeProfile: "review" });
	});
});

describe("overlayNarrows", () => {
	it("sees no difference in no overlay or an emptied one", () => {
		expect(overlayNarrows(undefined)).toBe(false);
		expect(overlayNarrows({})).toBe(false);
		expect(overlayNarrows({ disabledSkills: [], disabledMcp: [] })).toBe(false);
	});

	it("sees a difference in a disabled entry or a tools override", () => {
		expect(overlayNarrows({ disabledSkills: ["x"] })).toBe(true);
		expect(overlayNarrows({ disabledMcp: ["atlassian"] })).toBe(true);
		// `tools: []` selects no tools: a runtime difference, not an empty overlay.
		expect(overlayNarrows({ tools: [] })).toBe(true);
	});
});
