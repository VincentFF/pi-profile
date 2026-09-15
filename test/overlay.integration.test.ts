import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function skillNames(rpc: RpcDriver): Promise<string[]> {
	return (await rpc.skillCommandNames()).sort();
}

async function readState(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"));
}

describe("launcher integration: runtime overlay", () => {
	it(
		"customize narrows the runtime only: state holds the overlay, the catalog is untouched, the next launch ignores it",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);

				const customized = await rpc.send(
					{ type: "prompt", message: "/profile customize disable skill beta-skill" },
					60_000,
				);
				expect(customized.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill"]);

				// Overlay persisted to runtime state; the catalog file is untouched.
				expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
				const catalog = JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8"));
				expect(catalog.profiles.review.skills).toEqual(["alpha-skill", "beta-skill"]);

				// Reset restores the declared set.
				const reset = await rpc.send({ type: "prompt", message: "/profile reset" }, 60_000);
				expect(reset.success).toBe(true);
				expect(await skillNames(rpc)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
				expect((await readState()).overlay).toBeUndefined();
			} finally {
				await rpc.close();
			}

			// A fresh launch restores the profile WITHOUT the discarded overlay
			// (the launcher never reads stored overlays).
			const relaunched = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				expect(await skillNames(relaunched)).toEqual(["skill:alpha-skill", "skill:beta-skill"]);
			} finally {
				await relaunched.close();
			}
		},
	);

	it(
		"an overlay can disable a resolved extension",
		{ timeout: 60_000 },
		async () => {
			const extensionsDir = path.join(fixture.agentDir, "extensions");
			const extFile = path.join(extensionsDir, "my-ext.ts");
			await mkdir(extensionsDir, { recursive: true });
			await writeFile(
				extFile,
				[
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.registerCommand("my-ext-cmd", { description: "from my-ext", handler: async () => {} });`,
					`}`,
					"",
				].join("\n"),
			);
			await writeCatalog({ review: { extensions: ["my-ext"] } });

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const commands = await rpc.commandNames();
				expect(commands.some((c) => c.name === "my-ext-cmd")).toBe(true);

				const disableAttempt = await rpc.send(
					{ type: "prompt", message: "/profile customize disable extension my-ext" },
					60_000,
				);
				expect(disableAttempt.success).toBe(true);

				const state = (await readState()) as { overlay?: { disabledExtensions?: string[] } };
				expect(state.overlay?.disabledExtensions).toEqual(["my-ext"]);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"a switch discards the previous profile's overlay",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				review: { skills: ["alpha-skill", "beta-skill"] },
				impl: { skills: ["beta-skill"] },
			});

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				await rpc.send({ type: "prompt", message: "/profile customize disable skill beta-skill" }, 60_000);
				expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });

				const switched = await rpc.send({ type: "prompt", message: "/profile use impl" }, 60_000);
				expect(switched.success).toBe(true);

				expect(await skillNames(rpc)).toEqual(["skill:beta-skill"]);
				const state = await readState();
				expect(state.activeProfile).toBe("impl");
				expect(state.overlay).toBeUndefined();
			} finally {
				await rpc.close();
			}
		},
	);
});
