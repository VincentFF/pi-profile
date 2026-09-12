/**
 * Integration: resource CRUD mode gating against a real spawned pi
 * (tickets 08 + 11).
 *
 * In RPC mode the wizard mutations are unavailable with a mode-aware
 * message; the read-only surface (`/profile resource list`) keeps working.
 * The full wizard flows are unit-tested at the command handler with a
 * TUI-mode fake context (test/extension.test.ts); interactive TUI
 * acceptance is manual.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcDriver } from "./helpers/rpc-driver.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;
let driver: RpcDriver;

beforeEach(async () => {
	fixture = await createPiFixture();
	await writeFile(
		path.join(fixture.agentDir, "resources.json"),
		JSON.stringify({
			schemaVersion: 1,
			resources: { linter: { kind: "extension", entry: "/x/linter.ts", alwaysOn: false } },
		}),
	);
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

async function start(): Promise<void> {
	driver = new RpcDriver("node", [BIN, "default", "--", "--mode", "rpc"], {
		cwd: fixture.cwd,
		env: { ...process.env, HOME: fixture.root, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1" },
	});
	await driver.send({ type: "get_state" });
}

describe("resource CRUD mode gating in RPC mode", () => {
	it("mutations are refused with a mode-aware message; list stays read-only", async () => {
		await start();

		for (const args of ["create", "edit linter", "delete linter"]) {
			await driver.send({ type: "prompt", message: `/profile resource ${args}` }, 60_000);
			await driver.waitFor((message) => {
				const text = JSON.stringify(message);
				return text.includes("requires TUI mode") && text.includes("rpc");
			});
		}

		// Registry untouched by every refused mutation.
		const raw = JSON.parse(await readFile(path.join(fixture.agentDir, "resources.json"), "utf8"));
		expect(raw.resources.linter).toBeDefined();

		// The read path still works in RPC mode.
		await driver.send({ type: "prompt", message: "/profile resource list" }, 60_000);
		await driver.waitFor((message) => JSON.stringify(message).includes("linter [global]"));
	}, 90_000);
});
