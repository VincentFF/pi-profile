/**
 * Integration: /profile resource CRUD against a real spawned pi (ticket 08).
 *
 * Drives the interactive wizard through the RPC dialog protocol:
 * - create captures id/entry/dependsOn/alwaysOn into the chosen scope file,
 *   and an alwaysOn entry is loaded by the wizard's automatic reload
 *   (marker file written by the extension's session_start);
 * - delete is refused while a profile references the entry (error notify,
 *   file untouched), and succeeds once unreferenced.
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

async function start(profile = "default"): Promise<void> {
	driver = new RpcDriver("node", [BIN, profile, "--", "--mode", "rpc"], { cwd: fixture.cwd, env: env() });
	await driver.send({ type: "get_state" });
}

async function command(text: string, timeoutMs = 60_000): Promise<void> {
	await driver.send({ type: "prompt", message: `/${text}` }, timeoutMs);
}

function notifyEvents(): string[] {
	return driver.messages
		.filter(
			(message) =>
				typeof message === "object" &&
				message !== null &&
				(message as { type?: string }).type === "extension_ui_request" &&
				(message as { method?: string }).method === "notify",
		)
		.map((message) => String((message as { message?: unknown }).message));
}

/** An extension that proves it loaded by writing a marker on session_start. */
async function markerExtension(): Promise<{ entryPath: string; marker: string }> {
	const marker = path.join(fixture.root, "LOADED.marker");
	const entryPath = path.join(fixture.root, "marked-extension.ts");
	await mkdir(path.dirname(entryPath), { recursive: true });
	await writeFile(
		entryPath,
		[
			`import { writeFileSync } from "node:fs";`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.on("session_start", async () => { writeFileSync(${JSON.stringify(marker)}, "loaded"); });`,
			`}`,
			"",
		].join("\n"),
	);
	return { entryPath, marker };
}

describe("resource CRUD against a real spawned pi", () => {
	it("create captures all fields and the reload loads an alwaysOn entry", async () => {
		// alwaysOn entries load in named profiles (the built-in default
		// resolves zero pi-profile resources by design — ticket 02).
		await addGlobalSkill(fixture, "review");
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["review"] } } }),
		);
		await start("review");
		const { entryPath, marker } = await markerExtension();
		// dependsOn references must exist, or the post-create reload fails
		// resolution loudly (and rolls back) — as designed.
		await writeFile(
			path.join(fixture.agentDir, "resources.json"),
			JSON.stringify({
				schemaVersion: 1,
				resources: {
					base: { kind: "extension", entry: entryPath },
					tools: { kind: "extension", entry: entryPath },
				},
			}),
		);

		driver.answerDialogs([
			{ value: "global" }, // scope
			{ value: "linter" }, // id
			{ value: entryPath }, // entry path
			{ value: "base, tools" }, // dependsOn
			{ confirmed: true }, // alwaysOn
		]);
		await command("profile resource create");

		const raw = JSON.parse(await readFile(path.join(fixture.agentDir, "resources.json"), "utf8"));
		expect(raw.resources.linter).toEqual({
			kind: "extension",
			entry: entryPath,
			dependsOn: ["base", "tools"],
			alwaysOn: true,
		});
		// The wizard's reload re-executed extensions — the alwaysOn entry ran.
		const deadline = Date.now() + 10_000;
		for (;;) {
			try {
				expect(await readFile(marker, "utf8")).toBe("loaded");
				break;
			} catch {
				if (Date.now() > deadline) throw new Error("marker never written");
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}, 90_000);

	it("delete is refused while referenced, succeeds once unreferenced", async () => {
		await start();
		const { entryPath } = await markerExtension();
		await writeFile(
			path.join(fixture.agentDir, "resources.json"),
			JSON.stringify({ schemaVersion: 1, resources: { linter: { kind: "extension", entry: entryPath } } }),
		);
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: { extensions: ["linter"] } } }),
		);

		driver.answerDialogs([{ confirmed: true }]);
		await command("profile resource delete linter");
		await driver.waitFor((message) => JSON.stringify(message).includes("referenced by"));
		expect(
			JSON.parse(await readFile(path.join(fixture.agentDir, "resources.json"), "utf8")).resources.linter,
		).toBeDefined();

		// Drop the reference, delete for real: entry gone, registry rewritten.
		await writeFile(
			path.join(fixture.agentDir, "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { review: {} } }),
		);
		driver.answerDialogs([{ confirmed: true }]);
		await command("profile resource delete linter");
		await driver.waitFor((message) => JSON.stringify(message).includes("deleted resource"));
		expect(
			JSON.parse(await readFile(path.join(fixture.agentDir, "resources.json"), "utf8")).resources.linter,
		).toBeUndefined();
	}, 90_000);
});
