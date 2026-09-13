import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MCP_GENERATED_MARKER, mcpSlotPath, mcpSourcePath } from "../src/mcp-overlay.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

/**
 * End-to-end check of the profile-scoped MCP overlay with a FAKE adapter
 * probe that reads the adapter's default Pi-global slot (`<agentDir>/mcp.json`)
 * on every session start — the same file the real adapter loads when no
 * `--mcp-config` is given. This proves the wiring without depending on the
 * real adapter package: the overlay is generated before the adapter's first
 * read, a profile switch rewrites it and rebuilds the runtime, and no adapter
 * means no side effects.
 */

const EXTENSION = path.resolve("extensions/pi-profile-switch/index.ts");
const PROBE_LOG = "probe.jsonl";

/** The real adapter, when this machine has it installed: the strongest check
 *  (its own status event reports the disabled set). Opt-in by availability so
 *  the suite never depends on a developer's global install. */
function realAdapterPath(): string | undefined {
	const candidates = [
		process.env.PI_MCP_ADAPTER_PATH,
		path.join(getAgentDir(), "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
		path.join(process.cwd(), "node_modules", "pi-mcp-adapter", "index.ts"),
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
	return candidates.find((candidate) => existsSync(candidate));
}

const REAL_ADAPTER = realAdapterPath();

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await symlink(path.resolve("node_modules"), path.join(fixture.root, "node_modules"), "dir");
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function probePath(): string {
	return path.join(fixture.root, PROBE_LOG);
}

/** Mimics the adapter's default config read: the Pi-global slot file. */
async function writeAdapterProbe(): Promise<string> {
	const file = path.join(fixture.root, "adapter-probe.ts");
	await writeFile(
		file,
		`import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

function record(entry: Record<string, unknown>): void {
	appendFileSync(${JSON.stringify(probePath())}, JSON.stringify(entry) + "\\n");
}

export default function probe(pi: ExtensionAPI): void {
	// Answer the adapter's presence probe (bogus name → ok:false), exactly like
	// the real adapter does.
	pi.events.on("pi-mcp-adapter:runtime-snapshot:v1", (request: unknown) => {
		(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };
	});
	function snapshot(): void {
		let servers: unknown = null;
		try {
			servers = JSON.parse(readFileSync(path.join(getAgentDir(), "mcp.json"), "utf8")).mcpServers ?? null;
		} catch {
			servers = null;
		}
		record({ event: "config", servers });
	}
	pi.on("session_start", async () => snapshot());
	pi.on("before_agent_start", async () => snapshot());
}
`,
	);
	return file;
}

async function readProbe(): Promise<Array<Record<string, unknown>>> {
	try {
		const raw = await readFile(probePath(), "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function waitForSnapshots(count: number, timeoutMs = 30_000): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshots = (await readProbe()).filter((entry) => entry.event === "config");
		if (snapshots.length >= count) return snapshots;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${count} snapshots`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
		OPENAI_API_KEY: "sk-test-not-used",
	};
	delete env.PI_CODING_AGENT_SESSION_DIR;
	return env;
}

async function writeSettings(packages: string[]): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages }));
}

async function writeCatalog(): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({
			schemaVersion: 1,
			profiles: {
				review: { mcps: ["alpha"], tools: ["read"] },
				implement: { mcps: ["beta"], tools: ["read"] },
			},
		}),
	);
}

async function writeState(activeProfile: string): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile }));
}

const marker = { [MCP_GENERATED_MARKER]: { generated: true, version: 1 } };

describe("profile-scoped MCP overlay", () => {
	it(
		"replaces the adapter's Pi-global slot and adopts the hand-written file into the sidecar",
		{ timeout: 90_000 },
		async () => {
			await writeSettings(["npm:pi-mcp-adapter"]);
			await writeCatalog();
			await writeState("review");
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { alpha: { url: "https://alpha" }, beta: { url: "https://beta" } } }),
			);
			const probe = await writeAdapterProbe();
			const rpc = new RpcDriver("pi", ["-e", EXTENSION, "-e", probe, "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: childEnv(),
			});
			try {
				const snapshot = (await waitForSnapshots(1))[0];

				expect(snapshot?.servers).toEqual({
					alpha: { url: "https://alpha" },
					beta: { url: "https://beta", disabled: true },
				});
				const slot = JSON.parse(await readFile(mcpSlotPath(fixture.agentDir), "utf8")) as Record<string, unknown>;
				expect(slot).toMatchObject(marker);
				const sidecar = JSON.parse(await readFile(mcpSourcePath(fixture.agentDir), "utf8")) as Record<string, unknown>;
				expect(sidecar).toEqual({
					mcpServers: { alpha: { url: "https://alpha" }, beta: { url: "https://beta" } },
				});
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"rewrites the overlay on /profile use and rebuilds the runtime",
		{ timeout: 90_000 },
		async () => {
			await writeSettings(["npm:pi-mcp-adapter"]);
			await writeCatalog();
			await writeState("review");
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { alpha: { url: "https://alpha" }, beta: { url: "https://beta" } } }),
			);
			const probe = await writeAdapterProbe();
			const rpc = new RpcDriver("pi", ["-e", EXTENSION, "-e", probe, "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: childEnv(),
			});
			try {
				await waitForSnapshots(1);
				const before = await rpc.send({ type: "get_state" });

				await rpc.send({ type: "prompt", message: "/profile use implement" });
				await rpc.waitFor(
					(entry) =>
						(entry as { method?: string }).method === "notify" &&
						String((entry as { message?: string }).message).includes("reloading runtime"),
				);
				const snapshots = await waitForSnapshots(2);

				expect(snapshots[1]?.servers).toEqual({
					alpha: { url: "https://alpha", disabled: true },
					beta: { url: "https://beta" },
				});
				const after = await rpc.send({ type: "get_state" });
				expect(after.data?.sessionId).toBe(before.data?.sessionId);
				expect(after.data?.sessionFile).toBe(before.data?.sessionFile);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"does nothing when pi-mcp-adapter is not installed",
		{ timeout: 90_000 },
		async () => {
			await writeSettings(["npm:context-mode"]);
			await writeCatalog();
			await writeState("review");
			const probe = await writeAdapterProbe();
			const rpc = new RpcDriver("pi", ["-e", EXTENSION, "-e", probe, "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: childEnv(),
			});
			try {
				await rpc.send({ type: "prompt", message: "hello" });
				const snapshot = (await waitForSnapshots(1))[0];

				expect(snapshot?.servers).toBeNull();
				await expect(readFile(mcpSlotPath(fixture.agentDir), "utf8")).rejects.toThrow();
				await expect(readFile(mcpSourcePath(fixture.agentDir), "utf8")).rejects.toThrow();
			} finally {
				await rpc.close();
			}
		},
	);
});

describe.skipIf(REAL_ADAPTER === undefined)("profile-scoped MCP overlay (real pi-mcp-adapter)", () => {
	it(
		"reports the disallowed server as disabled through the adapter's own status event",
		{ timeout: 120_000 },
		async () => {
			const statusLog = path.join(fixture.root, "adapter-status.jsonl");
			await writeSettings(["npm:pi-mcp-adapter"]);
			await writeCatalog();
			await writeState("review");
			await writeFile(
				path.join(fixture.agentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						alpha: { type: "http", url: "http://127.0.0.1:9/mcp" },
						beta: { type: "http", url: "http://127.0.0.1:9/mcp" },
					},
				}),
			);
			const probe = path.join(fixture.root, "status-probe.ts");
			await writeFile(
				probe,
				`import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
export default function probe(pi: ExtensionAPI): void {
	pi.events.on("pi-mcp-adapter/status/v1", (snapshot: unknown) => {
		const servers = (snapshot as { servers?: Array<{ name: string; disabled: boolean }> }).servers ?? [];
		appendFileSync(${JSON.stringify(statusLog)}, JSON.stringify({
			servers: servers.map((server) => ({ name: server.name, disabled: server.disabled })),
		}) + "\\n");
	});
}
`,
			);
			const rpc = new RpcDriver(
				"pi",
				["-e", EXTENSION, "-e", REAL_ADAPTER as string, "-e", probe, "--mode", "rpc"],
				{ cwd: fixture.cwd, env: childEnv() },
			);
			try {
				const deadline = Date.now() + 60_000;
				let complete: Array<{ name: string; disabled: boolean }> | undefined;
				for (;;) {
					try {
						const raw = await readFile(statusLog, "utf8");
						const snapshots = raw
							.split("\n")
							.filter((line) => line.trim().length > 0)
							.map((line) => JSON.parse(line) as { servers: Array<{ name: string; disabled: boolean }> });
						// The adapter emits partial snapshots while it connects; wait
						// for the one that has reconciled both servers.
						complete = snapshots.map((snapshot) => snapshot.servers).find((entries) => entries.length >= 2);
					} catch {
						complete = undefined;
					}
					if (complete !== undefined || Date.now() > deadline) break;
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				const servers = complete ?? [];

				expect(servers, rpc.stderr.join("\n")).toEqual([
					{ name: "alpha", disabled: false },
					{ name: "beta", disabled: true },
				]);
			} finally {
				await rpc.close();
			}
		},
	);
});
