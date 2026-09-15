import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piProfileExtension from "../extensions/pi-profile/index.ts";
import { MCP_ALLOWLIST_EVENT } from "../src/mcp-coordination.ts";
import { fakeEventBus, installFakeAdapter, type FakeEventBus } from "./helpers/fake-event-bus.ts";

let root: string;
let savedAgentDir: string | undefined;
let savedSwitchDir: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-ext-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedSwitchDir = process.env.PI_PROFILE_SWITCH_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_PROFILE_SWITCH_DIR = root;
});

afterEach(async () => {
	process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
	await rm(root, { recursive: true, force: true });
});

interface FakePi {
	handlers: Map<string, Array<(...args: never[]) => unknown>>;
	commands: Map<string, { description: string; handler: (...args: never[]) => unknown }>;
	events: FakeEventBus;
	activeTools: string[];
	sentMessages: Array<{ customType: string; content: unknown; display?: boolean }>;
	on(event: string, handler: (...args: never[]) => unknown): void;
	registerCommand(name: string, def: { description: string; handler: (...args: never[]) => unknown }): void;
	getAllTools(): Array<{ name: string }>;
	setActiveTools(names: string[]): void;
	getCommands(): Array<{ name: string; sourceInfo?: { path: string } }>;
	sendMessage(message: { customType: string; content: unknown; display?: boolean }): void;
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
		sentMessages: [],
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
		getCommands: () => [],
		sendMessage(message) {
			pi.sentMessages.push(message);
		},
		modelRegistry: { find: () => undefined },
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	return pi;
}

