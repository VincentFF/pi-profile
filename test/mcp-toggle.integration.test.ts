/**
 * Integration: /mcp enable|disable against a real spawned pi (ticket 10).
 *
 * A fake pi-mcp-adapter (dir named like the package, answers the snapshot
 * probe, records published allowlists) verifies the full loop:
 * - /mcp enable appends to the ACTIVE profile's mcp array in its owning
 *   catalog and the post-reload allowlist carries the new server;
 * - /mcp disable removes it (stale cleanup covered by unit tests);
 * - switching profiles restores each profile's own MCP selection;
 * - the adapter's own mcp.json is byte-identical throughout.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcDriver } from "./helpers/rpc-driver.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;
let driver: RpcDriver;
let allowlistMarker: string;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "review");
	await addGlobalSkill(fixture, "impl");
	allowlistMarker = path.join(fixture.root, "ALLOWLIST.json");

	// Fake adapter: path named like the package, answers probes, records
	// every published allowlist.
	const dir = path.join(fixture.agentDir, "extensions", "pi-mcp-adapter");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "index.ts"),
		[
			`import { appendFileSync } from "node:fs";`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.events.on("pi-mcp-adapter:runtime-snapshot:v1", (request: unknown) => {`,
			`\t\t(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };`,
			`\t});`,
			`\tpi.events.on("pi-profile:mcp-allowlist:v1", (data: unknown) => {`,
			`\t\tappendFileSync(${JSON.stringify(allowlistMarker)}, JSON.stringify(data) + "\\n");`,
			`\t});`,
			`}`,
			"",
		].join("\n"),
	);
	await writeFile(
		path.join(fixture.agentDir, "resources.json"),
		JSON.stringify({
			schemaVersion: 1,
			resources: { "mcp-adapter": { kind: "extension", entry: path.join(dir, "index.ts") } },
		}),
	);
	await writeFile(
		path.join(fixture.agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { github: {}, linear: {} } }),
	);
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: {
				review: { skills: ["review"], extensions: ["mcp-adapter"], mcp: ["github"] },
				impl: { skills: ["impl"], extensions: ["mcp-adapter"], mcp: ["linear"] },
			},
		}),
	);
});

afterEach(async () => {
	await driver?.close();
	await rm(fixture.root, { recursive: true, force: true });
});

async function start(profile: string): Promise<void> {
	driver = new RpcDriver("node", [BIN, profile, "--", "--mode", "rpc"], {
		cwd: fixture.cwd,
		env: { ...process.env, HOME: fixture.root, PI_CODING_AGENT_DIR: fixture.agentDir, PI_OFFLINE: "1" },
	});
	await driver.send({ type: "get_state" });
}

async function publishedAllowlists(): Promise<Array<{ profile: string; servers: string[] }>> {
	const lines = (await readFile(allowlistMarker, "utf8")).trim().split("\n");
	return lines.map((line) => JSON.parse(line) as { profile: string; servers: string[] });
}

/** Polls the marker file until a matching allowlist appears (reloads are
 *  asynchronous from the test's side). */
async function untilAllowlist(predicate: (entry: { profile: string; servers: string[] }, index: number) => boolean): Promise<void> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		try {
			const all = await publishedAllowlists();
			if (all.some(predicate)) return;
		} catch {
			// marker not written yet
		}
		if (Date.now() > deadline) throw new Error("allowlist never reached the expected state");
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

describe("/mcp enable|disable against a real spawned pi", () => {
	it("enable/disable edit the owning catalog and the republished allowlist follows reloads", async () => {
		const mcpJsonBefore = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		await start("review");
		expect((await publishedAllowlists()).at(-1)?.servers).toEqual(["github"]);

		await driver.send({ type: "prompt", message: "/mcp enable linear" }, 60_000);
		await untilAllowlist((entry) => entry.profile === "review" && entry.servers.join() === "github,linear");

		// Catalog updated; other profiles untouched.
		const profiles = JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8"));
		expect(profiles.profiles.review.mcp).toEqual(["github", "linear"]);
		expect(profiles.profiles.impl.mcp).toEqual(["linear"]);

		await driver.send({ type: "prompt", message: "/mcp disable github" }, 60_000);
		await untilAllowlist((entry) => entry.profile === "review" && entry.servers.join() === "linear");

		// Switching profiles restores each profile's own MCP selection — the
		// latest publish after the switch names impl with its own array.
		await driver.send({ type: "prompt", message: "/profile use impl" }, 60_000);
		await untilAllowlist((entry, index) => index >= 3 && entry.profile === "impl" && entry.servers.join() === "linear");

		// The adapter's own configuration was never modified.
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(mcpJsonBefore);
	}, 120_000);
});
