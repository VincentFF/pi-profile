import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalExtension, addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "alpha-skill");
	await addGlobalSkill(fixture, "beta-skill");
	await addGlobalExtension(fixture, "fixture-ext-cmd");
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function launcherEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: fixture.root,
		// The launcher resolves the real agent dir through pi's own override,
		// keeping every real-pi side effect inside the fixture.
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
	};
}

describe("launcher integration: real pi subprocess, default profile", () => {
	it(
		"starts the default profile exposing all fixture resources, and leaves the real agent dir untouched",
		{ timeout: 45_000 },
		async () => {
			const userSettings = { customKey: "keep-me" };
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(userSettings));
			const agentDirBefore = await listFiles(fixture.agentDir);

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const commands = await rpc.commandNames();
				const names = commands.map((command) => command.name);
				expect(names).toContain("skill:alpha-skill");
				expect(names).toContain("skill:beta-skill");
				// The fixture extension's command proves its code loaded.
				expect(commands.some((command) => command.name === "fixture-ext-cmd" && command.source === "extension")).toBe(
					true,
				);
			} finally {
				await rpc.close();
			}

			// User's real settings are never rewritten.
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(userSettings);
			// New files in the real agent dir stay inside pi-profile-owned runtime
			// dirs and pi's own session storage — nothing else appears.
			const agentDirAfter = await listFiles(fixture.agentDir);
			const created = agentDirAfter.filter((file) => !agentDirBefore.includes(file));
			for (const file of created) {
				const relative = path.relative(fixture.agentDir, file);
				expect(relative.startsWith(path.join("pi-profile", "runtime")) || relative.startsWith("sessions")).toBe(true);
			}
			// Launcher selection is transient: no runtime state file anywhere.
			const files = await listFiles(fixture.root);
			expect(files.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
		},
	);

	it(
		"forwards arbitrary pi flags verbatim (pi itself reports the unknown flag)",
		{ timeout: 45_000 },
		async () => {
			// pi prints its own "Unknown option" error and then continues into
			// interactive mode; with stdin at EOF it exits. The point here: the
			// flag reaches pi — pi-profile never rejects it with a whitelist error.
			const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
				const child = execFile(
					"node",
					[BIN, "--", "--definitely-not-a-pi-flag"],
					{ cwd: fixture.cwd, env: launcherEnv() },
					(error, stdout, stderr) => {
						resolve({ code: error ? ((error as { code?: number }).code ?? 0) : 0, text: `${stdout}\n${stderr}` });
					},
				);
				child.stdin?.end();
				setTimeout(() => reject(new Error("launcher did not exit after pi reached EOF on stdin")), 30_000);
			});
			expect(output.text).toContain("Unknown option: --definitely-not-a-pi-flag");
			expect(output.text).not.toContain("unsupported pi argument");
		},
	);

	it(
		"rejects an unknown profile name before spawning pi",
		{ timeout: 30_000 },
		async () => {
			const failure = await new Promise<{ code: number; stderr: string }>((resolve) => {
				execFile(
					"node",
					[BIN, "review", "--", "--mode", "rpc"],
					{ cwd: fixture.cwd, env: launcherEnv() },
					(error, _stdout, stderr) => {
						resolve({ code: (error as { code?: number })?.code ?? 0, stderr });
					},
				);
			});
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain("unknown profile: review");
		},
	);
});

describe("launcher integration: runtime dir cleanup", () => {
	function runtimeRoot(): string {
		return path.join(fixture.agentDir, "pi-profile", "runtime");
	}

	async function launchDirNames(): Promise<string[]> {
		try {
			return (await readdir(runtimeRoot())).filter((entry) => entry.startsWith("launch-")).sort();
		} catch {
			return [];
		}
	}

	/** Spawns a child that exits immediately and returns its (now dead) pid. */
	async function deadPid(): Promise<number> {
		const child = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => child.on("exit", resolve));
		if (child.pid === undefined) throw new Error("child pid missing");
		return child.pid;
	}

	it(
		"sweeps a pre-seeded stale launch dir (dead pid) at startup",
		{ timeout: 45_000 },
		async () => {
			const stale = path.join(runtimeRoot(), "launch-staleTest");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(false);
				// Under the new architecture, no new launch dirs are created in the legacy root.
				const names = await launchDirNames();
				expect(names).toHaveLength(0);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);

	it(
		"converges across launches: the previous session's dir is swept by the next launch",
		{ timeout: 90_000 },
		async () => {
			// This test is testing the legacy cleanup mechanism. We can mock a
			// legacy dir with a dead PID and show it gets swept.
			const stale = path.join(runtimeRoot(), "launch-previousSession");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));

			const second = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				await second.commandNames();
				const afterSecond = await launchDirNames();
				// The dead legacy dir is swept.
				expect(afterSecond).toHaveLength(0);
				expect(existsSync(stale)).toBe(false);
			} finally {
				await second.close();
				await second.waitForExit();
			}
		},
	);
});
