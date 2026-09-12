/**
 * Integration: /profile create|edit|delete against a real spawned pi
 * (ticket 09), driving the wizards through the RPC dialog protocol.
 *
 * - create writes the chosen scope catalog and the profile is immediately
 *   usable (visible in /profile list, activatable via /profile use);
 * - editing the ACTIVE profile reloads in place — resolved skills swap;
 * - deleting the active profile requires a replacement selection, then the
 *   session switches to it.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcDriver } from "./helpers/rpc-driver.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;
let driver: RpcDriver;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "review");
	await addGlobalSkill(fixture, "impl");
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

async function start(profile: string): Promise<void> {
	driver = new RpcDriver("node", [BIN, profile, "--", "--mode", "rpc"], {
		cwd: fixture.cwd,
		env: { ...process.env, HOME: fixture.root, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1" },
	});
	await driver.send({ type: "get_state" });
}

async function command(text: string, timeoutMs = 60_000): Promise<void> {
	await driver.send({ type: "prompt", message: `/${text}` }, timeoutMs);
}

async function messageContaining(fragment: string): Promise<unknown> {
	return driver.waitFor((message) => JSON.stringify(message).includes(fragment));
}

async function profilesFile(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8")).profiles;
}

describe("profile catalog CRUD against a real spawned pi", () => {
	it("create → listed with source → usable via /profile use", async () => {
		await start("default");

		driver.answerDialogs([
			{ value: "global" }, // scope (project is trusted: empty .pi)
			{ value: "qa" }, // name
			{ value: "QA profile" }, // label
			{ value: "" }, // description
			{ value: "" }, // skills
			{ value: "" }, // extensions
			{ value: "" }, // mcp
			{ value: "" }, // tools
			{ value: "" }, // instructions
			{ value: "" }, // model
		]);
		await command("profile create");
		await messageContaining("created profile");

		expect(await profilesFile()).toEqual({ qa: { label: "QA profile" } });

		await command("profile list");
		await messageContaining("qa [global]");

		// Immediately usable: switching to it works through the standard path.
		await command("profile use qa");
		expect(await driver.skillCommandNames()).toEqual([]);
	}, 90_000);

	it("editing the active profile reloads in place with the new skills", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["review"] } } }),
		);
		await start("review");
		expect(await driver.skillCommandNames()).toEqual(["skill:review"]);

		// Edit: keep label/description empty, change skills to impl.
		driver.answerDialogs([
			{ value: "" }, // label (keep)
			{ value: "" }, // description
			{ value: "impl" }, // skills — replaced wholesale
			{ value: "" },
			{ value: "" },
			{ value: "" },
			{ value: "" },
			{ value: "" },
		]);
		await command("profile edit review");

		expect((await profilesFile()).review).toEqual({ skills: ["impl"] });
		expect(await driver.skillCommandNames()).toEqual(["skill:impl"]);
	}, 90_000);

	it("deleting the active profile requires choosing a replacement, then switches", async () => {
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({
				schemaVersion: 1,
				profiles: { review: { skills: ["review"] }, impl: { skills: ["impl"] } },
			}),
		);
		await start("review");

		driver.answerDialogs([{ value: "impl [global]" }]); // replacement selection
		await command("profile delete review");
		await messageContaining("switching to");

		expect((await profilesFile()).review).toBeUndefined();
		expect(await driver.skillCommandNames()).toEqual(["skill:impl"]);
	}, 90_000);
});
