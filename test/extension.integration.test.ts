import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

/**
 * Integration tests against a real `pi --mode rpc` process with the
 * extension loaded natively (no launcher). The fixture agent dir stands in
 * for ~/.pi/agent; the test sets PI_CODING_AGENT_DIR for the child so no
 * test touches the developer's real configuration.
 *
 * Probe extensions write JSON lines to a file instead of using
 * `pi.sendMessage`: RPC mode does not replay custom messages sent during
 * `session_start`.
 */

const EXTENSION = path.resolve("extensions/pi-profile-switch/index.ts");
const PROBE_LOG = "probe.jsonl";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	// Probe extensions import the Pi package like a real installed extension.
	await symlink(path.resolve("node_modules"), path.join(fixture.root, "node_modules"), "dir");
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { atlassian: {} } }));
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function probePath(): string {
	return path.join(fixture.root, PROBE_LOG);
}

async function writeProbe(name: string, body: string): Promise<string> {
	const file = path.join(fixture.root, `${name}.ts`);
	await writeFile(
		file,
		`import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

function record(entry: Record<string, unknown>): void {
	appendFileSync(${JSON.stringify(probePath())}, JSON.stringify(entry) + "\\n");
}
appendFileSync(${JSON.stringify(probePath())}, JSON.stringify({ event: "load" }) + "\\n");

export default function probe(pi: ExtensionAPI): void {
${body}
}
`,
	);
	return file;
}

function observeProbeBody(): string {
	return `
	pi.on("session_start", async (_event, ctx) => {
		let config: string | undefined;
		try {
			config = readFileSync(path.join(getAgentDir(), "probe-config.json"), "utf8");
		} catch {
			config = undefined;
		}
		record({
			event: "session",
			agentDir: getAgentDir(),
			sessionDirEnv: process.env.PI_CODING_AGENT_SESSION_DIR ?? null,
			systemPrompt: ctx.getSystemPrompt(),
			config,
		});
	});
	pi.on("before_agent_start", async (event) => {
		record({ event: "prompt", systemPrompt: event.systemPrompt, activeTools: pi.getActiveTools() });
	});
`;
}

function adapterProbeBody(): string {
	return `
	pi.events.on("pi-mcp-adapter:runtime-snapshot:v1", (request: unknown) => {
		(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };
	});
	pi.events.on("pi-profile:mcp-allowlist:v1", (message: unknown) => {
		record({ event: "allowlist", message });
	});
`;
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

async function waitForProbe(
	predicate: (entry: Record<string, unknown>) => boolean,
	timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = (await readProbe()).find(predicate);
		if (hit !== undefined) return hit;
		if (Date.now() > deadline) throw new Error("timeout waiting for probe entry");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The RPC child must not inherit a launcher's session-dir override from the
 *  developer's environment; the test simulates a native shell. */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
		// Syntactically valid, unusable: a turn must start (so
		// before_agent_start fires) even though the model call cannot succeed.
		OPENAI_API_KEY: "sk-test-not-used",
	};
	delete env.PI_CODING_AGENT_SESSION_DIR;
	return env;
}

async function start(extraArgs: string[] = [], options: { model?: boolean } = {}): Promise<RpcDriver> {
	const modelArgs = options.model === false ? [] : ["--model", "openai/gpt-4o-mini"];
	return new RpcDriver("pi", [...extraArgs, ...modelArgs, "--mode", "rpc"], { cwd: fixture.cwd, env: childEnv() });
}

async function waitForNotify(rpc: RpcDriver, includes: string): Promise<void> {
	await rpc.waitFor(
		(entry) =>
			(entry as { type?: string }).type === "extension_ui_request" &&
			(entry as { method?: string }).method === "notify" &&
			String((entry as { message?: string }).message).includes(includes),
	);
}

async function waitForCustomMessage(rpc: RpcDriver, customType: string): Promise<string> {
	await rpc.waitFor(
		(entry) =>
			(entry as { type?: string }).type === "message_end" &&
			(entry as { message?: { customType?: string } }).message?.customType === customType,
	);
	const response = await rpc.send({ type: "get_messages" });
	const messages = (response.data?.messages ?? []) as Array<{ customType?: string; content?: unknown }>;
	const match = messages.filter((message) => message.customType === customType).at(-1);
	return typeof match?.content === "string" ? match.content : "";
}

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 2, profiles }));
}

async function writeState(activeProfile: string): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile }));
}

