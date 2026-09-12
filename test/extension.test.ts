import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piProfileExtension from "../extensions/pi-profile/index.ts";
import { MCP_ALLOWLIST_EVENT } from "../src/mcp-coordination.ts";
import { fakeEventBus, installFakeAdapter, type FakeEventBus } from "./helpers/fake-event-bus.ts";

let root: string;
let savedAgentDir: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-ext-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(async () => {
	process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	await rm(root, { recursive: true, force: true });
});

interface FakePi {
	handlers: Map<string, Array<(...args: never[]) => unknown>>;
	commands: Map<string, { description: string; handler: (...args: never[]) => unknown }>;
	events: FakeEventBus;
	activeTools: string[];
	on(event: string, handler: (...args: never[]) => unknown): void;
	registerCommand(name: string, def: { description: string; handler: (...args: never[]) => unknown }): void;
	getAllTools(): Array<{ name: string }>;
	setActiveTools(names: string[]): void;
	modelRegistry: { find(provider: string, id: string): unknown | undefined };
	setModel(model: unknown): Promise<boolean>;
	setThinkingLevel(level: string): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
	const commands = new Map<string, { description: string; handler: (...args: never[]) => unknown }>();
	const pi: FakePi = {
		handlers,
		commands,
		events: fakeEventBus(),
		activeTools: [],
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		getAllTools: () => ["read", "bash"].map((name) => ({ name })),
		setActiveTools(names) {
			pi.activeTools = names;
		},
		modelRegistry: { find: () => undefined },
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	return pi;
}

function fakeCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		cwd: root,
		isIdle: () => true,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};
}

async function writeLaunchPlan(plan: unknown): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "pi-profile.json"), JSON.stringify(plan));
}

async function fireSessionStart(pi: FakePi, reason = "startup"): Promise<void> {
	const handler = pi.handlers.get("session_start")?.[0];
	await handler?.({ reason } as never, fakeCtx() as never);
}

async function runBeforeAgentStart(pi: FakePi, systemPrompt: string): Promise<string | undefined> {
	const handler = pi.handlers.get("before_agent_start")?.[0];
	const result = (await handler?.({ systemPrompt } as never, fakeCtx() as never)) as
		| { systemPrompt?: string }
		| undefined;
	return result?.systemPrompt;
}

describe("pi-profile extension", () => {
	it("appends declared instructions to the built system prompt on every turn", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", instructions: "Be picky." });
		const pi = fakePi();
		piProfileExtension(pi as never);

		expect(await runBeforeAgentStart(pi, "BASE PROMPT")).toBe("BASE PROMPT\n\nBe picky.");
		expect(await runBeforeAgentStart(pi, "BASE PROMPT")).toBe("BASE PROMPT\n\nBe picky.");
	});

	it("injects the switch summary into exactly one turn after a switch", async () => {
		await writeLaunchPlan({ profile: "impl", source: "global", switchedFrom: "review" });
		const pi = fakePi();
		piProfileExtension(pi as never);
		await fireSessionStart(pi, "reload");

		const withSummary = await runBeforeAgentStart(pi, "BASE");
		expect(withSummary).toContain("review → impl");
		// One-shot: the marker was consumed and cleared from the plan file.
		expect(await runBeforeAgentStart(pi, "BASE")).not.toContain("→");
	});

	it("publishes the mcp allowlist at session start when the adapter answers", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", mcp: ["github"] });
		const pi = fakePi();
		installFakeAdapter(pi.events);
		piProfileExtension(pi as never);

		await fireSessionStart(pi);

		const allowlist = pi.events.emitted.find((entry) => entry.channel === MCP_ALLOWLIST_EVENT);
		expect(allowlist?.data).toEqual({ version: 1, profile: "review", servers: ["github"] });
	});

	it("fails loudly at session start when the plan declares mcp but the adapter is absent", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", mcp: ["github"] });
		const pi = fakePi();
		piProfileExtension(pi as never);

		await expect(fireSessionStart(pi)).rejects.toThrow(/pi-mcp-adapter is not active/);
	});

	it("publishes no coordination when the plan declares no mcp", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin" });
		const pi = fakePi();
		piProfileExtension(pi as never);

		await fireSessionStart(pi);

		expect(pi.events.emitted.some((entry) => entry.channel === MCP_ALLOWLIST_EVENT)).toBe(false);
	});

	it("registers the /profile command with use and reload subcommands", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);

		const command = pi.commands.get("profile");
		expect(command).toBeDefined();
		const ctx = fakeCtx();
		await command?.handler("bogus" as never, ctx as never);
		expect(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("usage"))).toBe(
			true,
		);
	});
});
