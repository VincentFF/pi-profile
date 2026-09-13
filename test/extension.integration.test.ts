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

/** Waits until a probe has recorded `count` `session_start` events; a runtime
 *  reload fires one, so this is the deterministic "reload finished" signal. */
async function waitForSessionStarts(count: number, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const starts = (await readProbe()).filter((entry) => entry.event === "session_start").length;
		if (starts >= count) return;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${count} session starts`);
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
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function writeState(activeProfile: string): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile }));
}

describe("saved-selection scope", () => {
	it(
		"keeps the in-session profile across the MCP reload it triggers",
		{ timeout: 90_000 },
		async () => {
			// `implement` disables the one discovered server, so the switch
			// changes the overlay and rebuilds the runtime. The settings entry
			// makes the extension treat the adapter as installed at load time
			// (the same gate the real package passes).
			await writeCatalog({ review: {}, implement: { mcps: [] } });
			await writeFile(
				path.join(fixture.agentDir, "settings.json"),
				JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }),
			);
			const probe = await writeProbe(
				"reload-probe",
				`pi.events.on("pi-mcp-adapter:runtime-snapshot:v1", (request: unknown) => {
	(request as { result: unknown }).result = { ok: false, error: new Error("unknown server") };
});
pi.on("session_start", async () => record({ event: "session_start" }));`,
			);
			// Start with the flag: a reload that re-read it would resurrect
			// `review` and undo the switch.
			const rpc = await start(["-e", EXTENSION, "-e", probe, "--profile", "review"], { model: false });
			try {
				await waitForSessionStarts(1);
				await rpc.send({ type: "prompt", message: "/profile use implement" });
				await waitForNotify(rpc, "reloading runtime");
				await waitForSessionStarts(2);

				await rpc.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(rpc, "pi-profile-switch");

				expect(status).toContain("### profile: implement (global)");
				const badges = rpc.messages.filter(
					(entry) =>
						(entry as { method?: string }).method === "setStatus" &&
						(entry as { statusKey?: string }).statusKey === "active-profile",
				);
				expect(String((badges.at(-1) as { statusText?: string }).statusText)).toContain("implement");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"restores the built-in default from a project profile switch",
		{ timeout: 90_000 },
		async () => {
			// A project profile is saved into the project state; switching to
			// the built-in default must clear it, or the stale project entry
			// shadows the choice on the next startup.
			await writeCatalog({ global: {} });
			await writeFile(
				path.join(fixture.cwd, ".pi", "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { local: { tools: ["read"] } } }),
			);

			const first = await start(["-e", EXTENSION], { model: false });
			try {
				await first.send({ type: "prompt", message: "/profile use local" });
				await waitForNotify(first, "profile active: local");
				await first.send({ type: "prompt", message: "/profile use default" });
				await waitForNotify(first, "profile active: default");
			} finally {
				await first.close();
			}

			const projectState = JSON.parse(
				await readFile(path.join(fixture.cwd, ".pi", "pi-profile-state.json"), "utf8"),
			) as { activeProfile?: string };
			expect(projectState.activeProfile).toBeUndefined();

			const second = await start(["-e", EXTENSION], { model: false });
			try {
				await second.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(second, "pi-profile-switch");
				expect(status).toContain("### profile: default (builtin)");
			} finally {
				await second.close();
			}
		},
	);
});

describe("native Pi behavior with the extension loaded", () => {
	it(
		"seeds the default catalog on the first load and activates the seeded profile on restart",
		{ timeout: 90_000 },
		async () => {
			// Fresh agent dir: no profiles.json yet. `get_commands` answers only
			// after the extension has loaded, so it doubles as the readiness gate.
			const first = await start(["-e", EXTENSION], { model: false });
			try {
				await first.commandNames();
			} finally {
				await first.close();
			}

			const seeded = JSON.parse(await readFile(path.join(fixture.agentDir, "profiles.json"), "utf8")) as {
				profiles: Record<string, unknown>;
			};
			expect(Object.keys(seeded.profiles)).toEqual(["read-only"]);

			// The seeded profile is a real profile: select it, restart, and let
			// Pi's own state store prove it came from the seeded file.
			const second = await start(["-e", EXTENSION], { model: false });
			try {
				await second.send({ type: "prompt", message: "/profile use read-only" });
				await waitForNotify(second, "profile active: read-only");
			} finally {
				await second.close();
			}

			const third = await start(["-e", EXTENSION], { model: false });
			try {
				await third.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(third, "pi-profile-switch");
				expect(status).toContain("### profile: read-only (global)");
			} finally {
				await third.close();
			}
		},
	);

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
		"does not report a loaded skill as unloaded for a startup activation",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			await writeState("review");
			const probe = await writeProbe("probe", observeProbeBody());
			const rpc = await start(["-e", EXTENSION, "-e", probe]);
			try {
				await waitForProbe((entry) => entry.event === "session");
				await rpc.send({ type: "prompt", message: "hello" });
				await waitForProbe((entry) => entry.event === "prompt");
				// A round trip after the turn proves earlier notifications arrived.
				await rpc.send({ type: "prompt", message: "/profile status" });
				await waitForCustomMessage(rpc, "pi-profile-switch");

				const notices = rpc.messages
					.filter((entry) => (entry as { method?: string }).method === "notify")
					.map((entry) => String((entry as { message?: string }).message));
				expect(notices.filter((message) => message.includes("is not loaded in this session"))).toEqual([]);
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"reports a genuinely unknown skill on the first turn",
		{ timeout: 90_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ review: { skills: ["ghost-skill"] } });
			await writeState("review");
			const rpc = await start(["-e", EXTENSION]);
			try {
				await rpc.send({ type: "prompt", message: "hello" });
				await waitForNotify(rpc, 'skill "ghost-skill" is not loaded in this session');
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
			await writeCatalog({ review: { skills: ["alpha-skill"], mcps: ["atlassian"] } });
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
			await writeCatalog({ review: { mcps: ["atlassian"] } });
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
			await writeCatalog({ review: { tools: ["read"], mcps: ["ghost"] } });
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
		"reports a catalog written by v0.1.0 (schemaVersion 2) instead of activating it",
		{ timeout: 90_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "profiles.json"),
				JSON.stringify({ schemaVersion: 2, profiles: { review: {} } }),
			);
			await writeState("review");
			const rpc = await start(["-e", EXTENSION], { model: false });
			try {
				await waitForNotify(rpc, "unsupported schemaVersion");

				// Nothing was activated: the session keeps the plain Pi baseline.
				await rpc.send({ type: "prompt", message: "/profile status" });
				const status = await waitForCustomMessage(rpc, "pi-profile-switch");
				expect(status).toContain("no active profile");
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
						(entry as { statusKey?: string }).statusKey === "active-profile",
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