describe("native Pi behavior with the extension loaded", () => {
	it(
		"keeps the agent dir and session layout native, and reads third-party config and context files",
		{ timeout: 90_000 },
		async () => {
			await writeFile(path.join(fixture.agentDir, "AGENTS.md"), "GLOBAL-CONTEXT-MARKER\n");
			await writeFile(path.join(fixture.agentDir, "probe-config.json"), '{"shortcut":"alt+m"}');
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe], { model: false });
			try {
				const session = await waitForProbe((entry) => entry.event === "session");

				// The agent dir is Pi's own — the extension never moves it.
				expect(session.agentDir).toBe(fixture.agentDir);
				// The extension sets no session-dir override.
				expect(session.sessionDirEnv).toBeNull();
				// Third-party extension configuration in the agent dir is readable.
				expect(session.config).toBe('{"shortcut":"alt+m"}');
				// The global context file reaches the system prompt.
				expect(String(session.systemPrompt)).toContain("GLOBAL-CONTEXT-MARKER");

				// Sessions land in Pi's per-project directory under the agent dir.
				const state = await rpc.send({ type: "get_state" });
				const sessionFile = state.data?.sessionFile as string | undefined;
				const encoded = `--${fixture.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
				expect(sessionFile).toBeDefined();
				expect(sessionFile).toContain(path.join(fixture.agentDir, "sessions", encoded));
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"shows only the profile's skills to the model while every skill stays user-invocable",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			await writeState("review");
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe]);
			try {
				await waitForProbe((entry) => entry.event === "session");

				// Every loaded skill keeps its /skill: command (user access).
				const skillCommands = await rpc.skillCommandNames();
				expect(skillCommands).toEqual(["skill:alpha-skill", "skill:beta-skill"]);

				// The prompt the chain produces carries only the selected skill.
				await rpc.send({ type: "prompt", message: "hello" });
				const prompt = await waitForProbe((entry) => entry.event === "prompt");
				expect(String(prompt.systemPrompt)).toContain("alpha-skill");
				expect(String(prompt.systemPrompt)).not.toContain("beta-skill");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"switches profiles in place: same session, no reload, next turn reflects the new skills",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				review: { skills: ["alpha-skill"], tools: ["read"] },
				implement: { skills: ["beta-skill"], tools: ["read", "grep"] },
			});
			await writeState("review");
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe]);
			try {
				await waitForProbe((entry) => entry.event === "session");
				const before = await rpc.send({ type: "get_state" });

				await rpc.send({ type: "prompt", message: "/profile use implement" });
				await waitForNotify(rpc, "profile active: implement");

				const after = await rpc.send({ type: "get_state" });
				expect(after.data?.sessionId).toBe(before.data?.sessionId);
				expect(after.data?.sessionFile).toBe(before.data?.sessionFile);

				// No reload: the probe module was evaluated exactly once.
				const loads = (await readProbe()).filter((entry) => entry.event === "load");
				expect(loads).toHaveLength(1);

				// The next turn's prompt reflects the new selection.
				await rpc.send({ type: "prompt", message: "hello" });
				const prompts = await waitForProbe((entry) => entry.event === "prompt");
				expect(String(prompts.systemPrompt)).toContain("beta-skill");
				expect(String(prompts.systemPrompt)).not.toContain("alpha-skill");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"reports the active selection through /profile status without any model call",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"], mcp: ["atlassian"] } });
			await writeState("review");
			const adapter = await writeProbe("adapter-probe", adapterProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", adapter], { model: false });
			try {
				await rpc.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(rpc, "pi-profile-switch");

				expect(status).toContain("### profile: review (global)");
				expect(status).toContain("skills: 1 of 2 loaded");
				expect(status).toContain("alpha-skill");
				expect(status).not.toContain("beta-skill");
				expect(status).toContain("mcp: enabled=[atlassian]");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"publishes the MCP allowlist to an installed adapter",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: { mcp: ["atlassian"] } });
			await writeState("review");
			const adapter = await writeProbe("adapter-probe", adapterProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", adapter], { model: false });
			try {
				const allowlist = await waitForProbe((entry) => entry.event === "allowlist");

				expect(allowlist.message).toEqual({
					version: 1,
					profile: "review",
					servers: ["atlassian"],
				});
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"fails a profile whose MCP intent cannot be satisfied, without applying anything",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: { tools: ["read"], mcp: ["ghost"] } });
			await writeState("review");
			const adapter = await writeProbe("adapter-probe", adapterProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", adapter], { model: false });
			try {
				await waitForNotify(rpc, 'unknown MCP server "ghost"');
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"rejects an unknown --profile flag value with the candidate list",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: { skills: [] } });
			await writeState("default");
			const rpc = await start(["-e", EXTENSION, "--profile", "ghost"], { model: false });
			try {
				await waitForNotify(rpc, 'unknown profile "ghost"');
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"lets an explicit --tools declaration own the active set",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: { tools: ["grep"] } });
			await writeState("review");
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe, "--tools", "read"]);
			try {
				await waitForProbe((entry) => entry.event === "session");
				await rpc.send({ type: "prompt", message: "hello" });
				const prompt = await waitForProbe((entry) => entry.event === "prompt");

				// The profile declares grep; the CLI declaration keeps read only.
				expect(prompt.activeTools).toEqual(["read"]);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"activates the profile chosen from the bare /profile picker",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({
				review: { skills: ["alpha-skill"] },
				implement: { skills: ["beta-skill"] },
			});
			await writeState("review");
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe], { model: false });
			try {
				await waitForProbe((entry) => entry.event === "session");
				rpc.answerDialogs([{ value: "implement [global]" }]);

				await rpc.send({ type: "prompt", message: "/profile" });
				await waitForNotify(rpc, "profile active: implement");

				await rpc.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(rpc, "pi-profile-switch");
				expect(status).toContain("### profile: implement (global)");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"warns about a version 1 catalog with ignored extensions",
		{ timeout: 90_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: { extensions: ["pi-plan-build"] } } }),
			);
			await writeState("review");
			const rpc = await start(["-e", EXTENSION], { model: false });
			try {
				await waitForNotify(rpc, "schemaVersion 1 is read as version 2");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"publishes the active profile to Pi's footer status channel",
		{ timeout: 90_000 },
		async () => {
			await writeCatalog({ review: {} });
			await writeState("review");
			const rpc = await start(["-e", EXTENSION], { model: false });
			try {
				await rpc.waitFor(
					(entry) =>
						(entry as { type?: string }).type === "extension_ui_request" &&
						(entry as { method?: string }).method === "setStatus" &&
						(entry as { statusKey?: string }).statusKey === "profile",
				);
				const badge = rpc.messages
					.filter((entry) => (entry as { method?: string }).method === "setStatus")
					.at(-1) as { statusText?: string } | undefined;

				// RPC forwards the rendered string verbatim, colors included; strip
				// the theme's escape sequences to assert the canonical text.
				const text = String(badge?.statusText).replace(/\x1b\[[0-9;]*m/g, "");
				expect(text).toBe("profile: review");
			} finally {
				await rpc.close();
			}
		},
	);
});
