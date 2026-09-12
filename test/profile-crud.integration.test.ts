/**
 * Integration: profile catalog CRUD mode gating against a real spawned pi
 * (tickets 09 + 11).
 *
 * In RPC mode `/profile create|edit|delete|duplicate` are refused with a
 * mode-aware message and the catalogs stay untouched; switching
 * (`/profile use`) is NOT CRUD and keeps working. The wizard flows are
 * unit-tested at the command handler with a TUI-mode fake context
 * (test/extension.test.ts); interactive TUI acceptance is manual.
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
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: { review: { skills: ["review"] }, impl: { skills: ["impl"] } },
		}),
	);
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

const profilesFile = async () =>
	JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8")).profiles;

describe("profile catalog CRUD mode gating in RPC mode", () => {
	it("create/edit/delete/duplicate are refused with a mode-aware message; catalogs untouched", async () => {
		await start("review");

		for (const args of ["create", "edit review", "delete review", "duplicate"]) {
			await driver.send({ type: "prompt", message: `/profile ${args}` }, 60_000);
			await driver.waitFor((message) => {
				const text = JSON.stringify(message);
				return text.includes("requires TUI mode") && text.includes("rpc");
			});
		}

		expect(await profilesFile()).toEqual({ review: { skills: ["review"] }, impl: { skills: ["impl"] } });
	}, 90_000);

	it("switching is not CRUD: /profile use keeps working in RPC mode", async () => {
		await start("review");
		expect(await driver.skillCommandNames()).toEqual(["skill:review"]);

		await driver.send({ type: "prompt", message: "/profile use impl" }, 60_000);
		expect(await driver.skillCommandNames()).toEqual(["skill:impl"]);
	}, 90_000);
});
