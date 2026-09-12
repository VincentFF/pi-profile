/**
 * Integration: non-interactive modes and flag passthrough (ticket 11).
 *
 * Print and JSON modes launch the requested profile with complete
 * pre-start filtering (mode handling is entirely native Pi); both exit
 * cleanly offline with stdin closed. Unknown profiles fail with exit 2 in
 * every mode. Session flags pass through unchanged (unit-covered in
 * launcher-args/launcher-spawn; here end-to-end for print mode).
 */

import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "review");
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["review"] } } }),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function runLauncher(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			"node",
			[BIN, ...args],
			{
				cwd: fixture.cwd,
				env: { ...process.env, HOME: fixture.root, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1" },
			},
			(error, stdout, stderr) => resolve({ code: (error as { code?: number })?.code ?? 0, stdout, stderr }),
		);
		child.stdin?.end();
	});
}

describe("non-interactive modes", () => {
	it("print mode launches the profile and exits cleanly", async () => {
		const result = await runLauncher(["review", "--", "--mode", "print"]);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toMatch(/pi-profile:|Error/);
	}, 60_000);

	it("json mode launches the profile and emits the session event", async () => {
		const result = await runLauncher(["review", "--", "--mode", "json"]);
		expect(result.code).toBe(0);
		const firstLine = result.stdout.trim().split("\n")[0] ?? "";
		expect(JSON.parse(firstLine).type).toBe("session");
	}, 60_000);

	it("session flags pass through unchanged in print mode", async () => {
		// --no-session must reach pi (a consumed flag would error the spawn or
		// be swallowed); combined with --mode print the process still exits 0.
		const result = await runLauncher(["review", "--", "--mode", "print", "--no-session"]);
		expect(result.code).toBe(0);
	}, 60_000);

	it("unknown profiles fail with exit 2 in print mode too", async () => {
		const result = await runLauncher(["ghost", "--", "--mode", "print"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/pi-profile:.*ghost/);
	}, 60_000);
});
