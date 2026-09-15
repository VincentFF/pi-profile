import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function launcherEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
	};
}

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

interface RpcState {
	sessionId: string;
	sessionFile?: string;
	messageCount: number;
}

async function getState(rpc: RpcDriver): Promise<RpcState> {
	const response = await rpc.send({ type: "get_state" });
	return response.data as unknown as RpcState;
}

async function skillCommands(rpc: RpcDriver): Promise<Array<{ name: string; description?: string }>> {
	const response = await rpc.send({ type: "get_commands" });
	const commands = (response.data?.commands ?? []) as Array<{ name: string; description?: string }>;
	return commands.filter((command) => command.name.startsWith("skill:"));
}

describe("launcher integration: in-session switching", () => {
	it(
		"/profile use switches without restarting: same session, new resources, state persisted",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				alpha: { skills: ["alpha-skill"] },
				beta: { skills: ["beta-skill"] },
			});

			const rpc = new RpcDriver("node", [BIN, "alpha", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const before = await getState(rpc);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:alpha-skill"]);

				const switched = await rpc.send({ type: "prompt", message: "/profile use beta" }, 60_000);
				expect(switched.success).toBe(true);

				// Same session, unchanged history, new resource set.
				const after = await getState(rpc);
				expect(after.sessionId).toBe(before.sessionId);
				expect(after.sessionFile).toBe(before.sessionFile);
				// Session is stored in the project's native encoded subdirectory, not flat under sessions
				expect(before.sessionFile).toBeDefined();
				expect(path.basename(path.dirname(before.sessionFile!))).toMatch(/^--.+--$/);
				expect(after.messageCount).toBe(before.messageCount);
				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:beta-skill"]);

				// Selection + rollback anchor persisted to the global state file.
				const state = JSON.parse(
					await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"),
				);
				expect(state).toEqual({ activeProfile: "beta", lastVerifiedProfile: "beta" });
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"/profile reload picks up shared-resource edits without a restart",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ alpha: { skills: ["alpha-skill"] } });

			const rpc = new RpcDriver("node", [BIN, "alpha", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				expect((await skillCommands(rpc))[0]?.description).toContain("alpha-skill");

				// Edit the shared SKILL.md after activation; the profile file is untouched.
				const skillFile = path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md");
				await writeFile(
					skillFile,
					"---\nname: alpha-skill\ndescription: EDITED description\n---\nbody\n",
				);

				const reloaded = await rpc.send({ type: "prompt", message: "/profile reload" }, 60_000);
				expect(reloaded.success).toBe(true);

				expect((await skillCommands(rpc))[0]?.description).toBe("EDITED description");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a failed switch leaves the runtime and state untouched",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ alpha: { skills: ["alpha-skill"] } });

			const rpc = new RpcDriver("node", [BIN, "alpha", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const failed = await rpc.send({ type: "prompt", message: "/profile use ghost" }, 60_000);
				expect(failed.success).toBe(true); // the command handled the error itself

				expect((await skillCommands(rpc)).map((command) => command.name)).toEqual(["skill:alpha-skill"]);
				const { existsSync } = await import("node:fs");
				expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
			} finally {
				await rpc.close();
			}
		},
	);
});
