import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_PID_GRACE_MS, sweepStaleRuntimeDirs } from "../src/launcher/runtime-cleanup.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function runtimeRoot(): string {
	return path.join(fixture.agentDir, "pi-profile", "runtime");
}

async function makeLaunchDir(name: string, options: { pid?: number; mtimeAgeMs?: number } = {}): Promise<string> {
	const dir = path.join(runtimeRoot(), name);
	await mkdir(dir, { recursive: true });
	if (options.pid !== undefined) {
		await writeFile(path.join(dir, "pid"), String(options.pid));
	}
	if (options.mtimeAgeMs !== undefined) {
		const past = new Date(Date.now() - options.mtimeAgeMs);
		await utimes(dir, past, past);
	}
	return dir;
}

/** Spawns a child that exits immediately and returns its (now dead) pid. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise<void>((resolve) => child.on("exit", () => resolve()));
	if (child.pid === undefined) throw new Error("child pid missing");
	return child.pid;
}

describe("sweepStaleRuntimeDirs", () => {
	it("deletes a launch dir whose pid is dead", async () => {
		const stale = await makeLaunchDir("launch-dead", { pid: await deadPid() });

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(stale)).toBe(false);
	});

	it("keeps a launch dir whose pid is alive", async () => {
		const live = await makeLaunchDir("launch-live", { pid: process.pid });

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(live)).toBe(true);
	});

	it("deletes a launch dir without a pid file once past the grace window", async () => {
		const old = await makeLaunchDir("launch-old", { mtimeAgeMs: NO_PID_GRACE_MS + 60_000 });

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(old)).toBe(false);
	});

	it("keeps a launch dir without a pid file inside the grace window (concurrent-launch race)", async () => {
		const fresh = await makeLaunchDir("launch-fresh");

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(fresh)).toBe(true);
	});

	it("deletes a launch dir whose pid file is unparseable once past the grace window", async () => {
		// Write the pid file before backdating: writing into a dir refreshes its mtime.
		const dir = path.join(runtimeRoot(), "launch-garbage");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "pid"), "not-a-pid");
		const past = new Date(Date.now() - NO_PID_GRACE_MS - 60_000);
		await utimes(dir, past, past);

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(dir)).toBe(false);
	});

	it("returns normally when the runtime root does not exist", async () => {
		await expect(sweepStaleRuntimeDirs(fixture.agentDir)).resolves.toBeUndefined();
	});

	it("ignores entries that are not launch dirs", async () => {
		const keep = path.join(runtimeRoot(), "other-entry");
		await mkdir(keep, { recursive: true });

		await sweepStaleRuntimeDirs(fixture.agentDir);

		expect(existsSync(keep)).toBe(true);
	});
});
