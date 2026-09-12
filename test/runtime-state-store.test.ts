import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/runtime-state-store.ts";
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

describe("RuntimeStateStore (global scope)", () => {
	it("reads the saved active profile from the global state file", async () => {
		await writeState({ activeProfile: "review" });

		const store = new RuntimeStateStore(fixture.agentDir);
		const state = await store.read();

		expect(state.activeProfile).toBe("review");
	});

	it("returns an empty state when no state file exists", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);

		expect(await store.read()).toEqual({});
	});

	it("returns an empty state on malformed content rather than failing the launch", async () => {
		await writeState("{ not json");

		const store = new RuntimeStateStore(fixture.agentDir);

		expect(await store.read()).toEqual({});
	});

	it("ignores non-string activeProfile values", async () => {
		await writeState({ activeProfile: 42 });

		const store = new RuntimeStateStore(fixture.agentDir);

		expect((await store.read()).activeProfile).toBeUndefined();
	});
});
