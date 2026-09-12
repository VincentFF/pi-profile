import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "alpha-skill");
	await addGlobalSkill(fixture, "beta-skill");
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
		"starts the default profile exposing all fixture skills, and leaves user settings untouched",
		{ timeout: 45_000 },
		async () => {
			const userSettings = { customKey: "keep-me" };
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(userSettings));

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				// Startup settle: the first command round-trip implies the session is up.
				const skills = await rpc.skillCommandNames();
				expect(skills).toContain("skill:alpha-skill");
				expect(skills).toContain("skill:beta-skill");
			} finally {
				await rpc.close();
			}

			// User's real settings are never rewritten.
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(userSettings);
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
