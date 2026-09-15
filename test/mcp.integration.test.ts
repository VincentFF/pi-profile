import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
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

async function writeMcpConfig(servers: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

/** A fake pi-mcp-adapter: lives in a dir named like the real package (so the
 *  launcher's presence check matches), answers snapshot probes, and records
 *  any published allowlist to a marker file. */
async function installFakeAdapter(): Promise<string> {
	const marker = path.join(fixture.root, "ALLOWLIST.json");
	const extFile = path.join(fixture.agentDir, "extensions", "pi-mcp-adapter.ts");
	await mkdir(path.dirname(extFile), { recursive: true });
	await writeFile(
		extFile,
		[
			`import { writeFileSync } from "node:fs";`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.events.on("pi-mcp-adapter:runtime-snapshot:v1", (request: unknown) => {`,
			`\t\t(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };`,
			`\t});`,
			`\tpi.events.on("pi-profile:mcp-allowlist:v1", (data: unknown) => {`,
			`\t\twriteFileSync(${JSON.stringify(marker)}, JSON.stringify(data));`,
			`\t});`,
			`}`,
			"",
		].join("\n"),
	);
	return marker;
}

function runLauncher(args: string[]): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			"node",
			[BIN, ...args],
			{ cwd: fixture.cwd, env: launcherEnv() },
			(error, _stdout, stderr) => resolve({ code: (error as { code?: number })?.code ?? 0, stderr }),
		);
		child.stdin?.end();
	});
}

describe("launcher integration: mcp coordination", () => {
	it(
		"a profile declaring mcp fails before spawn when the adapter is absent",
		{ timeout: 30_000 },
		async () => {
			await writeMcpConfig({ github: { url: "https://x" } });
			await writeCatalog({ review: { mcp: ["github"] } });

			const failure = await runLauncher(["review", "--", "--mode", "rpc"]);
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain("pi-mcp-adapter is not active");
		},
	);

	it(
		"an mcp reference the adapter never discovered fails before spawn",
		{ timeout: 30_000 },
		async () => {
			await installFakeAdapter();
			await writeMcpConfig({ github: {} });
			await writeCatalog({ review: { extensions: ["pi-mcp-adapter"], mcp: ["typo-server"] } });

			const failure = await runLauncher(["review", "--", "--mode", "rpc"]);
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain('unknown MCP server: "typo-server"');
		},
	);

	it(
		"publishes the runtime allowlist in memory and never writes the adapter's mcp.json overlay",
		{ timeout: 45_000 },
		async () => {
			const marker = await installFakeAdapter();
			const globalConfig = { github: { url: "https://x" }, linear: { command: "mcp-linear" } };
			await writeMcpConfig(globalConfig);
			await writeCatalog({ review: { extensions: ["pi-mcp-adapter"], mcp: ["github"] } });

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}

			// The adapter received the profile's allowlist at session start.
			expect(existsSync(marker)).toBe(true);
			expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
				version: 1,
				profile: "review",
				servers: ["github"],
			});

			// The adapter's own files were never written: the global config is
			// byte-identical and no project overlay appeared.
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8"))).toEqual({
				mcpServers: globalConfig,
			});
			expect(existsSync(path.join(fixture.cwd, ".pi", "mcp.json"))).toBe(false);
		},
	);

	it(
		"a profile without mcp publishes no coordination even when the adapter is active",
		{ timeout: 45_000 },
		async () => {
			const marker = await installFakeAdapter();
			await writeMcpConfig({ github: {} });
			await writeCatalog({ plain: { extensions: ["pi-mcp-adapter"] } });

			const rpc = new RpcDriver("node", [BIN, "plain", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const response = await rpc.send({ type: "get_state" });
				expect(response.success).toBe(true);
			} finally {
				await rpc.close();
			}
			expect(existsSync(marker)).toBe(false);
		},
	);
});
