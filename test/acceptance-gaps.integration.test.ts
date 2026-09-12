/**
 * Integration: the PRD acceptance bullets that earlier tickets left thin
 * (ticket 12 review findings):
 *
 * - Same-name command conflicts end exactly per Pi's load order (the
 *   runner keeps the first registration and suffixes later ones with :N);
 * - deleting a project profile override reveals the global definition on
 *   the next reload;
 * - a shared skill's edit reaches EVERY referencing profile (observed via
 *   a second profile, not just the reloaded one);
 * - a profile without `mcp` activates fine with the adapter absent.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcDriver } from "./helpers/rpc-driver.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;
let driver: RpcDriver;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
	return { ...process.env, HOME: fixture.root, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1" };
}

async function start(profile: string): Promise<void> {
	driver = new RpcDriver("node", [BIN, profile, "--", "--mode", "rpc"], { cwd: fixture.cwd, env: env() });
	await driver.send({ type: "get_state" });
}

async function writeCatalog(profiles: Record<string, unknown>, scope: "global" | "project" = "global"): Promise<void> {
	const file = scope === "global" ? path.join(fixture.agentDir, "profiles.json") : path.join(fixture.cwd, ".pi", "profiles.json");
	await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles }));
}

/** An extension registering command `shared-cmd` (the same name for both). */
async function conflictingExtension(name: string): Promise<string> {
	const file = path.join(fixture.agentDir, "extensions", `${name}.ts`);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(
		file,
		[
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand("shared-cmd", { description: "from ${name}", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

describe("PRD acceptance gap coverage", () => {
	it("same-name command conflicts resolve per Pi's load order (first wins, :N suffixes)", async () => {
		const a = await conflictingExtension("aaa-first");
		const b = await conflictingExtension("bbb-second");
		await writeFile(
			path.join(fixture.agentDir, "resources.json"),
			JSON.stringify({
				schemaVersion: 1,
				resources: {
					"ext-a": { kind: "extension", entry: a },
					"ext-b": { kind: "extension", entry: b },
				},
			}),
		);
		await writeCatalog({ duo: { extensions: ["ext-a", "ext-b"] } });
		await start("duo");

		interface CommandInfo {
			name: string;
			description?: string;
		}
		const response = await driver.send({ type: "get_commands" });
		const shared = ((response.data?.commands ?? []) as CommandInfo[]).filter(
			(command) => command.name === "shared-cmd" || command.name.startsWith("shared-cmd:"),
		);
		// Pi's documented outcome: with a duplicate name BOTH get :N suffixes
		// in load order (:1 = first registration) — activation never blocked.
		expect(shared.map((command) => command.name).sort()).toEqual(["shared-cmd:1", "shared-cmd:2"]);
		expect(shared.find((command) => command.name === "shared-cmd:1")?.description).toBe("from aaa-first");
		expect(shared.find((command) => command.name === "shared-cmd:2")?.description).toBe("from bbb-second");
	}, 90_000);

	it("deleting the project override reveals the global definition on reload", async () => {
		await writeCatalog({ shared: { label: "global shared" } });
		await writeCatalog({ shared: { label: "project shared" } }, "project");
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await start("shared");

		await driver.send({ type: "prompt", message: "/profile status" }, 60_000);
		await driver.waitFor((message) => JSON.stringify(message).includes("profile: shared (project)"));

		// Delete the project record on disk, reload → global revealed.
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: {} }),
		);
		await driver.send({ type: "prompt", message: "/profile reload" }, 60_000);
		await driver.send({ type: "prompt", message: "/profile status" }, 60_000);
		await driver.waitFor((message) => JSON.stringify(message).includes("profile: shared (global)"));
	}, 90_000);

	it("a shared skill edit reaches every referencing profile", async () => {
		await addGlobalSkill(fixture, "shared-skill");
		await writeCatalog({ alpha: { skills: ["shared-skill"] }, beta: { skills: ["shared-skill"] } });
		await start("alpha");

		const skillFile = path.join(fixture.agentDir, "skills", "shared-skill", "SKILL.md");
		await writeFile(skillFile, "---\nname: shared-skill\ndescription: EDITED everywhere\n---\nbody\n");

		// Profile alpha reloads in place…
		await driver.send({ type: "prompt", message: "/profile reload" }, 60_000);
		let commands = ((await driver.send({ type: "get_commands" })).data?.commands ?? []) as Array<{ name: string; description?: string }>;
		expect(commands.find((command) => command.name === "skill:shared-skill")?.description).toBe(
			"EDITED everywhere",
		);

		// …and beta, referencing the same file, sees the same edit.
		await driver.send({ type: "prompt", message: "/profile use beta" }, 60_000);
		commands = ((await driver.send({ type: "get_commands" })).data?.commands ?? []) as Array<{ name: string; description?: string }>;
		expect(commands.find((command) => command.name === "skill:shared-skill")?.description).toBe(
			"EDITED everywhere",
		);
	}, 90_000);

	it("a profile without mcp activates with the adapter absent", async () => {
		await addGlobalSkill(fixture, "plain");
		await writeCatalog({ plain: { skills: ["plain"] } });
		// No adapter anywhere. Launch must succeed with only the profile's skill.
		await start("plain");
		expect(await driver.skillCommandNames()).toEqual(["skill:plain"]);
	}, 90_000);
});