function fakeCtx(options?: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	selectAnswer?: string;
	selectAnswers?: string[];
	inputAnswers?: Array<string | undefined>;
	confirmAnswers?: boolean[];
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputAnswers = [...(options?.inputAnswers ?? [])];
	const confirmAnswers = [...(options?.confirmAnswers ?? [])];
	const selectAnswers = [...(options?.selectAnswers ?? [])];
	// Mirror real Pi: reload re-executes extensions, invalidating this
	// context — property access afterwards throws (the switch's staleness
	// probe reads ctx.cwd).
	let stale = false;
	return {
		notifications,
		selectCalls,
		get cwd() {
			if (stale) throw new Error("context invalidated by reload");
			return root;
		},
		hasUI: options?.hasUI ?? false,
		mode: options?.mode ?? "tui",
		isIdle: () => true,
		waitForIdle: async () => {},
		reload: async () => {
			stale = true;
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			select: async (title: string, selectOptions: string[]) => {
				selectCalls.push({ title, options: selectOptions });
				return selectAnswers.length > 0 ? selectAnswers.shift() : options?.selectAnswer;
			},
			input: async () => inputAnswers.shift(),
			confirm: async () => confirmAnswers.shift() ?? true,
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

	it("does not duplicate declared instructions if already present in the system prompt (from APPEND_SYSTEM.md)", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", instructions: "Be picky." });
		const pi = fakePi();
		piProfileExtension(pi as never);

		expect(await runBeforeAgentStart(pi, "BASE PROMPT\n\nBe picky.")).toBe("BASE PROMPT\n\nBe picky.");
	});

	it("sets the footer status badge on session start and profile switch", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		const pi = fakePi();
		piProfileExtension(pi as never);

		const statuses: Record<string, string> = {};
		const ctx = fakeCtx();
		(ctx.ui as any).setStatus = (k: string, v: string) => {
			statuses[k] = v;
		};

		const handler = pi.handlers.get("session_start")?.[0];
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect(statuses.profile).toBe("profile: review");
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

	describe("observability surface (ticket 07)", () => {
		it("/profile list sends the trust-gated profile listing as a displayed message", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: { label: "Code review" } } }),
			);
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("list" as never, fakeCtx() as never);

			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]?.customType).toBe("pi-profile");
			expect(String(pi.sentMessages[0]?.content)).toContain("review [global] — Code review");
		});

		it("/profile status sends the resolved plan report", async () => {
			await writeLaunchPlan({
				profile: "review",
				source: "global",
				agentDir: root,
				resolved: { skills: [{ name: "code-review", filePath: "/x/SKILL.md" }], extensions: [] },
				mcp: ["github"],
			});
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("status" as never, fakeCtx() as never);

			const content = String(pi.sentMessages[0]?.content);
			expect(content).toContain("profile: review (global)");
			expect(content).toContain("code-review → /x/SKILL.md");
			expect(content).toContain("mcp: enabled=[github]");
		});

		it("bare /profile falls back to the list without dialog-capable UI", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("" as never, fakeCtx() as never);

			expect(pi.sentMessages).toHaveLength(1);
			expect(String(pi.sentMessages[0]?.content)).toContain("default [builtin]");
		});

		it("bare /profile with UI offers every visible profile and cancels cleanly", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: {} } }),
			);
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, selectAnswer: undefined });

			await pi.commands.get("profile")?.handler("" as never, ctx as never);

			expect(ctx.selectCalls[0]?.options).toContain("default [builtin]");
			expect(ctx.selectCalls[0]?.options).toContain("review [global]");
			// Cancelled: no message, no error notification.
			expect(pi.sentMessages).toHaveLength(0);
			expect(ctx.notifications).toHaveLength(0);
		});
	});

	describe("profile CRUD (ticket 09)", () => {
		it("/profile create runs the wizard and writes the chosen scope", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({
				hasUI: true,
				selectAnswers: ["global"],
				inputAnswers: ["review", "Code review", "", "review, debug-*", "", "", "", "Be terse.", ""],
			});

			await pi.commands.get("profile")?.handler("create" as never, ctx as never);

			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles.review).toEqual({
				label: "Code review",
				skills: ["review", "debug-*"],
				instructions: "Be terse.",
			});
			expect(ctx.notifications.some((entry) => entry.message.includes("created profile"))).toBe(true);
		});

		it("editing the ACTIVE profile saves and reloads; editing an inactive one does not", async () => {
			await writeLaunchPlan({ profile: "review", source: "global", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: { label: "old" }, other: {} } }),
			);
			const pi = fakePi();
			piProfileExtension(pi as never);

			// Active: answers keep everything except a new label.
			const ctxActive = fakeCtx({ hasUI: true, inputAnswers: ["new label", "", "", "", "", "", "", ""] });
			await pi.commands.get("profile")?.handler("edit review" as never, ctxActive as never);
			expect(ctxActive.notifications.some((entry) => entry.message.includes("reloading"))).toBe(true);
			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles.review).toEqual({ label: "new label" });

			// Inactive: saved, runtime untouched (no reload notification).
			const ctxInactive = fakeCtx({ hasUI: true, inputAnswers: ["", "desc", "", "", "", "", "", ""] });
			await pi.commands.get("profile")?.handler("edit other" as never, ctxInactive as never);
			expect(ctxInactive.notifications.some((entry) => entry.message.includes("inactive"))).toBe(true);
			expect(catalog && JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8")).profiles.other).toEqual({
				description: "desc",
			});
		});

		it("deleting the active profile requires a replacement, then switches", async () => {
			await writeLaunchPlan({ profile: "review", source: "global", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: {}, impl: {} } }),
			);
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, selectAnswers: ["impl [global]"] });

			await pi.commands.get("profile")?.handler("delete review" as never, ctx as never);

			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles.review).toBeUndefined();
			// Switched: the rewritten plan file names the replacement.
			const planFile = JSON.parse(await readFile(path.join(root, "pi-profile.json"), "utf8"));
			expect(planFile.profile).toBe("impl");
		});

		it("/profile duplicate copies the full definition under a new name", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({
					schemaVersion: 1,
					profiles: { review: { label: "Code review", skills: ["r*"], instructions: "Be terse." } },
				}),
			);
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, selectAnswers: ["review [global] — Code review"], inputAnswers: ["review-strict"] });

			await pi.commands.get("profile")?.handler("duplicate" as never, ctx as never);

			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles["review-strict"]).toEqual(catalog.profiles.review);
		});

		it("create/edit/delete/duplicate are TUI-only, with a mode-aware message", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			const pi = fakePi();
			piProfileExtension(pi as never);
			for (const args of ["create", "edit x", "delete x", "duplicate"]) {
				const ctx = fakeCtx({ mode: "rpc" });
				await pi.commands.get("profile")?.handler(args as never, ctx as never);
				expect(
					ctx.notifications.some(
						(entry) => entry.level === "error" && entry.message.includes("TUI mode") && entry.message.includes("rpc"),
					),
				).toBe(true);
			}
		});
	});

	describe("/mcp enable|disable (ticket 10)", () => {
		const seedMcp = async () => {
			await writeLaunchPlan({ profile: "review", source: "global", agentDir: root });
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: { mcp: ["github"] } } }),
			);
			await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { github: {}, linear: {} } }));
		};

		it("enable edits the owning catalog and reloads", async () => {
			await seedMcp();
			const pi = fakePi();
			installFakeAdapter(pi.events as FakeEventBus);
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			await pi.commands.get("mcp")?.handler("enable linear" as never, ctx as never);

			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles.review.mcp).toEqual(["github", "linear"]);
			expect(ctx.notifications.some((entry) => entry.message.includes("enabled MCP server"))).toBe(true);
			// Adapter config untouched.
			expect(JSON.parse(await readFile(path.join(root, "mcp.json"), "utf8"))).toEqual({
				mcpServers: { github: {}, linear: {} },
			});
		});

		it("enable fails fast on undiscovered names; disable cleans stale ones", async () => {
			await seedMcp();
			const pi = fakePi();
			installFakeAdapter(pi.events as FakeEventBus);
			piProfileExtension(pi as never);

			const ctx = fakeCtx();
			await pi.commands.get("mcp")?.handler("enable ghost" as never, ctx as never);
			expect(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("unknown MCP server"))).toBe(
				true,
			);

			// Stale: in the profile but not in mcp.json.
			await writeFile(
				path.join(root, "profiles.json"),
				JSON.stringify({ schemaVersion: 1, profiles: { review: { mcp: ["github", "stale"] } } }),
			);
			await pi.commands.get("mcp")?.handler("disable stale" as never, fakeCtx() as never);
			const catalog = JSON.parse(await readFile(path.join(root, "profiles.json"), "utf8"));
			expect(catalog.profiles.review.mcp).toEqual(["github"]);
		});

		it("fails clearly when the adapter is absent or the profile is default", async () => {
			await seedMcp();
			const pi = fakePi(); // no adapter installed
			piProfileExtension(pi as never);
			const ctx = fakeCtx();
			await pi.commands.get("mcp")?.handler("disable github" as never, ctx as never);
			expect(
				ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("pi-mcp-adapter is not active")),
			).toBe(true);

			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			const pi2 = fakePi();
			installFakeAdapter(pi2.events as FakeEventBus);
			piProfileExtension(pi2 as never);
			const ctx2 = fakeCtx();
			await pi2.commands.get("mcp")?.handler("disable github" as never, ctx2 as never);
			expect(ctx2.notifications.some((entry) => entry.message.includes("no catalog entry"))).toBe(true);
		});
	});

	it("/profile resource is rejected as an unknown subcommand", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx();
		await pi.commands.get("profile")?.handler("resource list" as never, ctx as never);
		expect(
			ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("usage: /profile")),
		).toBe(true);
	});
});
