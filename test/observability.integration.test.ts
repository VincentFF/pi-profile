/**
 * Integration: /profile list and /profile status against a real spawned pi.
 *
 * - `/profile list` shows built-in/global/project profiles with the winning
 *   source (a same-name project profile shadows the global one).
 * - `/profile status` reports resolved absolute skill paths, the MCP
 *   tri-state, and — after an in-session switch — the glob delta versus
 *   the previous activation.
 *
 * The extension ships both via `pi.sendMessage`, which RPC streams as
 * session events; the driver's `waitFor` watches for them.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcDriver } from "./helpers/rpc-driver.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

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
			profiles: { review: { skills: ["review"] }, impl: { skills: ["impl"] }, shared: {} },
		}),
	);
	await writeFile(
		path.join(fixture.cwd, ".pi", "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles: { shared: { label: "project shared" } } }),
	);
	// A global MCP server exists but no profile selects it: status must show
	// it as discovered-but-disabled.
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

async function start(profile = "review"): Promise<void> {
	// Pre-seed trust so the project catalog participates.
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
	driver = new RpcDriver("node", [path.resolve("bin/pi-profile.ts"), profile, "--", "--mode", "rpc"], {
		cwd: fixture.cwd,
		env: {
			...process.env,
			HOME: fixture.root,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			PI_OFFLINE: "1",
		},
	});
	await driver.send({ type: "get_state" });
}

async function command(text: string, timeoutMs = 60_000): Promise<void> {
	await driver.send({ type: "prompt", message: `/${text}` }, timeoutMs);
}

async function messageContaining(fragment: string): Promise<unknown> {
	return driver.waitFor((message) => JSON.stringify(message).includes(fragment));
}

describe("observability surface against a real spawned pi", () => {
	it("/profile list shows sources and project shadowing", async () => {
		await start();

		await command("profile list");

		await messageContaining("shared [project] (shadows global)");
		const seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain("default [builtin]");
		expect(seen).toContain("review [global]");
		expect(seen).toContain("shared [project] (shadows global) — project shared");
	}, 90_000);

	it("/profile status shows resolved paths, mcp tri-state, and the switch delta", async () => {
		await start();

		await command("profile status");
		await messageContaining("profile: review (global)");
		let seen = driver.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(seen).toContain(`review → ${path.join(fixture.agentDir, "skills", "review", "SKILL.md")}`);
		expect(seen).toContain("disabled=[github]");

		// RPC-consumable structured form (ticket 11): the custom message
		// carries the report object in details.
		const structured = driver.messages.find(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				JSON.stringify(message).includes('"kind":"status"') &&
				JSON.stringify(message).includes('"profile":"review"'),
		);
		expect(structured).toBeDefined();

		// Switch (the prompt response returns after the handler's reload
		// settles), then status reflects the delta against the previous plan.
		await command("profile use impl");
		expect(await driver.skillCommandNames()).toEqual(["skill:impl"]);

		await command("profile status");
		await messageContaining("delta: +[skill:impl] -[skill:review]");
	}, 90_000);
});
